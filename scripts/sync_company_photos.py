import os
import re
import sys
import time
import json
import sqlite3
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.stdout.reconfigure(encoding='utf-8')

BASE_URL = 'https://membership.k-coc.org'
LOGIN_URL = f'{BASE_URL}/login'
COMPANIES_URL = f'{BASE_URL}/companies'

EMAIL = "admin@k-coc.org"
PASSWORD = """s.ipwRSYAG!dd'&Ng4v%.+gX0/wP9H'w"""

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT_DIR, 'data', 'cardval.db')
UPLOADS_DIR = os.path.join(ROOT_DIR, 'public', 'uploads')
PROGRESS_FILE = os.path.join(ROOT_DIR, 'data', 'sync_companies_progress.json')
os.makedirs(UPLOADS_DIR, exist_ok=True)

def get_session():
    s = requests.Session()
    s.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    })
    res = s.get(LOGIN_URL, timeout=15)
    token_m = re.search(r'name="_token"\s+value="([^"]+)"', res.text)
    if not token_m:
        raise Exception("تعذر استخراج رمز CSRF للشركات")
    token = token_m.group(1)
    
    post_res = s.post(LOGIN_URL, data={'_token': token, 'email': EMAIL, 'password': PASSWORD, 'remember': 'on'}, allow_redirects=True, timeout=15)
    if 'login' in post_res.url.lower():
        raise Exception("فشل تسجيل الدخول! تأكد من الحساب.")
    return s

def load_progress():
    if os.path.exists(PROGRESS_FILE):
        try:
            with open(PROGRESS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except:
            pass
    return {'last_page': 0, 'downloaded_count': 0, 'total_pages': 63}

def save_progress(data):
    with open(PROGRESS_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def process_company(session, uuid):
    try:
        r = session.get(f'{COMPANIES_URL}/{uuid}/edit', timeout=15)
        if r.status_code != 200:
            return None

        card_m = re.search(r'name="card_no"[^>]+value="([^"]*)"', r.text)
        comp_m = re.search(r'name="company_name"[^>]+value="([^"]*)"', r.text)
        ceo_m = re.search(r'name="ceo_name"[^>]+value="([^"]*)"', r.text)
        comm_m = re.search(r'name="commercial_name_no"[^>]+value="([^"]*)"', r.text)
        
        # Match company photo URL in /storage/companies/ or /storage/traders/
        img_m = re.findall(r'https://membership\.k-coc\.org/storage/(?:companies|traders)/[a-zA-Z0-9_\-\.]+\.(?:jpg|jpeg|png)', r.text, re.IGNORECASE)

        card_no = card_m.group(1).strip() if card_m else ''
        company_name = comp_m.group(1).strip() if comp_m else ''
        ceo_name = ceo_m.group(1).strip() if ceo_m else ''
        commercial_name_no = comm_m.group(1).strip() if comm_m else ''
        img_url = img_m[0] if img_m else None

        if not img_url:
            return None

        # Build clean unique filename
        c_prefix = card_no if (card_no and card_no != '0') else commercial_name_no
        filename = f"company_{c_prefix}_{os.path.basename(img_url)}" if c_prefix else f"company_{uuid[:8]}_{os.path.basename(img_url)}"
        local_path = os.path.join(UPLOADS_DIR, filename)
        db_path = f"/uploads/{filename}"

        # Download if not already on disk
        if not os.path.exists(local_path):
            img_r = session.get(img_url, timeout=15)
            if img_r.status_code == 200:
                with open(local_path, 'wb') as f:
                    f.write(img_r.content)

        if not os.path.exists(local_path):
            # Remote image was 404 or failed to download
            return None

        return {
            'uuid': uuid,
            'card_no': card_no,
            'company_name': company_name,
            'ceo_name': ceo_name,
            'commercial_name_no': commercial_name_no,
            'photo_path': db_path
        }
    except Exception as e:
        return None

def sync_companies(start_page=1, max_pages=None):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    session = get_session()
    progress = load_progress()

    if start_page is None:
        start_page = progress.get('last_page', 0) + 1
        if start_page > progress.get('total_pages', 63):
            start_page = 1

    total_pages = progress.get('total_pages', 63)
    total_downloaded = progress.get('downloaded_count', 0)

    print("=" * 65)
    print("🚀 بدء مزامنة واستخراج صور شركات غرفة تجارة كربلاء المقدسة...")
    print(f"📄 البدء من الصفحة [{start_page}] حتى [{total_pages}]...")
    print("=" * 65)

    current_page = start_page
    pages_processed = 0

    while current_page <= total_pages:
        if max_pages and pages_processed >= max_pages:
            print(f"\n⏹️ تم إكمال سحب الدفعة المحددة ({max_pages} صفحة) بنجاح.")
            break

        print(f"\n📑 جلب الصفحة [{current_page} / {total_pages}] من موقع الغرفة...")
        page_res = session.get(f'{COMPANIES_URL}?page={current_page}', timeout=15)
        if page_res.status_code != 200:
            print(f"⚠️ تعذر جلب الصفحة {current_page}، إعادة المحاولة...")
            time.sleep(2)
            continue

        uuids = list(dict.fromkeys(re.findall(r'/companies/([a-zA-Z0-9\-]{36})', page_res.text)))
        print(f"  🏢 تم العثور على {len(uuids)} شركة. جاري فحص وسحب صورهم بالتوازي...")

        with ThreadPoolExecutor(max_workers=6) as executor:
            futures = [executor.submit(process_company, session, u) for u in uuids]
            for future in as_completed(futures):
                res = future.result()
                if res and res['photo_path']:
                    target_id = None
                    
                    # 1. Match by existing UUID
                    row = cursor.execute("SELECT id FROM traders WHERE member_type = 'company' AND uuid = ? LIMIT 1", (res['uuid'],)).fetchone()
                    if row:
                        target_id = row[0]

                    # 2. Match by card_no AND company_name
                    if not target_id and res['card_no'] and res['card_no'] != '0':
                        row = cursor.execute("SELECT id FROM traders WHERE member_type = 'company' AND card_no = ? AND (company_name = ? OR commercial_name = ?) LIMIT 1", 
                                             (res['card_no'], res['company_name'], res['company_name'])).fetchone()
                        if row:
                            target_id = row[0]

                    # 3. Match by card_no alone (if not 0)
                    if not target_id and res['card_no'] and res['card_no'] != '0':
                        row = cursor.execute("SELECT id FROM traders WHERE member_type = 'company' AND card_no = ? LIMIT 1", (res['card_no'],)).fetchone()
                        if row:
                            target_id = row[0]

                    # 4. Match by company_name AND commercial_name_no
                    if not target_id and res['company_name']:
                        row = cursor.execute("SELECT id FROM traders WHERE member_type = 'company' AND (company_name = ? OR commercial_name = ?) LIMIT 1", 
                                             (res['company_name'], res['company_name'])).fetchone()
                        if row:
                            target_id = row[0]

                    # 5. Match by ceo_name
                    if not target_id and res['ceo_name']:
                        row = cursor.execute("SELECT id FROM traders WHERE member_type = 'company' AND (ceo_name = ? OR name = ?) LIMIT 1", 
                                             (res['ceo_name'], res['ceo_name'])).fetchone()
                        if row:
                            target_id = row[0]

                    if target_id:
                        try:
                            cursor.execute("UPDATE traders SET photo_path = ?, uuid = ? WHERE id = ?", (res['photo_path'], res['uuid'], target_id))
                        except sqlite3.IntegrityError:
                            cursor.execute("UPDATE traders SET photo_path = ? WHERE id = ?", (res['photo_path'], target_id))
                    
                    total_downloaded += 1
                    c_title = res['company_name'] or res['ceo_name'] or res['card_no']
                    print(f"    📸 تم ربط صورة: {c_title}")

        conn.commit()
        progress['last_page'] = current_page
        progress['downloaded_count'] = total_downloaded
        save_progress(progress)

        print(f"  ✅ تم حفظ صور الصفحة {current_page}. إجمالي صور الشركات: {total_downloaded}")
        current_page += 1
        pages_processed += 1

    conn.close()
    print("\n" + "=" * 65)
    print("🎉 اكتملت عملية سحب وربط صور الشركات بنجاح تام!")
    print(f"📊 إجمالي الصور المحفوظة والمربوطة بالشركات: {total_downloaded}")
    print("=" * 65)

if __name__ == '__main__':
    max_p = int(sys.argv[1]) if len(sys.argv) > 1 else None
    start_p = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    sync_companies(start_page=start_p, max_pages=max_p)
