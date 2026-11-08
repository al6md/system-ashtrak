// ============================================================================
// Fast Card Modal, 60-FPS Canvas Renderer, Instant AJAX Delete & Link Prefetch
// ============================================================================

let currentTrader = null;
let globalTypography = null;
let activeCardTypography = null;
let currentModalSide = 'front';
let currentModalQrUrl = null;
let activeModalFieldKey = 'name';
let redrawRafId = null;
let modalRequestToken = 0;

// Persistent in-memory caches (zero re-download / re-decode across opens & slider drags)
const IMAGE_PROMISE_CACHE = new Map();
const RESOLVED_IMAGE_CACHE = new Map();
const GLOBAL_TYPO_CACHE = new Map();
let fontsLoadedOnce = false;
let fontsLoadPromise = null;

function escapeHtmlClient(val) {
    if (val === null || val === undefined) return '';
    return String(val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const MODAL_FRONT_FIELDS = [
    { key: 'name', label: 'اسم التاجر', sizeKey: 'name_size', xKey: 'name_x', yKey: 'name_y' },
    { key: 'class', label: 'الصنف', sizeKey: 'class_size', xKey: 'class_x', yKey: 'class_y' },
    { key: 'comm', label: 'الاسم التجاري', sizeKey: 'comm_size', xKey: 'comm_x', yKey: 'comm_y' },
    { key: 'activity', label: 'النشاط', sizeKey: 'activity_size', xKey: 'activity_x', yKey: 'activity_y' },
    { key: 'card_no', label: 'رقم الهوية', sizeKey: 'card_no_size', xKey: 'card_no_x', yKey: 'card_no_y' },
    { key: 'aff_date', label: 'الانتساب', sizeKey: 'aff_date_size', xKey: 'aff_date_x', yKey: 'aff_date_y' },
    { key: 'exp_date', label: 'النفاذ', sizeKey: 'exp_date_size', xKey: 'exp_date_x', yKey: 'exp_date_y' }
];

const MODAL_BACK_FIELDS = [
    { key: 'name', label: 'Name (الاسم)', sizeKey: 'name_size', xKey: 'name_x', yKey: 'name_y' },
    { key: 'class', label: 'Class', sizeKey: 'class_size', xKey: 'class_x', yKey: 'class_y' },
    { key: 'comm_no', label: 'Commercial Name No', sizeKey: 'comm_no_size', xKey: 'comm_no_x', yKey: 'comm_no_y' },
    { key: 'activity', label: 'Activity', sizeKey: 'activity_size', xKey: 'activity_x', yKey: 'activity_y' },
    { key: 'card_no', label: 'ID No', sizeKey: 'card_no_size', xKey: 'card_no_x', yKey: 'card_no_y' },
    { key: 'aff_date', label: 'Affiliation', sizeKey: 'aff_date_size', xKey: 'aff_date_x', yKey: 'aff_date_y' },
    { key: 'exp_date', label: 'Expiration', sizeKey: 'exp_date_size', xKey: 'exp_date_x', yKey: 'exp_date_y' },
    { key: 'qr', label: 'QR Code', sizeKey: 'qr_size', xKey: 'qr_x', yKey: 'qr_y' }
];

const COMPANY_FRONT_FIELDS = [
    { key: 'comp', label: 'الشركة', sizeKey: 'comp_size', xKey: 'comp_x', yKey: 'comp_y' },
    { key: 'ceo', label: 'المدير المفوض', sizeKey: 'ceo_size', xKey: 'ceo_x', yKey: 'ceo_y' },
    { key: 'class_act', label: 'الصنف والنشاط', sizeKey: 'class_act_size', xKey: 'class_act_x', yKey: 'class_act_y' },
    { key: 'cert', label: 'إجازة التأسيس', sizeKey: 'cert_size', xKey: 'cert_x', yKey: 'cert_y' },
    { key: 'comm_date', label: 'الاسم التجاري (الرقم)', sizeKey: 'comm_date_size', xKey: 'comm_date_x', yKey: 'comm_date_y' },
    { key: 'card_no', label: 'رقم الهوية', sizeKey: 'card_no_size', xKey: 'card_no_x', yKey: 'card_no_y' },
    { key: 'aff_date', label: 'الانتساب', sizeKey: 'aff_date_size', xKey: 'aff_date_x', yKey: 'aff_date_y' },
    { key: 'exp_date', label: 'النفاذ', sizeKey: 'exp_date_size', xKey: 'exp_date_x', yKey: 'exp_date_y' }
];

const COMPANY_BACK_FIELDS = [
    { key: 'comp_en', label: 'Company', sizeKey: 'comp_en_size', xKey: 'comp_en_x', yKey: 'comp_en_y' },
    { key: 'ceo_en', label: 'CEO', sizeKey: 'ceo_en_size', xKey: 'ceo_en_x', yKey: 'ceo_en_y' },
    { key: 'class_act_en', label: 'Class / Activity', sizeKey: 'class_act_en_size', xKey: 'class_act_en_x', yKey: 'class_act_en_y' },
    { key: 'license_en', label: 'License No', sizeKey: 'license_en_size', xKey: 'license_en_x', yKey: 'license_en_y' },
    { key: 'comm_no', label: 'Commercial Name No', sizeKey: 'comm_no_size', xKey: 'comm_no_x', yKey: 'comm_no_y' },
    { key: 'card_no', label: 'ID No', sizeKey: 'card_no_size', xKey: 'card_no_x', yKey: 'card_no_y' },
    { key: 'aff_date', label: 'Affiliation', sizeKey: 'aff_date_size', xKey: 'aff_date_x', yKey: 'aff_date_y' },
    { key: 'exp_date', label: 'Expiration', sizeKey: 'exp_date_size', xKey: 'exp_date_x', yKey: 'exp_date_y' },
    { key: 'qr', label: 'QR Code', sizeKey: 'qr_size', xKey: 'qr_x', yKey: 'qr_y' }
];

const BROKER_FRONT_FIELDS = [
    { key: 'name', label: 'اسم الدلال', sizeKey: 'name_size', xKey: 'name_x', yKey: 'name_y' },
    { key: 'class', label: 'الصنف', sizeKey: 'class_size', xKey: 'class_x', yKey: 'class_y' },
    { key: 'comm', label: 'الاسم التجاري (المكتب)', sizeKey: 'comm_size', xKey: 'comm_x', yKey: 'comm_y' },
    { key: 'activity', label: 'النشاط', sizeKey: 'activity_size', xKey: 'activity_x', yKey: 'activity_y' },
    { key: 'card_no', label: 'رقم الهوية (الشريط)', sizeKey: 'card_no_size', xKey: 'card_no_x', yKey: 'card_no_y' },
    { key: 'aff_date', label: 'الانتساب', sizeKey: 'aff_date_size', xKey: 'aff_date_x', yKey: 'aff_date_y' },
    { key: 'exp_date', label: 'النفاذ', sizeKey: 'exp_date_size', xKey: 'exp_date_x', yKey: 'exp_date_y' }
];

const BROKER_BACK_FIELDS = [
    { key: 'name', label: 'Name (الاسم)', sizeKey: 'name_size', xKey: 'name_x', yKey: 'name_y' },
    { key: 'class', label: 'Class', sizeKey: 'class_size', xKey: 'class_x', yKey: 'class_y' },
    { key: 'comm_no', label: 'Commercial Name No', sizeKey: 'comm_no_size', xKey: 'comm_no_x', yKey: 'comm_no_y' },
    { key: 'activity', label: 'Activity', sizeKey: 'activity_size', xKey: 'activity_x', yKey: 'activity_y' },
    { key: 'card_no', label: 'ID No (الرقم)', sizeKey: 'card_no_size', xKey: 'card_no_x', yKey: 'card_no_y' },
    { key: 'aff_date', label: 'Affiliation', sizeKey: 'aff_date_size', xKey: 'aff_date_x', yKey: 'aff_date_y' },
    { key: 'exp_date', label: 'Expiration', sizeKey: 'exp_date_size', xKey: 'exp_date_x', yKey: 'exp_date_y' },
    { key: 'qr', label: 'QR Code', sizeKey: 'qr_size', xKey: 'qr_x', yKey: 'qr_y' }
];

const DEFAULT_COMPANY_TYPOGRAPHY = {
    front: {
        comp_size: 26, comp_x: 900, comp_y: 285,
        ceo_size: 24, ceo_x: 815, ceo_y: 338,
        class_act_size: 24, class_act_x: 775, class_act_y: 385,
        cert_size: 24, cert_x: 725, cert_y: 435,
        comm_date_size: 24, comm_date_x: 800, comm_date_y: 485,
        card_no_size: 30, card_no_x: 845, card_no_y: 560,
        aff_date_size: 23, aff_date_x: 885, aff_date_y: 626,
        exp_date_size: 23, exp_date_x: 465, exp_date_y: 626
    },
    back: {
        comp_en_size: 36, comp_en_x: 195, comp_en_y: 322,
        ceo_en_size: 33, ceo_en_x: 105, ceo_en_y: 364,
        class_act_en_size: 33, class_act_en_x: 272, class_act_en_y: 410,
        license_en_size: 33, license_en_x: 215, license_en_y: 461,
        comm_no_size: 33, comm_no_x: 398, comm_no_y: 502,
        card_no_size: 30, card_no_x: 125, card_no_y: 560,
        aff_date_size: 28, aff_date_x: 170, aff_date_y: 630,
        exp_date_size: 29, exp_date_x: 649, exp_date_y: 629,
        qr_x: 754, qr_y: 212, qr_size: 234
    }
};

const DEFAULT_BROKER_TYPOGRAPHY = {
    front: {
        name_size: 28, name_x: 910, name_y: 308,
        class_size: 26, class_x: 898, class_y: 368,
        comm_size: 24, comm_x: 800, comm_y: 432,
        activity_size: 24, activity_x: 898, activity_y: 496,
        card_no_size: 30, card_no_x: 860, card_no_y: 560,
        aff_date_size: 23, aff_date_x: 898, aff_date_y: 630,
        exp_date_size: 23, exp_date_x: 470, exp_date_y: 630
    },
    back: {
        name_size: 28, name_x: 130, name_y: 308,
        class_size: 28, class_x: 120, class_y: 368,
        comm_no_size: 28, comm_no_x: 395, comm_no_y: 425,
        activity_size: 28, activity_x: 165, activity_y: 478,
        card_no_size: 30, card_no_x: 125, card_no_y: 560,
        aff_date_size: 24, aff_date_x: 170, aff_date_y: 625,
        exp_date_size: 24, exp_date_x: 735, exp_date_y: 625,
        qr_x: 758, qr_y: 207, qr_size: 238
    }
};

const DEFAULT_TYPOGRAPHY = {
    front: {
        name_size: 28, name_x: 900, name_y: 308,
        class_size: 26, class_x: 890, class_y: 366,
        comm_size: 24, comm_x: 795, comm_y: 432,
        activity_size: 24, activity_x: 885, activity_y: 490,
        card_no_size: 30, card_no_x: 845, card_no_y: 560,
        aff_date_size: 23, aff_date_x: 885, aff_date_y: 626,
        exp_date_size: 23, exp_date_x: 465, exp_date_y: 626
    },
    back: {
        name_size: 26, name_x: 14, name_y: 305,
        class_size: 24, class_x: 118, class_y: 368,
        comm_no_size: 24, comm_no_x: 390, comm_no_y: 423,
        activity_size: 22, activity_x: 165, activity_y: 474,
        card_no_size: 30, card_no_x: 125, card_no_y: 560,
        aff_date_size: 22, aff_date_x: 170, aff_date_y: 620,
        exp_date_size: 22, exp_date_x: 735, exp_date_y: 620,
        qr_x: 757, qr_y: 210, qr_size: 238
    }
};

function entoar(str) {
    if (!str) return '';
    return String(str).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
}

function formatClassName(cardClass, lang = 'ar') {
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

function loadImage(src) {
    if (!src) return Promise.resolve(null);
    if (RESOLVED_IMAGE_CACHE.has(src)) {
        return Promise.resolve(RESOLVED_IMAGE_CACHE.get(src));
    }
    if (IMAGE_PROMISE_CACHE.has(src)) {
        return IMAGE_PROMISE_CACHE.get(src);
    }

    const p = new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            // Keep cache bounded for dynamic data URLs while retaining templates permanently
            if (RESOLVED_IMAGE_CACHE.size > 120) {
                for (const k of RESOLVED_IMAGE_CACHE.keys()) {
                    if (!k.startsWith('/templates/')) {
                        RESOLVED_IMAGE_CACHE.delete(k);
                        IMAGE_PROMISE_CACHE.delete(k);
                        break;
                    }
                }
            }
            RESOLVED_IMAGE_CACHE.set(src, img);
            resolve(img);
        };
        img.onerror = () => {
            IMAGE_PROMISE_CACHE.delete(src);
            if (src !== '/templates/avatar_placeholder.png') {
                loadImage('/templates/avatar_placeholder.png').then(fallbackImg => {
                    RESOLVED_IMAGE_CACHE.set(src, fallbackImg);
                    resolve(fallbackImg);
                });
            } else {
                resolve(null);
            }
        };
        img.src = src;
    });

    IMAGE_PROMISE_CACHE.set(src, p);
    return p;
}

async function ensureFonts() {
    if (fontsLoadedOnce) return;
    if (fontsLoadPromise) return fontsLoadPromise;
    fontsLoadPromise = (async () => {
        try {
            await Promise.all([
                document.fonts.load('bold 28px "PT Bold Heading"'),
                document.fonts.load('bold 24px "Myriad Pro"')
            ]);
            fontsLoadedOnce = true;
        } catch (e) {
            fontsLoadedOnce = true;
        }
    })();
    return fontsLoadPromise;
}

function drawAutoFitText(ctx, text, x, y, maxBoundary, isRtl = false) {
    if (!text) return 1.0;

    const availableWidth = Math.max(50, isRtl ? (x - maxBoundary) : (maxBoundary - x));

    ctx.save();
    let measuredWidth = ctx.measureText(text).width;

    if (!isRtl && measuredWidth > availableWidth && 'letterSpacing' in ctx) {
        ctx.letterSpacing = '-0.5px';
        measuredWidth = ctx.measureText(text).width;
    }

    const scaleX = measuredWidth > availableWidth ? (availableWidth / measuredWidth) : 1.0;

    if (scaleX >= 0.995) {
        ctx.fillText(text, x, y);
    } else {
        ctx.translate(x, y);
        ctx.scale(scaleX, 1);
        ctx.fillText(text, 0, 0);
    }
    ctx.restore();
    return scaleX;
}

function drawCardFrontSync(canvas, trader, bg, photo) {
    if (!canvas || !trader) return;
    const isComp = trader.member_type === 'company';
    const isBroker = trader.member_type === 'broker';
    const fallbackDefaults = isComp
        ? DEFAULT_COMPANY_TYPOGRAPHY
        : (isBroker ? DEFAULT_BROKER_TYPOGRAPHY : DEFAULT_TYPOGRAPHY);
    const s = (activeCardTypography && activeCardTypography.front)
        ? activeCardTypography.front
        : ((globalTypography && globalTypography.front) ? globalTypography.front : fallbackDefaults.front);

    const ctx = canvas.getContext('2d');
    if (canvas.width !== 1024) canvas.width = 1024;
    if (canvas.height !== 644) canvas.height = 644;
    ctx.clearRect(0, 0, 1024, 644);

    if (bg) ctx.drawImage(bg, 0, 0, 1024, 644);

    const boxX = 14, boxY = 266, boxW = 274, boxH = 354, radius = 24;
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

    ctx.save();
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#000000';

    if (isComp) {
        const photoLeftMargin = 295;
        ctx.font = `bold ${s.comp_size || 26}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, trader.company_name || trader.commercial_name || trader.name || '', s.comp_x || 900, s.comp_y || 285, photoLeftMargin, true);

        ctx.font = `bold ${s.ceo_size || 24}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, trader.ceo_name || trader.name || '', s.ceo_x || 815, s.ceo_y || 338, photoLeftMargin, true);

        ctx.font = `bold ${s.class_act_size || 24}px "PT Bold Heading", sans-serif`;
        const classAct = formatClassName(trader.card_class, 'ar') + ' / ' + (trader.activity || '-');
        drawAutoFitText(ctx, classAct, s.class_act_x || 775, s.class_act_y || 385, photoLeftMargin, true);

        ctx.font = `bold ${s.cert_size || 24}px "PT Bold Heading", sans-serif`;
        let cert = trader.incorporation_certificate_no ? entoar(trader.incorporation_certificate_no) : '-';
        if (trader.incorporation_certificate_symbol) cert += ' (' + trader.incorporation_certificate_symbol + ')';
        drawAutoFitText(ctx, cert, s.cert_x || 725, s.cert_y || 435, photoLeftMargin, true);

        ctx.font = `bold ${s.comm_date_size || 24}px "PT Bold Heading", sans-serif`;
        const commNo = trader.commercial_name_no ? entoar(trader.commercial_name_no) : (trader.commercial_name || '-');
        const compCommX = (s.comm_date_x && s.comm_date_x !== 695) ? s.comm_date_x : 800;
        drawAutoFitText(ctx, commNo, compCommX, s.comm_date_y || 485, photoLeftMargin, true);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${s.card_no_size || 30}px "PT Bold Heading", sans-serif`;
        let cardText = entoar(trader.card_no);
        if (trader.renewal_no) cardText += ' / ' + entoar(trader.renewal_no);
        ctx.fillText(cardText, s.card_no_x || 845, s.card_no_y || 560);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${s.aff_date_size || 23}px "PT Bold Heading", sans-serif`;
        ctx.fillText(entoar(trader.affiliation_date || ''), s.aff_date_x || 885, s.aff_date_y || 626);
        ctx.font = `bold ${s.exp_date_size || 23}px "PT Bold Heading", sans-serif`;
        ctx.fillText(entoar(trader.expire_date || ''), s.exp_date_x || 465, s.exp_date_y || 626);
    } else if (isBroker) {
        const photoLeftBroker = 295;
        ctx.font = `bold ${s.name_size || 28}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, trader.name || '', s.name_x || 910, s.name_y || 308, photoLeftBroker, true);

        ctx.font = `bold ${s.class_size || 26}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, 'دلالية', s.class_x || 898, s.class_y || 368, photoLeftBroker, true);

        ctx.font = `bold ${s.comm_size || 24}px "PT Bold Heading", sans-serif`;
        let commText = trader.commercial_name || '';
        if (trader.commercial_name_no) commText += ' / ' + entoar(trader.commercial_name_no);
        drawAutoFitText(ctx, commText, s.comm_x || 800, s.comm_y || 432, photoLeftBroker, true);

        ctx.font = `bold ${s.activity_size || 24}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, trader.activity || 'دلالية العقارات', s.activity_x || 898, s.activity_y || 496, photoLeftBroker, true);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${s.card_no_size || 30}px "PT Bold Heading", sans-serif`;
        let cardText = entoar(trader.card_no);
        if (trader.renewal_no) cardText += ' / ' + entoar(trader.renewal_no);
        ctx.fillText(cardText, s.card_no_x || 860, s.card_no_y || 560);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${s.aff_date_size || 23}px "PT Bold Heading", sans-serif`;
        ctx.fillText(entoar(trader.affiliation_date || ''), s.aff_date_x || 898, s.aff_date_y || 630);
        ctx.font = `bold ${s.exp_date_size || 23}px "PT Bold Heading", sans-serif`;
        ctx.fillText(entoar(trader.expire_date || ''), s.exp_date_x || 470, s.exp_date_y || 630);
    } else {
        const photoLeftTrader = 295;
        ctx.font = `bold ${s.name_size || 28}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, trader.name || '', s.name_x, s.name_y, photoLeftTrader, true);

        ctx.font = `bold ${s.class_size || 26}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, formatClassName(trader.card_class, 'ar'), s.class_x, s.class_y, photoLeftTrader, true);

        ctx.font = `bold ${s.comm_size || 24}px "PT Bold Heading", sans-serif`;
        let commText = trader.commercial_name || '';
        if (trader.commercial_name_no) commText += ' / ' + entoar(trader.commercial_name_no);
        drawAutoFitText(ctx, commText, s.comm_x, s.comm_y, photoLeftTrader, true);

        ctx.font = `bold ${s.activity_size || 24}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, trader.activity || '', s.activity_x, s.activity_y, photoLeftTrader, true);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${s.card_no_size || 30}px "PT Bold Heading", sans-serif`;
        let cardText = entoar(trader.card_no);
        if (trader.renewal_no) cardText += ' / ' + entoar(trader.renewal_no);
        ctx.fillText(cardText, s.card_no_x, s.card_no_y);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${s.aff_date_size || 23}px "PT Bold Heading", sans-serif`;
        ctx.fillText(entoar(trader.affiliation_date || ''), s.aff_date_x, s.aff_date_y);
        ctx.font = `bold ${s.exp_date_size || 23}px "PT Bold Heading", sans-serif`;
        ctx.fillText(entoar(trader.expire_date || ''), s.exp_date_x, s.exp_date_y);
    }

    ctx.restore();
}

function drawCardBackSync(canvas, trader, bg, qrImg) {
    if (!canvas || !trader) return;
    const isComp = trader.member_type === 'company';
    const isBroker = trader.member_type === 'broker';
    const fallbackDefaults = isComp
        ? DEFAULT_COMPANY_TYPOGRAPHY
        : (isBroker ? DEFAULT_BROKER_TYPOGRAPHY : DEFAULT_TYPOGRAPHY);
    const s = (activeCardTypography && activeCardTypography.back)
        ? activeCardTypography.back
        : ((globalTypography && globalTypography.back) ? globalTypography.back : fallbackDefaults.back);

    const ctx = canvas.getContext('2d');
    if (canvas.width !== 1024) canvas.width = 1024;
    if (canvas.height !== 644) canvas.height = 644;
    ctx.clearRect(0, 0, 1024, 644);

    if (bg) ctx.drawImage(bg, 0, 0, 1024, 644);

    if (qrImg) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(s.qr_x || 758, s.qr_y || 207, s.qr_size || 238, s.qr_size || 238);
        ctx.drawImage(qrImg, s.qr_x || 758, s.qr_y || 207, s.qr_size || 238, s.qr_size || 238);
    }

    ctx.save();
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#000000';

    if (isComp) {
        const qrLeft = (s.qr_x || 754) - 6;
        ctx.font = `bold ${s.comp_en_size || 36}px "Myriad Pro", Arial, sans-serif`;
        const compEn = (trader.english_company_name || trader.company_name || '').toUpperCase();
        drawAutoFitText(ctx, compEn, s.comp_en_x || 195, s.comp_en_y || 322, qrLeft);

        ctx.font = `bold ${s.ceo_en_size || 33}px "Myriad Pro", Arial, sans-serif`;
        const ceoEn = (trader.english_ceo_name || trader.english_name || trader.ceo_name || trader.name || '').toUpperCase();
        drawAutoFitText(ctx, ceoEn, s.ceo_en_x || 105, s.ceo_en_y || 364, qrLeft);

        ctx.font = `bold ${s.class_act_en_size || 33}px "Myriad Pro", Arial, sans-serif`;
        const enAct = trader.english_activity || trader.activity || '-';
        const classActEn = formatClassName(trader.card_class, 'en') + ' / ' + enAct;
        drawAutoFitText(ctx, classActEn, s.class_act_en_x || 272, s.class_act_en_y || 410, qrLeft);

        ctx.font = `bold ${s.license_en_size || 33}px "Myriad Pro", Arial, sans-serif`;
        let licText = trader.incorporation_certificate_no || '-';
        if (trader.incorporation_certificate_symbol) licText += ' (' + trader.incorporation_certificate_symbol + ')';
        drawAutoFitText(ctx, licText, s.license_en_x || 215, s.license_en_y || 461, qrLeft);

        ctx.font = `bold ${s.comm_no_size || 33}px "Myriad Pro", Arial, sans-serif`;
        drawAutoFitText(ctx, trader.commercial_name_no || '-', s.comm_no_x || 398, s.comm_no_y || 502, qrLeft);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${s.card_no_size || 30}px "Myriad Pro", Arial, sans-serif`;
        let enCard = trader.card_no || '';
        if (trader.renewal_no) enCard += ' / ' + trader.renewal_no;
        ctx.fillText(enCard, s.card_no_x || 125, s.card_no_y || 560);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${s.aff_date_size || 28}px "Myriad Pro", Arial, sans-serif`;
        ctx.fillText(trader.affiliation_date || '-', s.aff_date_x || 170, s.aff_date_y || 630);
        ctx.font = `bold ${s.exp_date_size || 29}px "Myriad Pro", Arial, sans-serif`;
        ctx.fillText(trader.expire_date || '-', s.exp_date_x || 649, s.exp_date_y || 629);
    } else if (isBroker) {
        const qrLeftBroker = (s.qr_x || 758) - 6;
        ctx.font = `bold ${s.name_size || 28}px "Myriad Pro", Arial, sans-serif`;
        const enName = (trader.english_name || trader.name || '').toUpperCase();
        drawAutoFitText(ctx, enName, s.name_x || 130, s.name_y || 308, qrLeftBroker);

        ctx.font = `bold ${s.class_size || 28}px "Myriad Pro", Arial, sans-serif`;
        drawAutoFitText(ctx, formatClassName(trader.card_class, 'en'), s.class_x || 120, s.class_y || 368, qrLeftBroker);

        ctx.font = `bold ${s.comm_no_size || 28}px "Myriad Pro", Arial, sans-serif`;
        drawAutoFitText(ctx, trader.commercial_name_no || '-', s.comm_no_x || 395, s.comm_no_y || 425, qrLeftBroker);

        ctx.font = `bold ${s.activity_size || 28}px "Myriad Pro", Arial, sans-serif`;
        const enAct = trader.english_activity || 'Real Estates BROKER';
        drawAutoFitText(ctx, enAct, s.activity_x || 165, s.activity_y || 478, qrLeftBroker);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${s.card_no_size || 30}px "Myriad Pro", Arial, sans-serif`;
        let enCard = trader.card_no || '';
        if (trader.renewal_no) enCard += ' / ' + trader.renewal_no;
        ctx.fillText(enCard, s.card_no_x || 125, s.card_no_y || 560);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${s.aff_date_size || 24}px "Myriad Pro", Arial, sans-serif`;
        ctx.fillText(trader.affiliation_date || '-', s.aff_date_x || 170, s.aff_date_y || 625);
        ctx.font = `bold ${s.exp_date_size || 24}px "Myriad Pro", Arial, sans-serif`;
        ctx.fillText(trader.expire_date || '-', s.exp_date_x || 735, s.exp_date_y || 625);
    } else {
        const qrLeftTrader = (s.qr_x || 757) - 6;
        const nameSize = s.name_size !== undefined ? s.name_size : 36;
        const nameX = s.name_x !== undefined ? s.name_x : 14;
        const nameY = s.name_y !== undefined ? s.name_y : 305;
        ctx.font = `bold ${nameSize}px "Myriad Pro", Arial, sans-serif`;
        const enName = (trader.english_name || trader.name || '').toUpperCase();
        drawAutoFitText(ctx, enName, nameX, nameY, qrLeftTrader);

        ctx.font = `bold ${s.class_size || 36}px "Myriad Pro", Arial, sans-serif`;
        drawAutoFitText(ctx, formatClassName(trader.card_class, 'en'), s.class_x, s.class_y, qrLeftTrader);

        ctx.font = `bold ${s.comm_no_size || 36}px "Myriad Pro", Arial, sans-serif`;
        drawAutoFitText(ctx, trader.commercial_name_no || '-', s.comm_no_x, s.comm_no_y, qrLeftTrader);

        ctx.font = `bold ${s.activity_size || 36}px "Myriad Pro", Arial, sans-serif`;
        const enTraderAct = trader.english_activity || trader.activity || '-';
        drawAutoFitText(ctx, enTraderAct, s.activity_x, s.activity_y, qrLeftTrader);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${s.card_no_size || 34}px "Myriad Pro", Arial, sans-serif`;
        let enCard = trader.card_no || '';
        if (trader.renewal_no) enCard += ' / ' + trader.renewal_no;
        ctx.fillText(enCard, s.card_no_x, s.card_no_y);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${s.aff_date_size || 27}px "Myriad Pro", Arial, sans-serif`;
        ctx.fillText(trader.affiliation_date || '-', s.aff_date_x, s.aff_date_y);
        ctx.font = `bold ${s.exp_date_size || 28}px "Myriad Pro", Arial, sans-serif`;
        ctx.fillText(trader.expire_date || '-', s.exp_date_x, s.exp_date_y);
    }

    ctx.restore();
}

function getFrontTemplatePath(trader) {
    if (trader && trader.member_type === 'company') return '/templates/company_front_clean.png?v=3';
    if (trader && trader.member_type === 'broker') return '/templates/broker_front_clean.png?v=3';
    return '/templates/card_front_template.png?v=3';
}

function getBackTemplatePath(trader) {
    if (trader && trader.member_type === 'company') return '/templates/company_back_clean.png';
    if (trader && trader.member_type === 'broker') return '/templates/broker_back_clean.png';
    return '/templates/card_back_clean.png';
}

async function renderCardFront(canvas, trader) {
    const tplPath = getFrontTemplatePath(trader);
    const photoSrc = trader.photo_path || '/templates/avatar_placeholder.png';
    const [, bg, photo] = await Promise.all([
        ensureFonts(),
        loadImage(tplPath),
        loadImage(photoSrc)
    ]);
    drawCardFrontSync(canvas, trader, bg, photo);
}

async function renderCardBack(canvas, trader, qrDataUrl) {
    const tplPath = getBackTemplatePath(trader);
    const [, bg, qrImg] = await Promise.all([
        ensureFonts(),
        loadImage(tplPath),
        qrDataUrl ? loadImage(qrDataUrl) : Promise.resolve(null)
    ]);
    drawCardBackSync(canvas, trader, bg, qrImg);
}

function getActiveFieldDef() {
    const isComp = currentTrader && currentTrader.member_type === 'company';
    const isBroker = currentTrader && currentTrader.member_type === 'broker';
    let list;
    if (isComp) {
        list = currentModalSide === 'front' ? COMPANY_FRONT_FIELDS : COMPANY_BACK_FIELDS;
    } else if (isBroker) {
        list = currentModalSide === 'front' ? BROKER_FRONT_FIELDS : BROKER_BACK_FIELDS;
    } else {
        list = currentModalSide === 'front' ? MODAL_FRONT_FIELDS : MODAL_BACK_FIELDS;
    }
    return list.find(f => f.key === activeModalFieldKey) || list[0];
}

function populateModalFieldPills() {
    const container = document.getElementById('modalFieldPills');
    if (!container) return;
    container.innerHTML = '';
    const isComp = currentTrader && currentTrader.member_type === 'company';
    const isBroker = currentTrader && currentTrader.member_type === 'broker';
    const fields = isComp
        ? (currentModalSide === 'front' ? COMPANY_FRONT_FIELDS : COMPANY_BACK_FIELDS)
        : (isBroker
            ? (currentModalSide === 'front' ? BROKER_FRONT_FIELDS : BROKER_BACK_FIELDS)
            : (currentModalSide === 'front' ? MODAL_FRONT_FIELDS : MODAL_BACK_FIELDS));

    if (!fields.find(f => f.key === activeModalFieldKey)) {
        activeModalFieldKey = fields[0].key;
    }

    fields.forEach(f => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `field-pill ${f.key === activeModalFieldKey ? 'active-pill' : ''}`;
        btn.innerText = f.label;
        btn.onclick = () => selectModalField(f.key);
        container.appendChild(btn);
    });

    syncActiveFieldInputs();
}

function selectModalField(key) {
    activeModalFieldKey = key;
    populateModalFieldPills();
}

function syncActiveFieldInputs() {
    if (!activeCardTypography) return;
    const fDef = getActiveFieldDef();
    const side = currentModalSide;
    const s = activeCardTypography[side];

    const sizeVal = s[fDef.sizeKey] || 24;
    const xVal = s[fDef.xKey] || 0;
    const yVal = s[fDef.yKey] || 0;

    document.getElementById('mActiveSizeBadge').innerText = sizeVal + 'px';
    document.getElementById('mActiveSizeSlider').value = sizeVal;
    document.getElementById('mActiveXVal').innerText = xVal;
    document.getElementById('mActiveYVal').innerText = yVal;
    document.getElementById('mDirectInputX').value = xVal;
    document.getElementById('mDirectInputY').value = yVal;
}

// 60 FPS Zero-Lag Synchronous Redraw when dragging sliders or pressing arrows
function redrawModalCanvas() {
    if (!currentTrader) return;
    if (redrawRafId) cancelAnimationFrame(redrawRafId);
    redrawRafId = requestAnimationFrame(() => {
        redrawRafId = null;
        if (!currentTrader) return;
        if (currentModalSide === 'front') {
            const tplPath = getFrontTemplatePath(currentTrader);
            const photoSrc = currentTrader.photo_path || '/templates/avatar_placeholder.png';
            if (RESOLVED_IMAGE_CACHE.has(tplPath) && RESOLVED_IMAGE_CACHE.has(photoSrc)) {
                drawCardFrontSync(
                    document.getElementById('frontCanvas'),
                    currentTrader,
                    RESOLVED_IMAGE_CACHE.get(tplPath),
                    RESOLVED_IMAGE_CACHE.get(photoSrc)
                );
            } else {
                renderCardFront(document.getElementById('frontCanvas'), currentTrader);
            }
        } else {
            const tplPath = getBackTemplatePath(currentTrader);
            const hasQr = !currentModalQrUrl || RESOLVED_IMAGE_CACHE.has(currentModalQrUrl);
            if (RESOLVED_IMAGE_CACHE.has(tplPath) && hasQr) {
                drawCardBackSync(
                    document.getElementById('backCanvas'),
                    currentTrader,
                    RESOLVED_IMAGE_CACHE.get(tplPath),
                    currentModalQrUrl ? RESOLVED_IMAGE_CACHE.get(currentModalQrUrl) : null
                );
            } else {
                renderCardBack(document.getElementById('backCanvas'), currentTrader, currentModalQrUrl);
            }
        }
    });
}

function onModalSliderChange(val) {
    if (!activeCardTypography) return;
    const fDef = getActiveFieldDef();
    const side = currentModalSide;
    const num = parseInt(val) || 24;

    activeCardTypography[side][fDef.sizeKey] = num;
    document.getElementById('mActiveSizeBadge').innerText = num + 'px';

    redrawModalCanvas();
}

function modalNudgeSize(delta) {
    if (!activeCardTypography) return;
    const fDef = getActiveFieldDef();
    const side = currentModalSide;
    const cur = activeCardTypography[side][fDef.sizeKey] || 24;
    const nextVal = Math.max(12, Math.min(60, cur + delta));

    activeCardTypography[side][fDef.sizeKey] = nextVal;
    document.getElementById('mActiveSizeBadge').innerText = nextVal + 'px';
    document.getElementById('mActiveSizeSlider').value = nextVal;

    redrawModalCanvas();
}

function modalNudgePos(axis, delta) {
    if (!activeCardTypography) return;
    const fDef = getActiveFieldDef();
    const side = currentModalSide;
    const key = axis === 'x' ? fDef.xKey : fDef.yKey;
    const cur = activeCardTypography[side][key] || 0;
    const nextVal = cur + delta;

    activeCardTypography[side][key] = nextVal;

    if (axis === 'x') {
        document.getElementById('mActiveXVal').innerText = nextVal;
        document.getElementById('mDirectInputX').value = nextVal;
    } else {
        document.getElementById('mActiveYVal').innerText = nextVal;
        document.getElementById('mDirectInputY').value = nextVal;
    }

    redrawModalCanvas();
}

function onModalDirectInputChange(axis, val) {
    if (!activeCardTypography) return;
    const fDef = getActiveFieldDef();
    const side = currentModalSide;
    const key = axis === 'x' ? fDef.xKey : fDef.yKey;
    const num = parseInt(val) || 0;

    activeCardTypography[side][key] = num;
    if (axis === 'x') {
        document.getElementById('mActiveXVal').innerText = num;
    } else {
        document.getElementById('mActiveYVal').innerText = num;
    }

    redrawModalCanvas();
}

async function saveTraderCustomTypography() {
    if (!currentTrader) return;
    try {
        const res = await fetch(`/api/traders/${encodeURIComponent(currentTrader.uuid || currentTrader.id)}/typography`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ typography: activeCardTypography })
        });
        const j = await res.json();
        if (j.success) {
            currentTrader.custom_typography = JSON.stringify(activeCardTypography);
            const label = currentTrader.member_type === 'company' ? 'هذه الشركة' : (currentTrader.member_type === 'broker' ? 'هذا الدلال' : 'هذا التاجر');
            alert(`تم حفظ إعدادات الخط والمواقع المخصصة لـ (${label}) بنجاح!`);
        } else {
            alert('Error: ' + j.error);
        }
    } catch (e) {
        alert('Network error: ' + e.message);
    }
}

async function resetTraderCustomTypography() {
    if (!currentTrader) return;
    if (!confirm('هل تريد استعادة إعدادات الخط العامة لهذا السجل؟')) return;
    try {
        await fetch(`/api/traders/${encodeURIComponent(currentTrader.uuid || currentTrader.id)}/typography/reset`, { method: 'POST' });
        const isComp = currentTrader.member_type === 'company';
        const isBroker = currentTrader.member_type === 'broker';
        const fallback = isComp ? DEFAULT_COMPANY_TYPOGRAPHY : (isBroker ? DEFAULT_BROKER_TYPOGRAPHY : DEFAULT_TYPOGRAPHY);
        currentTrader.custom_typography = null;
        activeCardTypography = JSON.parse(JSON.stringify(globalTypography || fallback));
        populateModalFieldPills();
        redrawModalCanvas();
        alert('تمت استعادة الإعدادات العامة للبطاقة!');
    } catch (e) {
        alert('Network error: ' + e.message);
    }
}

async function openPrintModal(traderId, uuid) {
    const token = ++modalRequestToken;
    const modalEl = document.getElementById('printModal');
    const fCanvas = document.getElementById('frontCanvas');
    const bCanvas = document.getElementById('backCanvas');

    // Open modal shell immediately (< 5ms) so UI feels instant!
    document.getElementById('modalTitle').innerText = 'جاري تجهيز الهوية...';
    modalEl.style.display = 'block';
    modalEl.classList.remove('hidden');

    try {
        const targetId = encodeURIComponent(uuid || traderId);
        const res = await fetch('/api/traders/' + targetId + '?bundle=1');
        const json = await res.json();
        if (token !== modalRequestToken) return;
        if (!json.success || !json.trader) {
            closePrintModal();
            return;
        }

        currentTrader = json.trader;
        const isComp = currentTrader.member_type === 'company';
        const isBroker = currentTrader.member_type === 'broker';
        const fallback = isComp ? DEFAULT_COMPANY_TYPOGRAPHY : (isBroker ? DEFAULT_BROKER_TYPOGRAPHY : DEFAULT_TYPOGRAPHY);

        globalTypography = json.globalTypography || GLOBAL_TYPO_CACHE.get(currentTrader.member_type || 'trader') || fallback;
        GLOBAL_TYPO_CACHE.set(currentTrader.member_type || 'trader', globalTypography);
        currentModalQrUrl = json.qr_url || null;

        const titlePrefix = isComp ? 'Print Company ID: ' : (isBroker ? 'Print Broker ID: ' : 'Print Trader ID: ');
        const displayName = isComp ? (currentTrader.company_name || currentTrader.commercial_name || currentTrader.name) : currentTrader.name;
        document.getElementById('modalTitle').innerText = titlePrefix + displayName + ' (' + currentTrader.card_no + ')';
        document.getElementById('verifyLink').href = '/traders/validate/' + encodeURIComponent(currentTrader.uuid);
        const btnSave = document.getElementById('btnTraderSaveTypo');
        if (btnSave) btnSave.innerText = isComp ? '💾 حفظ خاص للشركة' : (isBroker ? '💾 حفظ خاص للدلال' : '💾 حفظ خاص للتاجر');

        if (currentTrader.custom_typography) {
            try {
                activeCardTypography = JSON.parse(currentTrader.custom_typography);
            } catch (e) {
                activeCardTypography = JSON.parse(JSON.stringify(globalTypography || fallback));
            }
        } else {
            activeCardTypography = JSON.parse(JSON.stringify(globalTypography || fallback));
        }

        switchCardSide('front');

        // Render Front & Back concurrently (Front paints as soon as photo loads)
        await Promise.all([
            renderCardFront(fCanvas, currentTrader),
            renderCardBack(bCanvas, currentTrader, currentModalQrUrl)
        ]);
    } catch (e) {
        if (token === modalRequestToken) {
            alert('Error loading card: ' + e.message);
        }
    }
}

function closePrintModal() {
    modalRequestToken++;
    const modalEl = document.getElementById('printModal');
    if (modalEl) {
        modalEl.style.display = 'none';
        modalEl.classList.add('hidden');
    }
    currentTrader = null;
    activeCardTypography = null;
}

function switchCardSide(side) {
    currentModalSide = side;
    const fCanvas = document.getElementById('frontCanvas');
    const bCanvas = document.getElementById('backCanvas');
    const btnF = document.getElementById('btnFront');
    const btnB = document.getElementById('btnBack');

    if (side === 'front') {
        fCanvas.style.display = 'block';
        bCanvas.style.display = 'none';
        btnF.className = 'card-side-btn active-side';
        btnB.className = 'card-side-btn';
    } else {
        fCanvas.style.display = 'none';
        bCanvas.style.display = 'block';
        btnB.className = 'card-side-btn active-side';
        btnF.className = 'card-side-btn';
    }
    populateModalFieldPills();
}

function triggerWindowPrintWhenReady(win) {
    const imgs = Array.from(win.document.images || []);
    const readyPromises = imgs.map(img => {
        if (img.complete) return Promise.resolve();
        if (typeof img.decode === 'function') return img.decode().catch(() => {});
        return new Promise(res => {
            img.onload = res;
            img.onerror = res;
        });
    });

    Promise.all(readyPromises).then(() => {
        requestAnimationFrame(() => {
            try {
                win.focus();
                win.print();
            } catch (err) {
                console.warn('Print trigger error:', err);
            }
        });
    });
}

function printHtmlContent(htmlContent) {
    let printWin = null;
    try {
        printWin = window.open('', '_blank');
    } catch (e) {}

    if (printWin) {
        try {
            printWin.document.open();
            printWin.document.write(htmlContent);
            printWin.document.close();
            triggerWindowPrintWhenReady(printWin);
            return;
        } catch (e) {
            console.warn('Popup write failed, falling back to iframe:', e);
        }
    }

    try {
        let iframe = document.getElementById('cardPrintHiddenIframe');
        if (!iframe) {
            iframe = document.createElement('iframe');
            iframe.id = 'cardPrintHiddenIframe';
            iframe.style.position = 'fixed';
            iframe.style.right = '0';
            iframe.style.bottom = '0';
            iframe.style.width = '0';
            iframe.style.height = '0';
            iframe.style.border = '0';
            document.body.appendChild(iframe);
        }
        const doc = iframe.contentWindow.document;
        doc.open();
        doc.write(htmlContent);
        doc.close();
        triggerWindowPrintWhenReady(iframe.contentWindow);
    } catch (e) {
        console.error('All print methods failed:', e);
    }
}

async function ensureBothCanvasesReady() {
    const fCanvas = document.getElementById('frontCanvas');
    const bCanvas = document.getElementById('backCanvas');
    if (currentTrader) {
        await Promise.all([
            renderCardFront(fCanvas, currentTrader),
            renderCardBack(bCanvas, currentTrader, currentModalQrUrl)
        ]);
    }
    return { fCanvas, bCanvas };
}

async function printCR80(side = 'both') {
    const { fCanvas, bCanvas } = await ensureBothCanvasesReady();
    if (!fCanvas || !bCanvas) return;

    let targetSide = side;
    if (targetSide === 'current') {
        targetSide = currentModalSide || 'front';
    }

    const fData = fCanvas.toDataURL('image/png');
    const bData = bCanvas.toDataURL('image/png');
    const rawName = currentTrader ? (currentTrader.company_name || currentTrader.commercial_name || currentTrader.name || '') : '';
    const safeName = escapeHtmlClient(rawName);

    let pagesHtml = '';
    if (targetSide === 'front') {
        pagesHtml = `<div class="card-page"><img src="${fData}" alt="Front"></div>`;
    } else if (targetSide === 'back') {
        pagesHtml = `<div class="card-page"><img src="${bData}" alt="Back"></div>`;
    } else {
        pagesHtml = `
            <div class="card-page"><img src="${fData}" alt="Front"></div>
            <div class="card-page"><img src="${bData}" alt="Back"></div>
        `;
    }

    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>CR80 Plastic Print - ${safeName}</title>
    <style>
        @page {
            size: 85.6mm 53.98mm;
            margin: 0;
        }
        @media print {
            html, body {
                margin: 0 !important;
                padding: 0 !important;
                width: 85.6mm !important;
                height: auto !important;
                overflow: visible !important;
                background: #fff !important;
            }
            .card-page {
                width: 85.6mm !important;
                height: 53.98mm !important;
                page-break-after: always !important;
                break-after: page !important;
                page-break-inside: avoid !important;
                break-inside: avoid !important;
                margin: 0 !important;
                padding: 0 !important;
                display: block !important;
                overflow: hidden !important;
                box-sizing: border-box !important;
            }
            .card-page:last-child {
                page-break-after: auto !important;
                break-after: auto !important;
            }
            img {
                width: 85.6mm !important;
                height: 53.98mm !important;
                object-fit: fill !important;
                display: block !important;
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
            }
        }
        body {
            margin: 0;
            padding: 0;
            background: #fff;
        }
        .card-page {
            width: 85.6mm;
            height: 53.98mm;
            display: block;
            margin: 0;
            padding: 0;
            page-break-after: always;
            break-after: page;
        }
        .card-page:last-child {
            page-break-after: auto;
            break-after: auto;
        }
        img {
            width: 85.6mm;
            height: 53.98mm;
            display: block;
        }
    </style>
</head>
<body>
    ${pagesHtml}
</body>
</html>`;
    printHtmlContent(html);
}

async function printA4() {
    const { fCanvas, bCanvas } = await ensureBothCanvasesReady();
    if (!fCanvas || !bCanvas) return;
    const fData = fCanvas.toDataURL('image/png');
    const bData = bCanvas.toDataURL('image/png');
    const rawName = currentTrader ? (currentTrader.company_name || currentTrader.commercial_name || currentTrader.name || '') : '';
    const safeName = escapeHtmlClient(rawName);
    const safeCardNo = escapeHtmlClient(currentTrader ? (currentTrader.card_no || '') : '');

    const html = `<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="utf-8">
    <title>A4 Card Print - ${safeName}</title>
    <style>
        @page {
            size: A4 portrait;
            margin: 15mm;
        }
        @media print {
            body {
                margin: 0 !important;
                padding: 10mm !important;
            }
        }
        body {
            font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
            text-align: center;
            margin: 0;
            padding: 20px;
            background: #fff;
        }
        h2 {
            margin: 0 0 8px 0;
            font-size: 20px;
            color: #111827;
        }
        p {
            margin: 0 0 25px 0;
            font-size: 14px;
            color: #4b5563;
        }
        .sheet {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 15mm;
            margin-top: 15px;
        }
        .box {
            width: 85.6mm;
            height: 53.98mm;
            border: 1px dashed #6b7280;
            border-radius: 3.18mm;
            overflow: hidden;
            box-sizing: border-box;
            background: #fff;
        }
        .box img {
            width: 100%;
            height: 100%;
            object-fit: fill;
            display: block;
        }
    </style>
</head>
<body>
    <h2>غرفة تجارة كربلاء المقدسة</h2>
    <p>بطاقة عضوية: <strong>${safeName}</strong> &mdash; رقم الهوية: <strong>${safeCardNo}</strong></p>
    <div class="sheet">
        <div class="box"><img src="${fData}" alt="Front"></div>
        <div class="box"><img src="${bData}" alt="Back"></div>
    </div>
</body>
</html>`;
    printHtmlContent(html);
}

function downloadImage(side) {
    if (!currentTrader) return;
    const canvas = side === 'front' ? document.getElementById('frontCanvas') : document.getElementById('backCanvas');
    const link = document.createElement('a');
    const prefix = currentTrader.member_type === 'company' ? 'Company' : (currentTrader.member_type === 'broker' ? 'Broker' : 'Card');
    link.download = `${prefix}_${currentTrader.card_no}_${side}.png`;
    link.href = canvas.toDataURL('image/png', 1.0);
    link.click();
}

// Expose functions globally for inline onclick handlers
window.openPrintModal = openPrintModal;
window.closePrintModal = closePrintModal;
window.switchCardSide = switchCardSide;
window.selectModalField = selectModalField;
window.onModalSliderChange = onModalSliderChange;
window.modalNudgeSize = modalNudgeSize;
window.modalNudgePos = modalNudgePos;
window.onModalDirectInputChange = onModalDirectInputChange;
window.saveTraderCustomTypography = saveTraderCustomTypography;
window.resetTraderCustomTypography = resetTraderCustomTypography;
window.printCR80 = printCR80;
window.printA4 = printA4;
window.downloadImage = downloadImage;

// Keyboard arrow key listener for super fast positioning!
window.addEventListener('keydown', (e) => {
    const modal = document.getElementById('printModal');
    if (!modal || modal.style.display === 'none') return;
    if (e.key === 'Escape') {
        closePrintModal();
        return;
    }
    if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    if (e.key === 'ArrowUp') {
        e.preventDefault();
        modalNudgePos('y', -2);
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        modalNudgePos('y', 2);
    } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        modalNudgePos('x', -2);
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        modalNudgePos('x', 2);
    } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        modalNudgeSize(1);
    } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        modalNudgeSize(-1);
    }
});

// ============================================================================
// Instant AJAX Delete (Zero Full-Page Reload on Delete!)
// ============================================================================
document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!form || form.tagName !== 'FORM' || e.defaultPrevented) return;
    const methodInput = form.querySelector('input[name="_method"]');
    if (!methodInput || String(methodInput.value).toLowerCase() !== 'delete') return;

    e.preventDefault();
    const rowEl = form.closest('.p-6.flex.space-x-2');
    if (rowEl) {
        rowEl.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
        rowEl.style.opacity = '0.35';
        rowEl.style.pointerEvents = 'none';
    }

    try {
        const res = await fetch(form.action, {
            method: 'DELETE',
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'fetch'
            }
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.success) {
            if (rowEl) {
                rowEl.style.opacity = '0';
                rowEl.style.transform = 'translateX(12px)';
                setTimeout(() => rowEl.remove(), 160);
            } else {
                window.location.reload();
            }
            return;
        }
    } catch (_) {}

    // Fallback to classic form submit if network/JSON failed
    if (rowEl) {
        rowEl.style.opacity = '1';
        rowEl.style.pointerEvents = '';
    }
    form.submit();
});

// ============================================================================
// Idle Background Preloader + Instant Hover Prefetching
// ============================================================================
const prefetchedUrls = new Set();
function prefetchPageUrl(href) {
    if (!href || prefetchedUrls.has(href)) return;
    if (href.includes('export/csv') || href.includes('logout') || href.startsWith('#') || href.startsWith('javascript:')) return;
    prefetchedUrls.add(href);
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = href;
    document.head.appendChild(link);
}

let hoverTimer = null;
document.addEventListener('mouseover', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.origin !== window.location.origin) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => prefetchPageUrl(a.href), 60);
}, { passive: true });

document.addEventListener('mousedown', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.origin !== window.location.origin) return;
    prefetchPageUrl(a.href);
}, { passive: true });

const scheduleIdle = window.requestIdleCallback || ((cb) => setTimeout(cb, 250));
window.addEventListener('load', () => {
    scheduleIdle(() => {
        ensureFonts();
        loadImage('/templates/avatar_placeholder.png');
        const p = window.location.pathname;
        if (p.startsWith('/companies')) {
            loadImage('/templates/company_front_clean.png?v=3');
            loadImage('/templates/company_back_clean.png');
        } else if (p.startsWith('/brokers')) {
            loadImage('/templates/broker_front_clean.png?v=3');
            loadImage('/templates/broker_back_clean.png');
        } else {
            loadImage('/templates/card_front_template.png?v=3');
            loadImage('/templates/card_back_clean.png');
        }
    });
});
