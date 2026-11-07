// ========================================================
// Card Renderer Engine - غرفة تجارة كربلاء المقدسة
// High-Resolution Canvas Rendering (CR80 Standard / 300 DPI)
// ========================================================

export function entoar(str) {
  if (!str) return '';
  return String(str).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
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

// Render Front Card on Canvas
export async function renderFrontCard(canvas, trader) {
  const ctx = canvas.getContext('2d');
  canvas.width = 1024;
  canvas.height = 644;

  // 1. Load Background Template
  const bg = await loadImage('/templates/card_front_template.png');
  if (bg) {
    ctx.drawImage(bg, 0, 0, 1024, 644);
  } else {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 1024, 644);
  }

  // 2. Draw Trader Photo (Inside rounded box)
  const photoSrc = trader.photo_path || '/templates/avatar_placeholder.png';
  const photo = await loadImage(photoSrc);
  
  const boxX = 14;
  const boxY = 266;
  const boxW = 274;
  const boxH = 354;
  const radius = 24;

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
  ctx.font = 'bold 28px "PT Bold Heading", Cairo, sans-serif';
  ctx.fillText(trader.name || '', 900, 308);

  // الصنف
  ctx.font = 'bold 26px "PT Bold Heading", Cairo, sans-serif';
  ctx.fillText(formatClassName(trader.card_class, 'ar'), 890, 366);

  // الاسم التجاري
  ctx.font = 'bold 24px "PT Bold Heading", Cairo, sans-serif';
  let commText = trader.commercial_name || '';
  if (trader.commercial_name_no) {
    commText += ' / ' + entoar(trader.commercial_name_no);
  }
  ctx.fillText(commText, 795, 432);

  // النشاط
  ctx.font = 'bold 24px "PT Bold Heading", Cairo, sans-serif';
  ctx.fillText(trader.activity || '', 885, 490);

  // رقم الهوية (White text on blue ribbon)
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 30px "PT Bold Heading", Cairo, sans-serif';
  let cardText = entoar(trader.card_no);
  if (trader.renewal_no) {
    cardText += ' / ' + entoar(trader.renewal_no);
  }
  ctx.fillText(cardText, 845, 560);

  // الانتساب
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 23px "PT Bold Heading", Cairo, sans-serif';
  ctx.fillText(entoar(trader.affiliation_date || ''), 885, 626);

  // النفاذ
  ctx.fillText(entoar(trader.expire_date || ''), 465, 626);

  ctx.restore();
}

// Render Back Card on Canvas
export async function renderBackCard(canvas, trader, qrDataUrl) {
  const ctx = canvas.getContext('2d');
  canvas.width = 1024;
  canvas.height = 644;

  // 1. Load Clean Back Template
  const bg = await loadImage('/templates/card_back_clean.png');
  if (bg) {
    ctx.drawImage(bg, 0, 0, 1024, 644);
  } else {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 1024, 644);
  }

  // 2. Draw Dynamic QR Code
  if (qrDataUrl) {
    const qrImg = await loadImage(qrDataUrl);
    if (qrImg) {
      // Precise Coordinates: x: 757, y: 210, w: 238, h: 238
      ctx.drawImage(qrImg, 757, 210, 238, 238);
    }
  }

  // 3. Render English Text Fields
  ctx.save();
  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#000000';

  // Trader Name (English)
  ctx.font = 'bold 26px "Myriad Pro", Arial, sans-serif';
  const enName = (trader.english_name || trader.name || '').toUpperCase();
  ctx.fillText(enName, 14, 318);

  // Class
  ctx.font = 'bold 24px "Myriad Pro", Arial, sans-serif';
  ctx.fillText(formatClassName(trader.card_class, 'en'), 118, 368);

  // Commercial Name No
  ctx.font = 'bold 24px "Myriad Pro", Arial, sans-serif';
  ctx.fillText(trader.commercial_name_no || '-', 315, 423);

  // Activity
  ctx.font = 'bold 22px "Myriad Pro", Arial, sans-serif';
  const enAct = trader.english_activity || trader.activity || '-';
  ctx.fillText(enAct, 165, 474);

  // ID No (White text on blue ribbon)
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 30px "Myriad Pro", Arial, sans-serif';
  let enCard = trader.card_no || '';
  if (trader.renewal_no) {
    enCard += ' / ' + trader.renewal_no;
  }
  ctx.fillText(enCard, 125, 560);

  // Affiliation
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 22px "Myriad Pro", Arial, sans-serif';
  ctx.fillText(trader.affiliation_date || '-', 170, 620);

  // Expiration
  ctx.fillText(trader.expire_date || '-', 735, 620);

  ctx.restore();
}
