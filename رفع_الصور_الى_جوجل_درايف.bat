@echo off
chcp 65001 >nul
echo ========================================================
echo        رفع ومزامنة صور المشتركين إلى Google Drive
echo ========================================================
echo.
node scripts/upload_photos_to_drive.mjs
echo.
pause
