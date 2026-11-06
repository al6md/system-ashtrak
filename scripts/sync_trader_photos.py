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
TRADERS_URL = f'{BASE_URL}/traders'

EMAIL = "admin@k-coc.org"
PASSWORD = """s.ipwRSYAG!dd'&Ng4v%.+gX0/wP9H'w"""

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT_DIR, 'data', 'cardval.db')
UPLOADS_DIR = os.path.join(ROOT_DIR, 'public', 'uploads')
PROGRESS_FILE = os.path.join(ROOT_DIR, 'data', 'sync_traders_progress.json')
os.makedirs(UPLOADS_DIR, exist_ok=True)


def download_indexed_photo(row):
    """Downloads a trader photo whose path is already recorded in data/cardval.db."""
    trader_id, name, photo_path = row
    filename = os.path.basename(photo_path)
    local_path = os.path.join(UPLOADS_DIR, filename)
    if os.path.exists(local_path) and os.path.getsize(local_path) > 100:
        return True, False, name

    m = re.match(r'^(?:trader|company|broker)_[^_]+_(.+)$', filename, re.IGNORECASE)
    remote_name = m.group(1) if m else filename
    url = f"{BASE_URL}/storage/traders/{remote_name}"
    try:
        r = requests.get(url, timeout=15)
        if r.status_code == 200 and len(r.content) > 100:
            with open(local_path, 'wb') as f:
                f.write(r.content)
            return True, True, name
    except Exception:
        pass
    return False, False, name


def download_all_db_indexed_trader_photos(limit=None):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        SELECT id, name, photo_path
        FROM traders
        WHERE (member_type = 'trader' OR member_type IS NULL)
          AND photo_path IS NOT NULL AND photo_path != ''
        ORDER BY id ASC
    """)
    rows = c.fetchall()
    conn.close()

    missing = []
    already_on_disk = 0
    for r in rows:
        fname = os.path.basename(r[2])
        lpath = os.path.join(UPLOADS_DIR, fname)
        if os.path.exists(lpath) and os.path.getsize(lpath) > 100:
            already_on_disk += 1
        else:
            missing.append(r)

    if limit:
        missing = missing[:limit]

    print("=" * 65)
    print(f"📦 إجمالي التجار المسجلة صورهم في قاعدة البيانات: {len(rows)}")
    print(f"✅ الموجود حالياً على القرص: {already_on_disk} | 📥 المتبقي للتحميل المباشر: {len(missing)}")
    print("=" * 65)

    if not missing:
        print("🎉 جميع صور التجار المسجلة محملة وموجودة على القرص بالفعل!")
        return already_on_disk

    downloaded = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=25) as executor:
        futures = [executor.submit(download_indexed_photo, r) for r in missing]
        for idx, future in enumerate(as_completed(futures), 1):
            ok, is_new, tname = future.result()
            if ok and is_new:
                downloaded += 1
            elif not ok:
                failed += 1
            if idx % 50 == 0 or idx == len(missing):
                print(f"  ⏳ تقدم التحميل المباشر: [{idx} / {len(missing)}] | تم حفظ: {downloaded} صورة جديدة...")

    print(f"\n🎉 اكتمل تحميل {downloaded} صورة تاجر جديدة إلى المجلد public/uploads!")
    return already_on_disk + downloaded


if __name__ == '__main__':
    lim = int(sys.argv[1]) if len(sys.argv) > 1 else None
    download_all_db_indexed_trader_photos(limit=lim)
