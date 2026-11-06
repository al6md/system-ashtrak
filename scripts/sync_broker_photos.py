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
BROKERS_URL = f'{BASE_URL}/brokers'

EMAIL = "admin@k-coc.org"
PASSWORD = """s.ipwRSYAG!dd'&Ng4v%.+gX0/wP9H'w"""

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT_DIR, 'data', 'cardval.db')
UPLOADS_DIR = os.path.join(ROOT_DIR, 'public', 'uploads')
PROGRESS_FILE = os.path.join(ROOT_DIR, 'data', 'sync_brokers_progress.json')
os.makedirs(UPLOADS_DIR, exist_ok=True)

def get_session():
    s = requests.Session()
    s.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    })
    res = s.get(LOGIN_URL, timeout=15)
    token_m = re.search(r'name="_token"\s+value="([^"]+)"', res.text)
    if not token_m:
        raise Exception("تعذر استخراج رمز CSRF للدلالين")
    token = token_m.group(1)
    
    post_res = s.post(LOGIN_URL, data={'_token': token, 'email': EMAIL, 'password': PASSWORD, 'remember': 'on'}, allow_redirects=True, timeout=15)
    if 'login' in post_res.url.lower():
        raise Exception("فشل تسجيل الدخول! تأكد من بيانات الحساب.")
    return s

def load_progress():
    if os.path.exists(PROGRESS_FILE):
        try:
            with open(PROGRESS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except:
            pass
    return {'last_page': 0, 'downloaded_count': 0, 'total_pages': 111}

def save_progress(data):
    with open(PROGRESS_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def process_broker(session, uuid):
    try:
        r = session.get(f'{BROKERS_URL}/{uuid}/edit', timeout=15)
        if r.status_code != 200:
            return None

        card_m = re.search(r'name="card_no"[^>]+value="([^"]*)"', r.text)
        name_m = re.search(r'name="name"[^>]+value="([^"]*)"', r.text)
        comm_m = re.search(r'name="commercial_name"[^>]+value="([^"]*)"', r.text)
        stamp_m = re.search(r'name="stamp_no"[^>]+value="([^"]*)"', r.text)
        
        # Match broker photo URL in /storage/brokers/ or /storage/traders/
        img_m = re.findall(r'https://membership\.k-coc\.org/storage/(?:brokers|traders)/[a-zA-Z0-9_\-\.]+\.(?:jpg|jpeg|png)', r.text, re.IGNORECASE)

        card_no = card_m.group(1).strip() if card_m else ''
        name = name_m.group(1).strip() if name_m else ''
        commercial_name = comm_m.group(1).strip() if comm_m else ''
        stamp_no = stamp_m.group(1).strip() if stamp_m else ''
        img_url = img_m[0] if img_m else None

        if not img_url:
            return None

        # Build clean unique filename
        c_prefix = card_no if (card_no and card_no != '0') else stamp_no
        filename = f"broker_{c_prefix}_{os.path.basename(img_url)}" if c_prefix else f"broker_{uuid[:8]}_{os.path.basename(img_url)}"
        local_path = os.path.join(UPLOADS_DIR, filename)
        db_path = f"/uploads/{filename}"

        # Download if not already on disk
        if not os.path.exists(local_path):
            img_r = session.get(img_url, timeout=15)
            if img_r.status_code == 200:
                with open(local_path, 'wb') as f:
                    f.write(img_r.content)

        if not os.path.exists(local_path):
            return None

        return {
            'uuid': uuid,
            'card_no': card_no,
            'name': name,
            'commercial_name': commercial_name,
            'stamp_no': stamp_no,
            'photo_path': db_path
        }
    except Exception as e:
        return None

def sync_brokers(start_page=1, max_pages=None):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    session = get_session()
    progress = load_progress()

    if start_page is None:
        start_page = progress.get('last_page', 0) + 1
        if start_page > progress.get('total_pages', 111):
            start_page = 1

    total_pages = progress.get('total_pages', 111)
    total_downloaded = progress.get('downloaded_count', 0)

    print("=" * 65)
    print("🚀 بدء مزامنة واستخراج صور دلالين غرفة تجارة كربلاء المقدسة...")
    print(f"📄 البدء من الصفحة [{start_page}] حتى [{total_pages}]...")
    print("=" * 65)

    current_page = start_page
    pages_processed = 0

    while current_page <= total_pages:
        if max_pages and pages_processed >= max_pages:
            print(f"\n⏹️ تم إكمال سحب الدفعة المحددة ({max_pages} صفحة) بنجاح.")
            break

        print(f"\n📑 جلب الصفحة [{current_page} / {total_pages}] من موقع الغرفة...")
        page_res = session.get(f'{BROKERS_URL}?page={current_page}', timeout=15)
        if page_res.status_code != 200:
            print(f"⚠️ تعذر جلب الصفحة {current_page}، إعادة المحاولة...")
            time.sleep(2)
            continue

        uuids = list(dict.fromkeys(re.findall(r'/brokers/([a-zA-Z0-9\-]{36})', page_res.text)))
        print(f"  🏢 تم العثور على {len(uuids)} دلال. جاري فحص وسحب صورهم بالتوازي...")

        with ThreadPoolExecutor(max_workers=6) as executor:
            futures = [executor.submit(process_broker, session, u) for u in uuids]
            for future in as_completed(futures):
                res = future.result()
                if res and res['photo_path']:
                    target_id = None
                    
                    # 1. Match by existing UUID
                    row = cursor.execute("SELECT id FROM traders WHERE member_type = 'broker' AND uuid = ? LIMIT 1", (res['uuid'],)).fetchone()
                    if row:
                        target_id = row[0]

                    # 2. Match by card_no AND name
                    if not target_id and res['card_no'] and res['card_no'] != '0' and res['name']:
                        row = cursor.execute("SELECT id FROM traders WHERE member_type = 'broker' AND card_no = ? AND name = ? LIMIT 1", 
                                             (res['card_no'], res['name'])).fetchone()
                        if row:
                            target_id = row[0]

                    # 3. Match by card_no AND commercial_name
                    if not target_id and res['card_no'] and res['card_no'] != '0' and res['commercial_name']:
                        row = cursor.execute("SELECT id FROM traders WHERE member_type = 'broker' AND card_no = ? AND commercial_name = ? LIMIT 1", 
                                             (res['card_no'], res['commercial_name'])).fetchone()
                        if row:
                            target_id = row[0]

                    # 4. Match by card_no alone (if not 0)
                    if not target_id and res['card_no'] and res['card_no'] != '0':
                        row = cursor.execute("SELECT id FROM traders WHERE member_type = 'broker' AND card_no = ? LIMIT 1", (res['card_no'],)).fetchone()
                        if row:
                            target_id = row[0]

                    # 5. Match by stamp_no
                    if not target_id and res['stamp_no'] and res['stamp_no'] != '0':
                        row = cursor.execute("SELECT id FROM traders WHERE member_type = 'broker' AND stamp_no = ? LIMIT 1", (res['stamp_no'],)).fetchone()
                        if row:
                            target_id = row[0]

                    # 6. Match by name AND commercial_name
                    if not target_id and res['name']:
                        row = cursor.execute("SELECT id FROM traders WHERE member_type = 'broker' AND name = ? LIMIT 1", (res['name'],)).fetchone()
                        if row:
                            target_id = row[0]

                    if target_id:
                        try:
                            cursor.execute("UPDATE traders SET photo_path = ?, uuid = ? WHERE id = ?", (res['photo_path'], res['uuid'], target_id))
                        except sqlite3.IntegrityError:
                            cursor.execute("UPDATE traders SET photo_path = ? WHERE id = ?", (res['photo_path'], target_id))
                    
                    total_downloaded += 1
                    b_title = res['name'] or res['commercial_name'] or res['card_no']
                    print(f"    📸 تم ربط صورة الدلال: {b_title}")

        conn.commit()
        progress['last_page'] = current_page
        progress['downloaded_count'] = total_downloaded
        save_progress(progress)

        print(f"  ✅ تم حفظ صور الصفحة {current_page}. إجمالي صور الدلالين المحفوظة: {total_downloaded}")
        current_page += 1
        pages_processed += 1

    conn.close()
    print("\n" + "=" * 65)
    print("🎉 اكتملت عملية سحب وربط صور الدلالين بنجاح تام!")
    print(f"📊 إجمالي الصور المحفوظة والمربوطة بالدلالين: {total_downloaded}")
    print("=" * 65)

if __name__ == '__main__':
    max_p = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else None
    start_p = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else None
    sync_brokers(start_page=start_p, max_pages=max_p)
