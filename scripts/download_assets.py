import os
import re
import sys
import requests

sys.stdout.reconfigure(encoding='utf-8')

BASE_URL = 'https://membership.k-coc.org'
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_DIR = os.path.join(ROOT_DIR, 'public')

files_to_download = [
    'build/manifest.json',
    'build/assets/app-514d3f3f.css',
    'build/assets/app-4a08c204.js',
    'favicon.ico',
    'favicon-32x32.png',
    'apple-touch-icon.png',
    'images/chamber-logo.png'
]

print("🚀 جاري تحميل ملفات التنسيق والتصميم (CSS, JS, Fonts, Images)...")

for rel_path in files_to_download:
    url = f"{BASE_URL}/{rel_path}"
    dest_path = os.path.join(PUBLIC_DIR, rel_path.replace('/', os.sep))
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    try:
        r = requests.get(url, timeout=15)
        if r.status_code == 200:
            with open(dest_path, 'wb') as f:
                f.write(r.content)
            print(f"  ✅ تم تحميل: {rel_path} ({len(r.content):,} bytes)")
        else:
            print(f"  ⚠️ فشل جلب: {rel_path} (كود {r.status_code})")
    except Exception as e:
        print(f"  ❌ خطأ في {rel_path}: {e}")

# Check for font or asset URLs inside app-514d3f3f.css
css_path = os.path.join(PUBLIC_DIR, 'build', 'assets', 'app-514d3f3f.css')
if os.path.exists(css_path):
    with open(css_path, 'r', encoding='utf-8', errors='ignore') as f:
        css_content = f.read()
    
    urls = re.findall(r'url\([\'"]?([^\'")]+)[\'"]?\)', css_content)
    print(f"\n🔍 تم العثور على {len(urls)} روابط داخل ملف CSS:")
    for u in urls:
        if u.startswith('data:'):
            continue
        clean_u = u.split('?')[0].split('#')[0]
        # Resolve relative to build/assets or root
        if clean_u.startswith('/'):
            remote_url = f"{BASE_URL}{clean_u}"
            dest = os.path.join(PUBLIC_DIR, clean_u.lstrip('/').replace('/', os.sep))
        elif clean_u.startswith('../'):
            # from build/assets/ to build/
            remote_url = f"{BASE_URL}/build/{clean_u[3:]}"
            dest = os.path.join(PUBLIC_DIR, 'build', clean_u[3:].replace('/', os.sep))
        else:
            remote_url = f"{BASE_URL}/build/assets/{clean_u}"
            dest = os.path.join(PUBLIC_DIR, 'build', 'assets', clean_u.replace('/', os.sep))

        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if not os.path.exists(dest):
            try:
                res = requests.get(remote_url, timeout=15)
                if res.status_code == 200:
                    with open(dest, 'wb') as f:
                        f.write(res.content)
                    print(f"  ✅ تم تحميل ملحقات CSS: {clean_u}")
                else:
                    print(f"  ⚠️ تعذر جلب {remote_url} ({res.status_code})")
            except Exception as e:
                print(f"  ❌ خطأ في جلب {remote_url}: {e}")

print("\n🎉 اكتمل تحميل كافة ملفات التنسيق بنجاح تام!")
