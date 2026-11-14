// ========================================================
// Card Renderer Engine - غرفة تجارة كربلاء المقدسة
// High-Resolution Canvas Rendering (CR80 Standard / 300 DPI)
// ========================================================

export function entoar(str) {
  if (!str) return '';
  return String(str).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
}

function formatArabicDate(dateStr) {
  const s = String(dateStr || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return entoar(`${m[3]}-${m[2]}-${m[1]}`);
  return entoar(s);
}

function drawArabicDate(ctx, dateStr, x, y) {
  const formatted = formatArabicDate(dateStr);
  if (!formatted) return;
  ctx.fillText(formatted, x, y);
}

export function formatClassName(cardClass, lang = 'ar') {
  const c = String(cardClass || '').trim();
  if (lang === 'ar') {
    if (c === '1' || c === 'الأولى' || c === 'الاولى' || c === 'الاول') return 'الأول';
    if (c === '2' || c === 'الثانية') return 'الثاني';
    if (c === '3' || c === 'الثالثة') return 'الثالث';
    if (c === '4' || c === 'الرابعة') return 'الرابع';
    if (c.toLowerCase().includes('ممتاز') || c === '0') return 'الممتاز';
    return c;
  } else {
    if (c === '1' || c === 'الأولى' || c === 'الاولى' || c === 'الأول' || c === 'الاول') return 'First';
    if (c === '2' || c === 'الثانية' || c === 'الثاني') return 'Second';
    if (c === '3' || c === 'الثالثة' || c === 'الثالث') return 'Third';
    if (c === '4' || c === 'الرابعة' || c === 'الرابع') return 'Fourth';
    if (c.toLowerCase().includes('ممتاز') || c === '0') return 'Excellent';
    return c;
  }
}

// Preload Image helper
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const CARD_LOGICAL_W = 1024;
const CARD_LOGICAL_H = 644;
const CARD_RENDER_W = 3434;
const CARD_RENDER_H = 2160;

function initHiResCardCanvas(canvas, bg) {
  const ctx = canvas.getContext('2d');
  canvas.width = CARD_RENDER_W;
  canvas.height = CARD_RENDER_H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, CARD_RENDER_W, CARD_RENDER_H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (bg) {
    ctx.drawImage(bg, 0, 0, CARD_RENDER_W, CARD_RENDER_H);
  } else {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, CARD_RENDER_W, CARD_RENDER_H);
  }
  ctx.setTransform(CARD_RENDER_W / CARD_LOGICAL_W, 0, 0, CARD_RENDER_H / CARD_LOGICAL_H, 0, 0);
  return ctx;
}

// Render Front Card on Canvas
export async function renderFrontCard(canvas, trader) {
  // 1. Load Background Template
  const tplPath = (trader && trader.member_type === 'company')
    ? '/templates/company_front_clean.png?v=5'
    : ((trader && trader.member_type === 'broker')
      ? '/templates/broker_front_clean.png?v=5'
      : '/templates/card_front_template.png?v=5');
  const bg = await loadImage(tplPath);
  const ctx = initHiResCardCanvas(canvas, bg);

  // 2. Draw Trader Photo (Inside rounded box)
  const photoSrc = trader.photo_path || '/templates/avatar_placeholder.png';
  const photo = await loadImage(photoSrc);

  const photoBox = (trader && trader.member_type === 'company')
    ? { x: 18, y: 265, w: 275, h: 355, radius: 22 }
    : ((trader && trader.member_type === 'broker')
      ? { x: 23, y: 267, w: 272, h: 353, radius: 22 }
      : { x: 20, y: 268, w: 275, h: 342, radius: 22 });
  const { x: boxX, y: boxY, w: boxW, h: boxH, radius } = photoBox;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(boxX + radius, boxY);
  ctx.lineTo(boxX + boxW - radius, boxY);
  ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + radius);
  ctx.lineTo(boxX + boxW, boxY + boxH - radius);
  ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - radius, boxY + boxH);
  ctx.lineTo(boxX + radius, boxY + boxH);
  ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - radius);
  ctx.lineTo(boxX, boxY + radius);
  ctx.quadraticCurveTo(boxX, boxY, boxX + radius, boxY);
  ctx.closePath();
  ctx.clip();

  if (photo) {
    ctx.drawImage(photo, boxX, boxY, boxW, boxH);
  } else {
    ctx.fillStyle = '#E5E7EB';
    ctx.fillRect(boxX, boxY, boxW, boxH);
  }
  ctx.restore();

  // 3. Render Arabic Text Fields
  ctx.save();
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#000000';

  // التاجر
  ctx.font = 'bold 38px "PT Bold Heading", Cairo, sans-serif';
  ctx.fillText(trader.name || '', 905, 309);

  // الصنف
  ctx.font = 'bold 38px "PT Bold Heading", Cairo, sans-serif';
  ctx.fillText(formatClassName(trader.card_class, 'ar'), 897, 369);

  // الاسم التجاري
  ctx.font = 'bold 33px "PT Bold Heading", Cairo, sans-serif';
  let commText = trader.commercial_name || '';
  if (trader.commercial_name_no) {
    commText += ' / ' + entoar(trader.commercial_name_no);
  }
  ctx.fillText(commText, 800, 429);

  // النشاط
  ctx.font = 'bold 33px "PT Bold Heading", Cairo, sans-serif';
  ctx.fillText(trader.activity || '', 895, 487);

  // رقم الهوية (White text on ribbon)
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 36px "PT Bold Heading", Cairo, sans-serif';
  let cardText = entoar(trader.card_no);
  if (trader.renewal_no) {
    cardText += ' / ' + entoar(trader.renewal_no);
  }
  ctx.fillText(cardText, 849, 551);

  // الانتساب
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 28px "PT Bold Heading", Cairo, sans-serif';
  drawArabicDate(ctx, trader.affiliation_date || '', 908, 616);

  // النفاذ
  drawArabicDate(ctx, trader.expire_date || '', 472, 616);

  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// Render Back Card on Canvas
export async function renderBackCard(canvas, trader, qrDataUrl) {
  // 1. Load Clean Back Template
  const backTplPath = (trader && trader.member_type === 'company')
    ? '/templates/company_back_clean.png?v=5'
    : ((trader && trader.member_type === 'broker')
      ? '/templates/broker_back_clean.png?v=5'
      : '/templates/card_back_clean.png?v=5');
  const bg = await loadImage(backTplPath);
  const ctx = initHiResCardCanvas(canvas, bg);

  // 2. Draw Dynamic QR Code
  if (qrDataUrl) {
    const qrImg = await loadImage(qrDataUrl);
    if (qrImg) {
      ctx.drawImage(qrImg, 758, 210, 238, 238);
    }
  }

  // 3. Render English Text Fields
  ctx.save();
  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#000000';

  // Trader Name (English)
  ctx.font = 'bold 36px "Myriad Pro", Arial, sans-serif';
  const enName = (trader.english_name || trader.name || '').toUpperCase();
  ctx.fillText(enName, 14, 305);

  // Class
  ctx.font = 'bold 36px "Myriad Pro", Arial, sans-serif';
  ctx.fillText(formatClassName(trader.card_class, 'en'), 118, 376);

  // Commercial Name No
  ctx.font = 'bold 36px "Myriad Pro", Arial, sans-serif';
  ctx.fillText(trader.commercial_name_no || '-', 396, 433);

  // Activity
  ctx.font = 'bold 36px "Myriad Pro", Arial, sans-serif';
  const enAct = trader.english_activity || trader.activity || '-';
  ctx.fillText(enAct, 163, 484);

  // ID No (White text on ribbon)
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 34px "Myriad Pro", Arial, sans-serif';
  let enCard = trader.card_no || '';
  if (trader.renewal_no) {
    enCard += ' / ' + trader.renewal_no;
  }
  ctx.fillText(enCard, 124, 570);

  // Affiliation
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 27px "Myriad Pro", Arial, sans-serif';
  ctx.fillText(trader.affiliation_date || '-', 169, 630);

  // Expiration
  ctx.fillText(trader.expire_date || '-', 733, 630);

  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
