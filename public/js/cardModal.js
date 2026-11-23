// ============================================================================
// Fast Card Modal, Dual-Resolution 60-FPS Canvas Renderer
// ============================================================================
(() => {
    if (window.__cardModalLoaded) return;
    window.__cardModalLoaded = true;

let currentTrader = null;
let globalTypography = null;
let companyTypographyByRole = null;
let activeCardTypography = null;
let currentModalSide = 'front';
let currentModalQrUrl = null;
let activeModalFieldKey = 'name';
let redrawRafId = null;
let modalRequestToken = 0;
let modalReadyForPrint = false;
let pendingPrintTimer = null;

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

const COMPANY_BM_FRONT_FIELDS = [
    { key: 'comp', label: 'الشركة', sizeKey: 'comp_size', xKey: 'comp_x', yKey: 'comp_y' },
    { key: 'ceo', label: 'مدير الفرع (BM)', sizeKey: 'ceo_size', xKey: 'ceo_x', yKey: 'ceo_y' },
    { key: 'class_act', label: 'الصنف والنشاط', sizeKey: 'class_act_size', xKey: 'class_act_x', yKey: 'class_act_y' },
    { key: 'cert', label: 'إجازة التأسيس', sizeKey: 'cert_size', xKey: 'cert_x', yKey: 'cert_y' },
    { key: 'comm_date', label: 'الاسم التجاري (الرقم)', sizeKey: 'comm_date_size', xKey: 'comm_date_x', yKey: 'comm_date_y' },
    { key: 'card_no', label: 'رقم الهوية', sizeKey: 'card_no_size', xKey: 'card_no_x', yKey: 'card_no_y' },
    { key: 'aff_date', label: 'الانتساب', sizeKey: 'aff_date_size', xKey: 'aff_date_x', yKey: 'aff_date_y' },
    { key: 'exp_date', label: 'النفاذ', sizeKey: 'exp_date_size', xKey: 'exp_date_x', yKey: 'exp_date_y' }
];

const COMPANY_BM_BACK_FIELDS = [
    { key: 'comp_en', label: 'Company', sizeKey: 'comp_en_size', xKey: 'comp_en_x', yKey: 'comp_en_y' },
    { key: 'ceo_en', label: 'BM (مدير الفرع)', sizeKey: 'ceo_en_size', xKey: 'ceo_en_x', yKey: 'ceo_en_y' },
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
        comp_size: 38, comp_x: 898, comp_y: 282,
        ceo_size: 36, ceo_x: 850, ceo_y: 332,
        class_act_size: 33, class_act_x: 777, class_act_y: 378,
        cert_size: 31, cert_x: 727, cert_y: 425,
        comm_date_size: 33, comm_date_x: 803, comm_date_y: 474,
        card_no_size: 35, card_no_x: 851, card_no_y: 564,
        aff_date_size: 27, aff_date_x: 896, aff_date_y: 620,
        exp_date_size: 28, exp_date_x: 473, exp_date_y: 620
    },
    back: {
        comp_en_size: 36, comp_en_x: 192, comp_en_y: 322,
        ceo_en_size: 33, ceo_en_x: 105, ceo_en_y: 363,
        class_act_en_size: 33, class_act_en_x: 275, class_act_en_y: 410,
        license_en_size: 33, license_en_x: 214, license_en_y: 459,
        comm_no_size: 33, comm_no_x: 396, comm_no_y: 503,
        card_no_size: 32, card_no_x: 127, card_no_y: 573,
        aff_date_size: 27, aff_date_x: 174, aff_date_y: 627,
        exp_date_size: 27, exp_date_x: 636, exp_date_y: 627,
        qr_x: 753, qr_y: 216, qr_size: 237
    }
};

const DEFAULT_COMPANY_BM_TYPOGRAPHY = {
    front: {
        comp_size: 38, comp_x: 898, comp_y: 282,
        ceo_size: 36, ceo_x: 842, ceo_y: 332,
        class_act_size: 33, class_act_x: 778, class_act_y: 378,
        cert_size: 31, cert_x: 728, cert_y: 425,
        comm_date_size: 33, comm_date_x: 804, comm_date_y: 474,
        card_no_size: 35, card_no_x: 850, card_no_y: 563,
        aff_date_size: 27, aff_date_x: 896, aff_date_y: 619,
        exp_date_size: 28, exp_date_x: 474, exp_date_y: 619
    },
    back: {
        comp_en_size: 36, comp_en_x: 192, comp_en_y: 322,
        ceo_en_size: 33, ceo_en_x: 88, ceo_en_y: 363,
        class_act_en_size: 33, class_act_en_x: 275, class_act_en_y: 410,
        license_en_size: 33, license_en_x: 214, license_en_y: 459,
        comm_no_size: 33, comm_no_x: 396, comm_no_y: 503,
        card_no_size: 32, card_no_x: 127, card_no_y: 573,
        aff_date_size: 27, aff_date_x: 174, aff_date_y: 627,
        exp_date_size: 27, exp_date_x: 636, exp_date_y: 627,
        qr_x: 753, qr_y: 216, qr_size: 237
    }
};

const DEFAULT_BROKER_TYPOGRAPHY = {
    front: {
        name_size: 36, name_x: 905, name_y: 309,
        class_size: 36, class_x: 892, class_y: 370,
        comm_size: 32, comm_x: 796, comm_y: 432,
        activity_size: 32, activity_x: 891, activity_y: 493,
        card_no_size: 35, card_no_x: 844, card_no_y: 558,
        aff_date_size: 27, aff_date_x: 890, aff_date_y: 624,
        exp_date_size: 27, exp_date_x: 470, exp_date_y: 624
    },
    back: {
        name_size: 36, name_x: 13, name_y: 301,
        class_size: 34, class_x: 116, class_y: 371,
        comm_no_size: 34, comm_no_x: 394, comm_no_y: 430,
        activity_size: 34, activity_x: 160, activity_y: 479,
        card_no_size: 34, card_no_x: 122, card_no_y: 565,
        aff_date_size: 27, aff_date_x: 168, aff_date_y: 624,
        exp_date_size: 27, exp_date_x: 733, exp_date_y: 624,
        qr_x: 758, qr_y: 207, qr_size: 238
    }
};

const DEFAULT_TYPOGRAPHY = {
    front: {
        name_size: 38, name_x: 907, name_y: 309,
        class_size: 38, class_x: 898, class_y: 367,
        comm_size: 33, comm_x: 801, comm_y: 429,
        activity_size: 33, activity_x: 896, activity_y: 487,
        card_no_size: 36, card_no_x: 849, card_no_y: 552,
        aff_date_size: 28, aff_date_x: 910, aff_date_y: 614,
        exp_date_size: 28, exp_date_x: 473, exp_date_y: 614
    },
    back: {
        name_size: 36, name_x: 14, name_y: 305,
        class_size: 36, class_x: 118, class_y: 375,
        comm_no_size: 36, comm_no_x: 396, comm_no_y: 432,
        activity_size: 34, activity_x: 163, activity_y: 484,
        card_no_size: 34, card_no_x: 124, card_no_y: 570,
        aff_date_size: 27, aff_date_x: 168, aff_date_y: 630,
        exp_date_size: 27, exp_date_x: 732, exp_date_y: 630,
        qr_x: 758, qr_y: 210, qr_size: 238
    }
};

const CARD_LOGICAL_W = 1024;
const CARD_LOGICAL_H = 644;
const CARD_RENDER_W = 3434;
const CARD_RENDER_H = 2160;
const CARD_PREVIEW_W = 1024;
const CARD_PREVIEW_H = 644;

function isCompanyBm(trader) {
    return !!(trader && trader.member_type === 'company' && trader.company_role === 'bm');
}

function getTypoCacheKey(trader) {
    if (isCompanyBm(trader)) return 'company_bm';
    if (trader && trader.member_type === 'company') return 'company';
    if (trader && trader.member_type === 'broker') return 'broker';
    return 'trader';
}

function getFallbackTypography(trader) {
    if (isCompanyBm(trader)) return DEFAULT_COMPANY_BM_TYPOGRAPHY;
    if (trader && trader.member_type === 'company') return DEFAULT_COMPANY_TYPOGRAPHY;
    if (trader && trader.member_type === 'broker') return DEFAULT_BROKER_TYPOGRAPHY;
    return DEFAULT_TYPOGRAPHY;
}

function getFrontPhotoBox(trader) {
    if (isCompanyBm(trader)) {
        return { x: 20, y: 265, w: 276, h: 352, radius: 22 };
    }
    if (trader && trader.member_type === 'company') {
        return { x: 17, y: 264, w: 278, h: 355, radius: 22 };
    }
    if (trader && trader.member_type === 'broker') {
        return { x: 23, y: 266, w: 273, h: 354, radius: 22 };
    }
    return { x: 20, y: 268, w: 275, h: 342, radius: 22 };
}

function entoar(str) {
    if (!str) return '';
    return String(str).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
}

// Format YYYY-MM-DD so Arabic-Indic digits with '-' render visually as YYYY-MM-DD in RTL/BiDi
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

/** Formats the Arabic front incorporation license with its symbol first followed by a slash and Arabic-Indic digits. */
function formatIncorporationLicense(certNo, certSymbol) {
    const rawNum = String(certNo || '').trim();
    const formattedNum = rawNum ? entoar(rawNum) : '';
    const sym = String(certSymbol || '').trim();
    if (sym && formattedNum) return `${sym} / ${formattedNum}`;
    return sym || formattedNum || '-';
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

function loadImage(src, fallbackToAvatar = true) {
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
            if (fallbackToAvatar && src !== '/templates/avatar_placeholder.png') {
                loadImage('/templates/avatar_placeholder.png', false).then(fallbackImg => {
                    if (fallbackImg) {
                        RESOLVED_IMAGE_CACHE.set(src, fallbackImg);
                    }
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

async function loadImageWithFallback(primarySrc, fallbackSrc) {
    if (!primarySrc) {
        return fallbackSrc ? loadImage(fallbackSrc, false) : null;
    }
    if (RESOLVED_IMAGE_CACHE.has(primarySrc)) {
        return RESOLVED_IMAGE_CACHE.get(primarySrc);
    }
    const primaryImg = await loadImage(primarySrc, false);
    if (primaryImg) return primaryImg;
    if (!fallbackSrc) return null;
    const fallbackImg = await loadImage(fallbackSrc, false);
    if (fallbackImg) {
        RESOLVED_IMAGE_CACHE.set(primarySrc, fallbackImg);
    }
    return fallbackImg;
}

async function ensureFonts() {
    if (fontsLoadedOnce) return;
    if (fontsLoadPromise) return fontsLoadPromise;
    fontsLoadPromise = (async () => {
        try {
            if (document.fonts && document.fonts.ready) {
                await document.fonts.ready;
            }
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

function prepareCardCanvas(canvas, bg, renderW = CARD_PREVIEW_W, renderH = CARD_PREVIEW_H) {
    const ctx = canvas.getContext('2d');
    if (canvas.width !== renderW) canvas.width = renderW;
    if (canvas.height !== renderH) canvas.height = renderH;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, renderW, renderH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (bg) ctx.drawImage(bg, 0, 0, renderW, renderH);
    ctx.setTransform(renderW / CARD_LOGICAL_W, 0, 0, renderH / CARD_LOGICAL_H, 0, 0);
    return ctx;
}

function drawCardFrontSync(canvas, trader, bg, photo, renderW = CARD_PREVIEW_W, renderH = CARD_PREVIEW_H) {
    if (!canvas || !trader) return;
    const isComp = trader.member_type === 'company';
    const isBroker = trader.member_type === 'broker';
    const fallbackDefaults = getFallbackTypography(trader);
    const s = (activeCardTypography && activeCardTypography.front)
        ? activeCardTypography.front
        : ((globalTypography && globalTypography.front) ? globalTypography.front : fallbackDefaults.front);

    const ctx = prepareCardCanvas(canvas, bg, renderW, renderH);

    const { x: boxX, y: boxY, w: boxW, h: boxH, radius } = getFrontPhotoBox(trader);
    const dFront = fallbackDefaults.front;
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
        const photoLeftMargin = 298;
        ctx.font = `bold ${s.comp_size || dFront.comp_size}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, trader.company_name || trader.commercial_name || trader.name || '', s.comp_x ?? dFront.comp_x, s.comp_y ?? dFront.comp_y, photoLeftMargin, true);

        ctx.font = `bold ${s.ceo_size || dFront.ceo_size}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, trader.ceo_name || trader.name || '', s.ceo_x ?? dFront.ceo_x, s.ceo_y ?? dFront.ceo_y, photoLeftMargin, true);

        ctx.font = `bold ${s.class_act_size || dFront.class_act_size}px "PT Bold Heading", sans-serif`;
        const classAct = formatClassName(trader.card_class, 'ar') + ' / ' + (trader.activity || '-');
        drawAutoFitText(ctx, classAct, s.class_act_x ?? dFront.class_act_x, s.class_act_y ?? dFront.class_act_y, photoLeftMargin, true);

        ctx.font = `bold ${s.cert_size || dFront.cert_size}px "PT Bold Heading", sans-serif`;
        const cert = formatIncorporationLicense(trader.incorporation_certificate_no, trader.incorporation_certificate_symbol);
        drawAutoFitText(ctx, cert, s.cert_x ?? dFront.cert_x, s.cert_y ?? dFront.cert_y, photoLeftMargin, true);

        ctx.font = `bold ${s.comm_date_size || dFront.comm_date_size}px "PT Bold Heading", sans-serif`;
        const commNo = trader.commercial_name_no ? entoar(trader.commercial_name_no) : (trader.commercial_name || '-');
        const compCommX = (s.comm_date_x && s.comm_date_x !== 695) ? s.comm_date_x : dFront.comm_date_x;
        drawAutoFitText(ctx, commNo, compCommX, s.comm_date_y ?? dFront.comm_date_y, photoLeftMargin, true);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${s.card_no_size || dFront.card_no_size}px "PT Bold Heading", sans-serif`;
        let cardText = entoar(trader.card_no);
        if (trader.renewal_no) cardText += ' / ' + entoar(trader.renewal_no);
        ctx.fillText(cardText, s.card_no_x ?? dFront.card_no_x, s.card_no_y ?? dFront.card_no_y);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${s.aff_date_size || dFront.aff_date_size}px "PT Bold Heading", sans-serif`;
        drawArabicDate(ctx, trader.affiliation_date || '', s.aff_date_x ?? dFront.aff_date_x, s.aff_date_y ?? dFront.aff_date_y);
        ctx.font = `bold ${s.exp_date_size || dFront.exp_date_size}px "PT Bold Heading", sans-serif`;
        drawArabicDate(ctx, trader.expire_date || '', s.exp_date_x ?? dFront.exp_date_x, s.exp_date_y ?? dFront.exp_date_y);
    } else if (isBroker) {
        const photoLeftBroker = 298;
        ctx.font = `bold ${s.name_size || dFront.name_size}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, trader.name || '', s.name_x ?? dFront.name_x, s.name_y ?? dFront.name_y, photoLeftBroker, true);

        ctx.font = `bold ${s.class_size || dFront.class_size}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, 'دلالية', s.class_x ?? dFront.class_x, s.class_y ?? dFront.class_y, photoLeftBroker, true);

        ctx.font = `bold ${s.comm_size || dFront.comm_size}px "PT Bold Heading", sans-serif`;
        let commText = trader.commercial_name || '';
        if (trader.commercial_name_no) commText += ' / ' + entoar(trader.commercial_name_no);
        drawAutoFitText(ctx, commText, s.comm_x ?? dFront.comm_x, s.comm_y ?? dFront.comm_y, photoLeftBroker, true);

        ctx.font = `bold ${s.activity_size || dFront.activity_size}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, trader.activity || 'دلالية العقارات', s.activity_x ?? dFront.activity_x, s.activity_y ?? dFront.activity_y, photoLeftBroker, true);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${s.card_no_size || dFront.card_no_size}px "PT Bold Heading", sans-serif`;
        let cardText = entoar(trader.card_no);
        if (trader.renewal_no) cardText += ' / ' + entoar(trader.renewal_no);
        ctx.fillText(cardText, s.card_no_x ?? dFront.card_no_x, s.card_no_y ?? dFront.card_no_y);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${s.aff_date_size || dFront.aff_date_size}px "PT Bold Heading", sans-serif`;
        drawArabicDate(ctx, trader.affiliation_date || '', s.aff_date_x ?? dFront.aff_date_x, s.aff_date_y ?? dFront.aff_date_y);
        ctx.font = `bold ${s.exp_date_size || dFront.exp_date_size}px "PT Bold Heading", sans-serif`;
        drawArabicDate(ctx, trader.expire_date || '', s.exp_date_x ?? dFront.exp_date_x, s.exp_date_y ?? dFront.exp_date_y);
    } else {
        const photoLeftTrader = 298;
        ctx.font = `bold ${s.name_size || dFront.name_size}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, trader.name || '', s.name_x ?? dFront.name_x, s.name_y ?? dFront.name_y, photoLeftTrader, true);

        ctx.font = `bold ${s.class_size || dFront.class_size}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, formatClassName(trader.card_class, 'ar'), s.class_x ?? dFront.class_x, s.class_y ?? dFront.class_y, photoLeftTrader, true);

        ctx.font = `bold ${s.comm_size || dFront.comm_size}px "PT Bold Heading", sans-serif`;
        let commText = trader.commercial_name || '';
        if (trader.commercial_name_no) commText += ' / ' + entoar(trader.commercial_name_no);
        drawAutoFitText(ctx, commText, s.comm_x ?? dFront.comm_x, s.comm_y ?? dFront.comm_y, photoLeftTrader, true);

        ctx.font = `bold ${s.activity_size || dFront.activity_size}px "PT Bold Heading", sans-serif`;
        drawAutoFitText(ctx, trader.activity || '', s.activity_x ?? dFront.activity_x, s.activity_y ?? dFront.activity_y, photoLeftTrader, true);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${s.card_no_size || dFront.card_no_size}px "PT Bold Heading", sans-serif`;
        let cardText = entoar(trader.card_no);
        if (trader.renewal_no) cardText += ' / ' + entoar(trader.renewal_no);
        ctx.fillText(cardText, s.card_no_x ?? dFront.card_no_x, s.card_no_y ?? dFront.card_no_y);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${s.aff_date_size || dFront.aff_date_size}px "PT Bold Heading", sans-serif`;
        drawArabicDate(ctx, trader.affiliation_date || '', s.aff_date_x ?? dFront.aff_date_x, s.aff_date_y ?? dFront.aff_date_y);
        ctx.font = `bold ${s.exp_date_size || dFront.exp_date_size}px "PT Bold Heading", sans-serif`;
        drawArabicDate(ctx, trader.expire_date || '', s.exp_date_x ?? dFront.exp_date_x, s.exp_date_y ?? dFront.exp_date_y);
    }

    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawCardBackSync(canvas, trader, bg, qrImg, renderW = CARD_PREVIEW_W, renderH = CARD_PREVIEW_H) {
    if (!canvas || !trader) return;
    const isComp = trader.member_type === 'company';
    const isBroker = trader.member_type === 'broker';
    const fallbackDefaults = getFallbackTypography(trader);
    const s = (activeCardTypography && activeCardTypography.back)
        ? activeCardTypography.back
        : ((globalTypography && globalTypography.back) ? globalTypography.back : fallbackDefaults.back);

    const ctx = prepareCardCanvas(canvas, bg, renderW, renderH);

    const dBack = fallbackDefaults.back;
    if (qrImg) {
        const qrX = s.qr_x ?? dBack.qr_x;
        const qrY = s.qr_y ?? dBack.qr_y;
        const qrSize = s.qr_size ?? dBack.qr_size;
        ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
    }

    ctx.save();
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#000000';

    if (isComp) {
        const qrLeft = (s.qr_x ?? dBack.qr_x) - 6;
        ctx.font = `bold ${s.comp_en_size || dBack.comp_en_size}px "Myriad Pro", Arial, sans-serif`;
        const compEn = (trader.english_company_name || trader.company_name || '').toUpperCase();
        drawAutoFitText(ctx, compEn, s.comp_en_x ?? dBack.comp_en_x, s.comp_en_y ?? dBack.comp_en_y, qrLeft);

        ctx.font = `bold ${s.ceo_en_size || dBack.ceo_en_size}px "Myriad Pro", Arial, sans-serif`;
        const ceoEn = (trader.english_ceo_name || trader.english_name || trader.ceo_name || trader.name || '').toUpperCase();
        drawAutoFitText(ctx, ceoEn, s.ceo_en_x ?? dBack.ceo_en_x, s.ceo_en_y ?? dBack.ceo_en_y, qrLeft);

        ctx.font = `bold ${s.class_act_en_size || dBack.class_act_en_size}px "Myriad Pro", Arial, sans-serif`;
        const enAct = trader.english_activity || trader.activity || '-';
        const classActEn = formatClassName(trader.card_class, 'en') + ' / ' + enAct;
        drawAutoFitText(ctx, classActEn, s.class_act_en_x ?? dBack.class_act_en_x, s.class_act_en_y ?? dBack.class_act_en_y, qrLeft);

        ctx.font = `bold ${s.license_en_size || dBack.license_en_size}px "Myriad Pro", Arial, sans-serif`;
        const licText = String(trader.incorporation_certificate_no || '').trim() || '-';
        drawAutoFitText(ctx, licText, s.license_en_x ?? dBack.license_en_x, s.license_en_y ?? dBack.license_en_y, qrLeft);

        ctx.font = `bold ${s.comm_no_size || dBack.comm_no_size}px "Myriad Pro", Arial, sans-serif`;
        drawAutoFitText(ctx, trader.commercial_name_no || '-', s.comm_no_x ?? dBack.comm_no_x, s.comm_no_y ?? dBack.comm_no_y, qrLeft);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${s.card_no_size || dBack.card_no_size}px "Myriad Pro", Arial, sans-serif`;
        let enCard = trader.card_no || '';
        if (trader.renewal_no) enCard += ' / ' + trader.renewal_no;
        ctx.fillText(enCard, s.card_no_x ?? dBack.card_no_x, s.card_no_y ?? dBack.card_no_y);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${s.aff_date_size || dBack.aff_date_size}px "Myriad Pro", Arial, sans-serif`;
        ctx.fillText(trader.affiliation_date || '-', s.aff_date_x ?? dBack.aff_date_x, s.aff_date_y ?? dBack.aff_date_y);
        ctx.font = `bold ${s.exp_date_size || dBack.exp_date_size}px "Myriad Pro", Arial, sans-serif`;
        ctx.fillText(trader.expire_date || '-', s.exp_date_x ?? dBack.exp_date_x, s.exp_date_y ?? dBack.exp_date_y);
    } else if (isBroker) {
        const qrLeftBroker = (s.qr_x ?? dBack.qr_x) - 6;
        ctx.font = `bold ${s.name_size || dBack.name_size}px "Myriad Pro", Arial, sans-serif`;
        const enName = (trader.english_name || trader.name || '').toUpperCase();
        drawAutoFitText(ctx, enName, s.name_x !== undefined ? s.name_x : dBack.name_x, s.name_y ?? dBack.name_y, qrLeftBroker);

        ctx.font = `bold ${s.class_size || dBack.class_size}px "Myriad Pro", Arial, sans-serif`;
        drawAutoFitText(ctx, formatClassName(trader.card_class, 'en'), s.class_x ?? dBack.class_x, s.class_y ?? dBack.class_y, qrLeftBroker);

        ctx.font = `bold ${s.comm_no_size || dBack.comm_no_size}px "Myriad Pro", Arial, sans-serif`;
        let brokerCommNo = trader.commercial_name_no;
        if (!brokerCommNo && trader.commercial_name && trader.commercial_name.includes('/')) {
            const parts = trader.commercial_name.split('/');
            if (parts[1] && parts[1].trim()) brokerCommNo = parts[1].trim();
        }
        drawAutoFitText(ctx, brokerCommNo || '-', s.comm_no_x ?? dBack.comm_no_x, s.comm_no_y ?? dBack.comm_no_y, qrLeftBroker);

        ctx.font = `bold ${s.activity_size || dBack.activity_size}px "Myriad Pro", Arial, sans-serif`;
        const enAct = trader.english_activity || 'Real Estates BROKER';
        drawAutoFitText(ctx, enAct, s.activity_x ?? dBack.activity_x, s.activity_y ?? dBack.activity_y, qrLeftBroker);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${s.card_no_size || dBack.card_no_size}px "Myriad Pro", Arial, sans-serif`;
        let enCard = trader.card_no || '';
        if (trader.renewal_no) enCard += ' / ' + trader.renewal_no;
        ctx.fillText(enCard, s.card_no_x ?? dBack.card_no_x, s.card_no_y ?? dBack.card_no_y);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${s.aff_date_size || dBack.aff_date_size}px "Myriad Pro", Arial, sans-serif`;
        ctx.fillText(trader.affiliation_date || '-', s.aff_date_x ?? dBack.aff_date_x, s.aff_date_y ?? dBack.aff_date_y);
        ctx.font = `bold ${s.exp_date_size || dBack.exp_date_size}px "Myriad Pro", Arial, sans-serif`;
        ctx.fillText(trader.expire_date || '-', s.exp_date_x ?? dBack.exp_date_x, s.exp_date_y ?? dBack.exp_date_y);
    } else {
        const qrLeftTrader = (s.qr_x ?? dBack.qr_x) - 6;
        const nameSize = s.name_size !== undefined ? s.name_size : dBack.name_size;
        const nameX = s.name_x !== undefined ? s.name_x : dBack.name_x;
        const nameY = s.name_y !== undefined ? s.name_y : dBack.name_y;
        ctx.font = `bold ${nameSize}px "Myriad Pro", Arial, sans-serif`;
        const enName = (trader.english_name || trader.name || '').toUpperCase();
        drawAutoFitText(ctx, enName, nameX, nameY, qrLeftTrader);

        ctx.font = `bold ${s.class_size || dBack.class_size}px "Myriad Pro", Arial, sans-serif`;
        drawAutoFitText(ctx, formatClassName(trader.card_class, 'en'), s.class_x ?? dBack.class_x, s.class_y ?? dBack.class_y, qrLeftTrader);

        ctx.font = `bold ${s.comm_no_size || dBack.comm_no_size}px "Myriad Pro", Arial, sans-serif`;
        drawAutoFitText(ctx, trader.commercial_name_no || '-', s.comm_no_x ?? dBack.comm_no_x, s.comm_no_y ?? dBack.comm_no_y, qrLeftTrader);

        ctx.font = `bold ${s.activity_size || dBack.activity_size}px "Myriad Pro", Arial, sans-serif`;
        const enTraderAct = trader.english_activity || trader.activity || '-';
        drawAutoFitText(ctx, enTraderAct, s.activity_x ?? dBack.activity_x, s.activity_y ?? dBack.activity_y, qrLeftTrader);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${s.card_no_size || dBack.card_no_size}px "Myriad Pro", Arial, sans-serif`;
        let enCard = trader.card_no || '';
        if (trader.renewal_no) enCard += ' / ' + trader.renewal_no;
        ctx.fillText(enCard, s.card_no_x ?? dBack.card_no_x, s.card_no_y ?? dBack.card_no_y);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${s.aff_date_size || dBack.aff_date_size}px "Myriad Pro", Arial, sans-serif`;
        ctx.fillText(trader.affiliation_date || '-', s.aff_date_x ?? dBack.aff_date_x, s.aff_date_y ?? dBack.aff_date_y);
        ctx.font = `bold ${s.exp_date_size || dBack.exp_date_size}px "Myriad Pro", Arial, sans-serif`;
        ctx.fillText(trader.expire_date || '-', s.exp_date_x ?? dBack.exp_date_x, s.exp_date_y ?? dBack.exp_date_y);
    }

    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function getFrontTemplatePath(trader) {
    if (isCompanyBm(trader)) return '/templates/company_bm_front_clean.png?v=7';
    if (trader && trader.member_type === 'company') return '/templates/company_front_clean.png?v=7';
    if (trader && trader.member_type === 'broker') return '/templates/broker_front_clean.png?v=7';
    return '/templates/card_front_template.png?v=7';
}

function getBackTemplatePath(trader) {
    if (isCompanyBm(trader)) return '/templates/company_bm_back_clean.png?v=7';
    if (trader && trader.member_type === 'company') return '/templates/company_back_clean.png?v=7';
    if (trader && trader.member_type === 'broker') return '/templates/broker_back_clean.png?v=7';
    return '/templates/card_back_clean.png?v=7';
}

function getFrontPreviewTemplatePath(trader) {
    if (isCompanyBm(trader)) return '/templates/previews/company_bm_front_clean.webp?v=2';
    if (trader && trader.member_type === 'company') return '/templates/previews/company_front_clean.webp?v=2';
    if (trader && trader.member_type === 'broker') return '/templates/previews/broker_front_clean.webp?v=2';
    return '/templates/previews/card_front_template.webp?v=2';
}

function getBackPreviewTemplatePath(trader) {
    if (isCompanyBm(trader)) return '/templates/previews/company_bm_back_clean.webp?v=2';
    if (trader && trader.member_type === 'company') return '/templates/previews/company_back_clean.webp?v=2';
    if (trader && trader.member_type === 'broker') return '/templates/previews/broker_back_clean.webp?v=2';
    return '/templates/previews/card_back_clean.webp?v=2';
}

async function renderCardFront(canvas, trader) {
    const previewTplPath = getFrontPreviewTemplatePath(trader);
    const fallbackTplPath = getFrontTemplatePath(trader);
    const photoSrc = trader.photo_path || '/templates/avatar_placeholder.png';
    const [, bg, photo] = await Promise.all([
        ensureFonts(),
        loadImageWithFallback(previewTplPath, fallbackTplPath),
        loadImage(photoSrc)
    ]);
    drawCardFrontSync(canvas, trader, bg, photo, CARD_PREVIEW_W, CARD_PREVIEW_H);
}

async function renderCardBack(canvas, trader, qrDataUrl) {
    const previewTplPath = getBackPreviewTemplatePath(trader);
    const fallbackTplPath = getBackTemplatePath(trader);
    const [, bg, qrImg] = await Promise.all([
        ensureFonts(),
        loadImageWithFallback(previewTplPath, fallbackTplPath),
        qrDataUrl ? loadImage(qrDataUrl, false) : Promise.resolve(null)
    ]);
    drawCardBackSync(canvas, trader, bg, qrImg, CARD_PREVIEW_W, CARD_PREVIEW_H);
}

function getModalFieldsForTrader(trader, side) {
    if (isCompanyBm(trader)) {
        return side === 'front' ? COMPANY_BM_FRONT_FIELDS : COMPANY_BM_BACK_FIELDS;
    }
    if (trader && trader.member_type === 'company') {
        return side === 'front' ? COMPANY_FRONT_FIELDS : COMPANY_BACK_FIELDS;
    }
    if (trader && trader.member_type === 'broker') {
        return side === 'front' ? BROKER_FRONT_FIELDS : BROKER_BACK_FIELDS;
    }
    return side === 'front' ? MODAL_FRONT_FIELDS : MODAL_BACK_FIELDS;
}

function getActiveFieldDef() {
    const list = getModalFieldsForTrader(currentTrader, currentModalSide);
    return list.find(f => f.key === activeModalFieldKey) || list[0];
}

function populateModalFieldPills() {
    const container = document.getElementById('modalFieldPills');
    if (!container) return;
    container.innerHTML = '';
    const fields = getModalFieldsForTrader(currentTrader, currentModalSide);

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

function drawCachedModalSide(side, fallbackToAsync = false) {
    if (!currentTrader) return;
    if (side === 'front') {
        const canvas = document.getElementById('frontCanvas');
        const tplPath = getFrontPreviewTemplatePath(currentTrader);
        const photoSrc = currentTrader.photo_path || '/templates/avatar_placeholder.png';
        if (RESOLVED_IMAGE_CACHE.has(tplPath) && RESOLVED_IMAGE_CACHE.has(photoSrc)) {
            drawCardFrontSync(
                canvas,
                currentTrader,
                RESOLVED_IMAGE_CACHE.get(tplPath),
                RESOLVED_IMAGE_CACHE.get(photoSrc),
                CARD_PREVIEW_W,
                CARD_PREVIEW_H
            );
        } else if (fallbackToAsync) {
            renderCardFront(canvas, currentTrader);
        }
    } else {
        const canvas = document.getElementById('backCanvas');
        const tplPath = getBackPreviewTemplatePath(currentTrader);
        const hasQr = !currentModalQrUrl || RESOLVED_IMAGE_CACHE.has(currentModalQrUrl);
        if (RESOLVED_IMAGE_CACHE.has(tplPath) && hasQr) {
            drawCardBackSync(
                canvas,
                currentTrader,
                RESOLVED_IMAGE_CACHE.get(tplPath),
                currentModalQrUrl ? RESOLVED_IMAGE_CACHE.get(currentModalQrUrl) : null,
                CARD_PREVIEW_W,
                CARD_PREVIEW_H
            );
        } else if (fallbackToAsync) {
            renderCardBack(canvas, currentTrader, currentModalQrUrl);
        }
    }
}

// 60 FPS Zero-Lag Synchronous Redraw when dragging sliders or pressing arrows
function redrawModalCanvas() {
    if (!currentTrader) return;
    if (redrawRafId) cancelAnimationFrame(redrawRafId);
    redrawRafId = requestAnimationFrame(() => {
        redrawRafId = null;
        drawCachedModalSide(currentModalSide, true);
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
        const fallback = getFallbackTypography(currentTrader);
        currentTrader.custom_typography = null;
        activeCardTypography = JSON.parse(JSON.stringify(globalTypography || fallback));
        populateModalFieldPills();
        redrawModalCanvas();
        alert('تمت استعادة الإعدادات العامة للبطاقة!');
    } catch (e) {
        alert('Network error: ' + e.message);
    }
}

/**
 * Toggle the read-only reminder banner shown when previewing an unsaved form role selection.
 * @param {boolean} visible
 * @param {boolean} isAr
 */
function syncCompanyRolePreviewNote(visible, isAr) {
    const noteEl = document.getElementById('companyRolePreviewNote');
    if (!noteEl) return;
    if (!visible) {
        noteEl.style.display = 'none';
        noteEl.textContent = '';
        return;
    }
    noteEl.dir = isAr ? 'rtl' : 'ltr';
    noteEl.textContent = isAr
        ? 'معاينة مؤقتة للخيار المحدد في الحقول · اضغط «حفظ» لتثبيت التغيير في السجل'
        : 'Temporary preview for selected field option · Click Save to persist changes';
    noteEl.style.display = 'block';
}

async function openPrintModal(traderId, uuid, options = {}) {
    const token = ++modalRequestToken;
    const modalEl = document.getElementById('printModal');
    const titleEl = document.getElementById('modalTitle');
    const fCanvas = document.getElementById('frontCanvas');
    const bCanvas = document.getElementById('backCanvas');

    // Open modal shell immediately (< 5ms) so UI feels instant!
    modalReadyForPrint = false;
    companyTypographyByRole = null;
    syncCompanyRolePreviewNote(false);
    if (titleEl) {
        delete titleEl.dataset.origTitle;
        titleEl.innerText = 'جاري تجهيز الهوية...';
    }
    modalEl.style.display = 'block';
    modalEl.classList.remove('hidden');

    try {
        const targetId = encodeURIComponent(uuid || traderId);
        const res = await fetch('/api/traders/' + targetId + '?bundle=1');
        const serverAssetRev = res.headers.get('x-cardval-asset-rev') || '';
        const localAssetRev = modalEl?.dataset?.assetRev || '';
        if (
            localAssetRev &&
            serverAssetRev &&
            serverAssetRev !== localAssetRev &&
            !/\/(?:edit|create)\b/.test(window.location.pathname)
        ) {
            try {
                if (sessionStorage.getItem('cardval_rev_reload_to') !== serverAssetRev) {
                    sessionStorage.setItem('cardval_rev_reload_to', serverAssetRev);
                    sessionStorage.setItem(
                        'cardval_pending_modal',
                        JSON.stringify({ traderId, uuid, options, ts: Date.now() })
                    );
                    window.location.reload();
                    return;
                }
            } catch (_) {}
        }
        const json = await res.json();
        if (token !== modalRequestToken) return;
        if (!json.success || !json.trader) {
            closePrintModal();
            return;
        }

        currentTrader = json.trader;
        const isComp = currentTrader.member_type === 'company';
        const isBroker = currentTrader.member_type === 'broker';
        let hasUnsavedRoleOverride = false;
        if (isComp) {
            const dbRole = currentTrader.company_role === 'bm' ? 'bm' : 'ceo';
            const reqRole = options && (options.companyRole === 'bm' || options.companyRole === 'ceo')
                ? options.companyRole
                : dbRole;
            hasUnsavedRoleOverride = reqRole !== dbRole;
            currentTrader.company_role = reqRole;
            if (json.companyTypographyByRole) {
                companyTypographyByRole = {
                    ceo: json.companyTypographyByRole.ceo || DEFAULT_COMPANY_TYPOGRAPHY,
                    bm: json.companyTypographyByRole.bm || DEFAULT_COMPANY_BM_TYPOGRAPHY
                };
                GLOBAL_TYPO_CACHE.set('company', companyTypographyByRole.ceo);
                GLOBAL_TYPO_CACHE.set('company_bm', companyTypographyByRole.bm);
            }
        }

        const cacheKey = getTypoCacheKey(currentTrader);
        const fallback = getFallbackTypography(currentTrader);

        globalTypography = (isComp && companyTypographyByRole && companyTypographyByRole[currentTrader.company_role])
            || (!hasUnsavedRoleOverride ? json.globalTypography : null)
            || GLOBAL_TYPO_CACHE.get(cacheKey)
            || fallback;
        GLOBAL_TYPO_CACHE.set(cacheKey, globalTypography);
        currentModalQrUrl = json.qr_url || null;

        const isArUi = String(document.documentElement.lang || 'ar').toLowerCase().startsWith('ar');
        syncCompanyRolePreviewNote(hasUnsavedRoleOverride, isArUi);
        const titlePrefix = isArUi
            ? (isComp ? 'طباعة هوية الشركة: ' : (isBroker ? 'طباعة هوية الدلال: ' : 'طباعة هوية التاجر: '))
            : (isComp ? 'Print Company ID: ' : (isBroker ? 'Print Broker ID: ' : 'Print Trader ID: '));
        const displayName = isComp ? (currentTrader.company_name || currentTrader.commercial_name || currentTrader.name) : currentTrader.name;
        if (titleEl) {
            delete titleEl.dataset.origTitle;
            titleEl.innerText = titlePrefix + displayName + ' (' + currentTrader.card_no + ')';
        }
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
        if (token === modalRequestToken) {
            modalReadyForPrint = true;
        }
    } catch (e) {
        if (token === modalRequestToken) {
            alert('Error loading card: ' + e.message);
        }
    }
}

function closePrintModal() {
    modalRequestToken++;
    modalReadyForPrint = false;
    syncCompanyRolePreviewNote(false);
    const titleEl = document.getElementById('modalTitle');
    if (titleEl) delete titleEl.dataset.origTitle;
    const modalEl = document.getElementById('printModal');
    if (modalEl) {
        modalEl.style.display = 'none';
        modalEl.classList.add('hidden');
    }
    currentTrader = null;
    companyTypographyByRole = null;
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

function flushPendingRedraw() {
    if (!currentTrader) return;
    if (redrawRafId) {
        cancelAnimationFrame(redrawRafId);
        redrawRafId = null;
        drawCachedModalSide(currentModalSide, false);
    }
}

function openBlobPrintFallback(htmlContent) {
    try {
        const autoPrintHtml = htmlContent.replace(
            '</body>',
            '<script>window.addEventListener("load", function(){ setTimeout(function(){ window.focus(); window.print(); }, 80); });<\/script></body>'
        );
        const blob = new Blob([autoPrintHtml], { type: 'text/html;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (err) {
        console.error('Fallback print failed:', err);
    }
}

function printHtmlContent(htmlContent, pageDims = { width: '210mm', height: '297mm' }) {
    if (pendingPrintTimer) {
        clearTimeout(pendingPrintTimer);
        pendingPrintTimer = null;
    }

    try {
        const existing = document.getElementById('cardPrintHiddenIframe');
        if (existing) {
            existing.remove();
        }

        const iframe = document.createElement('iframe');
        iframe.id = 'cardPrintHiddenIframe';
        iframe.style.position = 'fixed';
        iframe.style.left = '-10000px';
        iframe.style.top = '0';
        iframe.style.width = (pageDims && pageDims.width) || '210mm';
        iframe.style.height = (pageDims && pageDims.height) || '297mm';
        iframe.style.border = '0';
        iframe.style.opacity = '0';
        iframe.style.pointerEvents = 'none';
        iframe.setAttribute('aria-hidden', 'true');
        document.body.appendChild(iframe);

        const win = iframe.contentWindow;
        const doc = win && win.document;
        if (!win || !doc) {
            iframe.remove();
            openBlobPrintFallback(htmlContent);
            return;
        }

        let printed = false;
        const firePrint = () => {
            if (printed) return;
            printed = true;

            const imgs = Array.from(doc.images || []);
            Promise.all(imgs.map(img => {
                if (img.complete && img.naturalWidth > 0) return Promise.resolve();
                if (typeof img.decode === 'function') return img.decode().catch(() => {});
                return new Promise(res => {
                    img.onload = res;
                    img.onerror = res;
                });
            })).then(() => {
                pendingPrintTimer = setTimeout(() => {
                    pendingPrintTimer = null;
                    try {
                        win.focus();
                        win.print();
                    } catch (err) {
                        console.warn('Iframe print failed, opening isolated print tab:', err);
                        openBlobPrintFallback(htmlContent);
                    }
                }, 40);
            });
        };

        iframe.onload = firePrint;
        doc.open();
        doc.write(htmlContent);
        doc.close();

        if (doc.readyState === 'complete') {
            firePrint();
        }
    } catch (e) {
        console.warn('Hidden iframe setup failed, falling back:', e);
        openBlobPrintFallback(htmlContent);
    }
}

async function renderHiResSideOffscreen(side) {
    const trader = currentTrader;
    if (!trader) return null;
    const canvas = document.createElement('canvas');
    canvas.width = CARD_RENDER_W;
    canvas.height = CARD_RENDER_H;

    if (side === 'front') {
        const tplPath = getFrontTemplatePath(trader);
        const previewFallback = getFrontPreviewTemplatePath(trader);
        const photoSrc = trader.photo_path || '/templates/avatar_placeholder.png';
        const [, bg, photo] = await Promise.all([
            ensureFonts(),
            loadImageWithFallback(tplPath, previewFallback),
            loadImage(photoSrc)
        ]);
        if (!currentTrader || currentTrader !== trader) return null;
        drawCardFrontSync(canvas, trader, bg, photo, CARD_RENDER_W, CARD_RENDER_H);
    } else {
        const tplPath = getBackTemplatePath(trader);
        const previewFallback = getBackPreviewTemplatePath(trader);
        const qrUrl = currentModalQrUrl;
        const [, bg, qrImg] = await Promise.all([
            ensureFonts(),
            loadImageWithFallback(tplPath, previewFallback),
            qrUrl ? loadImage(qrUrl, false) : Promise.resolve(null)
        ]);
        if (!currentTrader || currentTrader !== trader) return null;
        drawCardBackSync(canvas, trader, bg, qrImg, CARD_RENDER_W, CARD_RENDER_H);
    }
    return canvas;
}

async function renderCardPairForPrint(trader, typography, qrUrl, fallbackGlobalTypography) {
    if (!trader) return null;
    currentTrader = trader;
    globalTypography = fallbackGlobalTypography || getFallbackTypography(trader);
    activeCardTypography = typography || JSON.parse(JSON.stringify(globalTypography));
    currentModalQrUrl = qrUrl || null;

    const [fCanvas, bCanvas] = await Promise.all([
        renderHiResSideOffscreen('front'),
        renderHiResSideOffscreen('back')
    ]);
    if (!fCanvas || !bCanvas) return null;

    return {
        fData: canvasToPngAndRelease(fCanvas),
        bData: canvasToPngAndRelease(bCanvas)
    };
}

function canvasToPngAndRelease(canvas, quality) {
    const dataUrl = quality !== undefined ? canvas.toDataURL('image/png', quality) : canvas.toDataURL('image/png');
    canvas.width = 0;
    canvas.height = 0;
    return dataUrl;
}

async function withModalStatus(statusText, work) {
    const token = modalRequestToken;
    const titleEl = document.getElementById('modalTitle');
    if (titleEl) {
        if (titleEl.dataset.origTitle === undefined) {
            titleEl.dataset.origTitle = titleEl.innerText;
        }
        titleEl.innerText = statusText;
    }
    try {
        return await work();
    } finally {
        if (titleEl && titleEl.dataset.origTitle !== undefined) {
            if (token === modalRequestToken) {
                titleEl.innerText = titleEl.dataset.origTitle;
            }
            delete titleEl.dataset.origTitle;
        }
    }
}

async function printCR80(side = 'both') {
    if (!currentTrader) {
        alert('جاري تجهيز بيانات الهوية، يرجى الانتظار لحظة ثم المحاولة مرة أخرى.');
        return;
    }
    flushPendingRedraw();

    let targetSide = side;
    if (targetSide === 'current') {
        targetSide = currentModalSide || 'front';
    }

    const trader = currentTrader;
    if (targetSide === 'both') {
        const targetId = String(trader.uuid || trader.id || '').trim();
        if (!targetId) return;

        try {
            const overridePayload = {
                customTypography: activeCardTypography || null,
                companyRole: trader.member_type === 'company' ? (trader.company_role === 'bm' ? 'bm' : 'ceo') : undefined,
                ts: Date.now()
            };
            sessionStorage.setItem('cardval_print_override_' + targetId, JSON.stringify(overridePayload));
        } catch (_) {}

        let printUrl = '/cards/' + encodeURIComponent(targetId) + '/print';
        if (trader.member_type === 'company') {
            printUrl += '?role=' + encodeURIComponent(trader.company_role === 'bm' ? 'bm' : 'ceo');
        }
        const win = window.open(printUrl, '_blank');
        if (!win) {
            alert('يرجى السماح بفتح النوافذ المنبثقة لهذا الموقع لإتمام الطباعة.');
        }
        return;
    }

    const rendered = await withModalStatus('جاري تجهيز نسخة الطباعة عالية الدقة...', async () => {
        if (targetSide === 'front') {
            const fCanvas = await renderHiResSideOffscreen('front');
            if (!fCanvas) return null;
            return { fData: canvasToPngAndRelease(fCanvas), bData: '' };
        }
        const bCanvas = await renderHiResSideOffscreen('back');
        if (!bCanvas) return null;
        return { fData: '', bData: canvasToPngAndRelease(bCanvas) };
    });
    if (!rendered) return;

    const { fData, bData } = rendered;
    const rawName = trader ? (trader.company_name || trader.commercial_name || trader.name || '') : '';
    const safeName = escapeHtmlClient(rawName);

    const pagesHtml = targetSide === 'front'
        ? `<div class="card-page"><img src="${fData}" alt="Front"></div>`
        : `<div class="card-page"><img src="${bData}" alt="Back"></div>`;

    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>CR80 Plastic Print - ${safeName}</title>
    <style>
        @page {
            size: 86mm 54mm;
            margin: 0;
        }
        @media print {
            @page {
                size: 86mm 54mm;
                margin: 0;
            }
            html, body {
                margin: 0 !important;
                padding: 0 !important;
                width: 86mm !important;
                height: auto !important;
                font-size: 0 !important;
                line-height: 0 !important;
                overflow: visible !important;
                background: #fff !important;
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
            }
            .card-page {
                width: 86mm !important;
                height: 54mm !important;
                font-size: 0 !important;
                line-height: 0 !important;
                page-break-after: always !important;
                break-after: page !important;
                page-break-inside: avoid !important;
                break-inside: avoid !important;
                margin: 0 !important;
                padding: 0 !important;
                display: block !important;
                overflow: hidden !important;
                box-sizing: border-box !important;
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
            }
            .card-page:last-child {
                page-break-after: auto !important;
                break-after: auto !important;
            }
            img {
                width: 86mm !important;
                height: 54mm !important;
                object-fit: fill !important;
                display: block !important;
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
                image-rendering: -webkit-optimize-contrast;
                image-rendering: high-quality;
            }
        }
        html, body {
            margin: 0;
            padding: 0;
            font-size: 0;
            line-height: 0;
            background: #fff;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
        }
        .card-page {
            width: 86mm;
            height: 54mm;
            font-size: 0;
            line-height: 0;
            display: block;
            margin: 0;
            padding: 0;
            overflow: hidden;
            page-break-after: always;
            break-after: page;
        }
        .card-page:last-child {
            page-break-after: auto;
            break-after: auto;
        }
        img {
            width: 86mm;
            height: 54mm;
            object-fit: fill;
            display: block;
            image-rendering: -webkit-optimize-contrast;
            image-rendering: high-quality;
        }
    </style>
</head>
<body>
    ${pagesHtml}
</body>
</html>`;
    printHtmlContent(html, { width: '86mm', height: '54mm' });
}

async function printA4() {
    if (!currentTrader) {
        alert('جاري تجهيز بيانات الهوية، يرجى الانتظار لحظة ثم المحاولة مرة أخرى.');
        return;
    }
    flushPendingRedraw();

    const trader = currentTrader;
    const rendered = await withModalStatus('جاري تجهيز نسخة الطباعة عالية الدقة...', async () => {
        const [fCanvas, bCanvas] = await Promise.all([
            renderHiResSideOffscreen('front'),
            renderHiResSideOffscreen('back')
        ]);
        if (!fCanvas || !bCanvas) return null;
        return {
            fData: canvasToPngAndRelease(fCanvas),
            bData: canvasToPngAndRelease(bCanvas)
        };
    });
    if (!rendered) return;

    const { fData, bData } = rendered;
    const rawName = trader ? (trader.company_name || trader.commercial_name || trader.name || '') : '';
    const safeName = escapeHtmlClient(rawName);
    const safeCardNo = escapeHtmlClient(trader ? (trader.card_no || '') : '');

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
            html, body {
                margin: 0 !important;
                padding: 10mm !important;
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
            }
        }
        body {
            font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
            text-align: center;
            margin: 0;
            padding: 20px;
            background: #fff;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
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
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
        }
        .box img {
            width: 100%;
            height: 100%;
            object-fit: fill;
            display: block;
            image-rendering: -webkit-optimize-contrast;
            image-rendering: high-quality;
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

async function downloadImage(side) {
    if (!currentTrader) {
        alert('جاري تجهيز بيانات الهوية، يرجى الانتظار لحظة ثم المحاولة مرة أخرى.');
        return;
    }
    flushPendingRedraw();

    const targetSide = side === 'back' ? 'back' : 'front';
    const trader = currentTrader;
    const dataUrl = await withModalStatus('جاري تجهيز الصورة عالية الدقة...', async () => {
        const canvas = await renderHiResSideOffscreen(targetSide);
        if (!canvas) return null;
        return canvasToPngAndRelease(canvas, 1.0);
    });
    if (!dataUrl) return;

    const link = document.createElement('a');
    const prefix = isCompanyBm(trader) ? 'Company_BM' : (trader.member_type === 'company' ? 'Company' : (trader.member_type === 'broker' ? 'Broker' : 'Card'));
    link.download = `${prefix}_${trader.card_no}_${targetSide}.png`;
    link.href = dataUrl;
    link.click();
}

// Expose functions globally for inline onclick handlers & lazy-loader handoff
window.__realOpenPrintModal = openPrintModal;
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
window.renderCardPairForPrint = renderCardPairForPrint;
window.printA4 = printA4;
window.downloadImage = downloadImage;

// Keyboard arrow key listener for super fast positioning!
window.addEventListener('keydown', (e) => {
    const modal = document.getElementById('printModal');
    if (!modal || modal.style.display === 'none' || modal.classList.contains('hidden')) return;
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
})();
