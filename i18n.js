export const LANG_COOKIE_NAME = 'cardval_lang';
export const DEFAULT_LANG = 'ar';
export const SUPPORTED_LANGS = new Set(['ar', 'en']);

export function isValidLang(lang) {
  return SUPPORTED_LANGS.has(String(lang || '').trim().toLowerCase());
}

export function normalizeLang(lang) {
  const clean = String(lang || '').trim().toLowerCase();
  return SUPPORTED_LANGS.has(clean) ? clean : DEFAULT_LANG;
}

export function parseLangFromRequest(req) {
  const rawCookie = String(req?.headers?.cookie || '');
  if (!rawCookie) return DEFAULT_LANG;

  const parts = rawCookie.split(';');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    if (key !== LANG_COOKIE_NAME) continue;
    try {
      const val = decodeURIComponent(part.slice(eqIdx + 1).trim());
      if (isValidLang(val)) return val.toLowerCase();
    } catch (_) {
      return DEFAULT_LANG;
    }
  }
  return DEFAULT_LANG;
}

export function sanitizeRedirectPath(rawTarget, requestHost = '', fallback = '/traders') {
  const raw = String(rawTarget || '').trim();
  if (!raw) return fallback;

  const isLoopPath = (p) => /^\/(?:(?:traders|brokers|companies)\/)?language\//i.test(p);

  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')) {
    return isLoopPath(raw) ? fallback : raw;
  }

  if (requestHost && /^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.host === requestHost) {
        const rel = `${parsed.pathname}${parsed.search}`;
        if (rel.startsWith('/') && !rel.startsWith('//') && !isLoopPath(rel)) {
          return rel;
        }
      }
    } catch (_) {
      return fallback;
    }
  }

  return fallback;
}

export const TRANSLATIONS = {
  ar: {
    'nav.dashboard': 'الصفحة الرئيسية',
    'nav.traders': 'التجار',
    'nav.brokers': 'الدلالين',
    'nav.companies': 'الشركات',
    'nav.profile': 'الملف الشخصي',
    'nav.site_admin': 'Site Admin',
    'lang.ar': 'العربية',
    'lang.en': 'English',

    'action.advanced_search': 'بحث متقدم',
    'action.download_csv': 'تحميل CSV',
    'action.reset': 'اعادة تعيين',
    'action.list_deleted': 'عرض المشطوبين',
    'action.list_active': 'عرض السجلات الفعالة',
    'action.edit': 'تعديل',
    'action.delete': 'شطب',
    'action.permanent_delete': 'حذف نهائي',
    'action.restore': 'استرجاع',
    'action.save': 'حفظ',
    'action.cancel': 'إلغاء',
    'action.print_id_card': 'طباعة الهوية',
    'action.return_to_traders': 'العودة إلى التجار',
    'badge.deleted': 'مشطوب',
    'deleted.edit_banner': 'هذا السجل مشطوب حالياً بتاريخ {date}',
    'meta.edited': 'تم التعديل',
    'meta.recently': 'حديثاً',
    'meta.deleted_at': 'تاريخ الشطب',

    'filter.status': 'الحالة',
    'filter.status_active': 'السجلات الفعالة',
    'filter.status_deleted': 'السجلات المشطوبة',
    'filter.status_all': 'كل السجلات',
    'filter.any': 'الكل',
    'filter.card_class': 'صنف الهوية',
    'class.0': 'الممتاز',
    'class.1': 'الاول',
    'class.2': 'الثاني',
    'class.3': 'الثالث',
    'class.4': 'الرابع',
    'filter.gender': 'الجنس',
    'gender.male': 'ذكر',
    'gender.female': 'أنثى',
    'filter.company_role': 'صفة المدير',
    'role.ceo': 'المدير المفوض (CEO)',
    'role.bm': 'مدير الفرع (BM)',
    'badge.bm': 'مدير فرع · BM',
    'filter.affiliation_from': 'تاريخ الانتماء من',
    'filter.affiliation_to': 'تاريخ الانتماء الى',
    'filter.expire_from': 'تاريخ الانتهاء من',
    'filter.expire_to': 'تاريخ الانتهاء الى',

    'field.person_pic': 'صورة الشخص',
    'field.card_no': 'رقم الهوية',
    'field.renewal_no': 'رقم التجديد',
    'field.stamp_no': 'رقم الختم',
    'field.address': 'العنوان',
    'field.phone_number': 'رقم الهاتف',
    'field.activity': 'النشاط',
    'field.english_activity': 'النشاط باللغة الانجليزية',
    'field.commercial_name': 'الاسم التجاري',
    'field.commercial_name_no': 'رقم الاسم التجاري',
    'field.speciality': 'التخصص الدقيق',
    'field.affiliation_date': 'تاريخ الانتماء',
    'field.expire_date': 'تاريخ الانتهاء',

    'traders.title': 'التجار',
    'traders.add': 'اضافة تاجر',
    'traders.edit': 'تعديل تاجر',
    'traders.search_placeholder': 'البحث عن أسم, أسم تجاري او نشاط',
    'traders.field.name': 'اسم التاجر',
    'traders.field.english_name': 'اسم التاجر باللغة الانجليزية',
    'traders.empty': 'لم يتم العثور على تجار مطابقين لبحثك.',
    'traders.confirm_delete': 'هل أنت متأكد من شطب هذا التاجر؟',
    'traders.confirm_restore': 'هل أنت متأكد من استرجاع هذا التاجر؟',
    'traders.confirm_permanent_delete': 'تحذير: سيتم حذف هذا التاجر نهائياً من الموقع ولا يمكن التراجع عن هذا الإجراء. هل أنت متأكد؟',

    'brokers.title': 'الدلالين',
    'brokers.add': 'اضافة دلال',
    'brokers.edit': 'تعديل دلال',
    'brokers.search_placeholder': 'البحث عن أسم, أسم تجاري او نشاط',
    'brokers.field.name': 'اسم الدلال',
    'brokers.field.english_name': 'اسم الدلال بالانكليزية',
    'brokers.empty': 'لم يتم العثور على دلالين مطابقين لبحثك.',
    'brokers.confirm_delete': 'هل أنت متأكد من شطب هذا الدلال؟',
    'brokers.confirm_restore': 'هل أنت متأكد من استرجاع هذا الدلال؟',
    'brokers.confirm_permanent_delete': 'تحذير: سيتم حذف هذا الدلال نهائياً من الموقع ولا يمكن التراجع عن هذا الإجراء. هل أنت متأكد؟',

    'companies.title': 'الشركات',
    'companies.add': 'اضافة شركة',
    'companies.edit': 'تعديل شركة',
    'companies.search_placeholder': 'ابحث عن أسم الشركة, مديرها تنفيذي او نشاطها',
    'companies.field.company_name': 'اسم شركة',
    'companies.field.english_company_name': 'اسم شركة باللغة الانكليزية',
    'companies.field.ceo_name': 'اسم المدير التنفيذي',
    'companies.field.english_ceo_name': 'اسم المدير التنفيذي باللغة الانكليزية',
    'companies.field.company_role': 'نموذج الهوية وصفة المدير',
    'companies.field.incorporation_certificate_no': 'رقم شهادة التأسيس',
    'companies.field.incorporation_certificate_symbol': 'رمز شهادة التأسيس',
    'companies.field.incorporation_certificate_symbol_placeholder': 'رمز شهادة التأسيس (مثال: م.ش.أ)',
    'companies.empty': 'لم يتم العثور على شركات مطابقة لبحثك.',
    'companies.confirm_delete': 'هل أنت متأكد من شطب هذه الشركة؟',
    'companies.confirm_restore': 'هل أنت متأكد من استرجاع هذه الشركة؟',
    'companies.confirm_permanent_delete': 'تحذير: سيتم حذف هذه الشركة نهائياً من الموقع ولا يمكن التراجع عن هذا الإجراء. هل أنت متأكد؟',

    'dashboard.title': 'الصفحة الرئيسية',
    'dashboard.welcome': 'مرحباً بك في Cardval - غرفة تجارة كربلاء المقدسة',
    'dashboard.subtitle': 'إدارة هويات الانتماء، تسجيلات التجار والشركات والدلالين، وبوابة التحقق الرقمي.',
    'dashboard.view_traders': 'عرض التجار →',
    'dashboard.view_brokers': 'عرض الدلالين →',
    'dashboard.view_companies': 'عرض الشركات →',
    'dashboard.active_members': 'الأعضاء الفعالون',
    'dashboard.valid_memberships': 'اشتراكات سارية المفعول',
    'dashboard.photos_synced': 'الصور المحفوظة',
    'dashboard.stored_locally': 'مخزنة محلياً',
    'dashboard.card_typography_settings': 'إعدادات خطوط البطاقة',

    'profile.title': 'الملف الشخصي',
    'profile.heading': 'الملف الشخصي وإعدادات خطوط الهوية',
    'modal.default_title': 'طباعة الهوية',

    'pagination.previous': '« السابق',
    'pagination.next': 'التالي »',
    'pagination.showing': 'عرض {from} إلى {to} من أصل {total} نتيجة',
  },
  en: {
    'nav.dashboard': 'Dashboard',
    'nav.traders': 'Traders',
    'nav.brokers': 'Brokers',
    'nav.companies': 'Companies',
    'nav.profile': 'Profile',
    'nav.site_admin': 'Site Admin',
    'lang.ar': 'العربية',
    'lang.en': 'English',

    'action.advanced_search': 'Advanced Search',
    'action.download_csv': 'Download CSV',
    'action.reset': 'Reset',
    'action.list_deleted': 'List Deleted',
    'action.list_active': 'List Active',
    'action.edit': 'Edit',
    'action.delete': 'Delete',
    'action.permanent_delete': 'Delete Permanently',
    'action.restore': 'Restore',
    'action.save': 'Save',
    'action.cancel': 'Cancel',
    'action.print_id_card': 'Print ID Card',
    'action.return_to_traders': 'Return to Traders',
    'badge.deleted': 'Deleted',
    'deleted.edit_banner': 'This record is currently deleted as of {date}',
    'meta.edited': 'edited',
    'meta.recently': 'Recently',
    'meta.deleted_at': 'Deleted at',

    'filter.status': 'Status',
    'filter.status_active': 'Active Records',
    'filter.status_deleted': 'Deleted Records',
    'filter.status_all': 'All Records',
    'filter.any': 'Any',
    'filter.card_class': 'Card class',
    'class.0': 'Excellent',
    'class.1': 'First',
    'class.2': 'Second',
    'class.3': 'Third',
    'class.4': 'Fourth',
    'filter.gender': 'Gender',
    'gender.male': 'Male',
    'gender.female': 'Female',
    'filter.company_role': 'Manager Role',
    'role.ceo': 'CEO (المدير المفوض)',
    'role.bm': 'Branch Manager (BM)',
    'badge.bm': 'BM · Branch Manager',
    'filter.affiliation_from': 'Affiliation from',
    'filter.affiliation_to': 'Affiliation to',
    'filter.expire_from': 'Expire from',
    'filter.expire_to': 'Expire to',

    'field.person_pic': 'Person Image',
    'field.card_no': 'Card No',
    'field.renewal_no': 'Renewal No',
    'field.stamp_no': 'Stamp No',
    'field.address': 'Address',
    'field.phone_number': 'Phone Number',
    'field.activity': 'Activity',
    'field.english_activity': 'Activity in English',
    'field.commercial_name': 'Commercial Name',
    'field.commercial_name_no': 'Commercial Name No',
    'field.speciality': 'Speciality',
    'field.affiliation_date': 'Affiliation Date',
    'field.expire_date': 'Expire Date',

    'traders.title': 'Traders',
    'traders.add': 'Add trader',
    'traders.edit': 'Edit Trader',
    'traders.search_placeholder': 'Find by Name, Commercial Name or Activity',
    'traders.field.name': 'Trader name',
    'traders.field.english_name': 'Trader name in English',
    'traders.empty': 'No traders found matching your search.',
    'traders.confirm_delete': 'Are you sure you want to delete this trader?',
    'traders.confirm_restore': 'Are you sure you want to restore this trader?',
    'traders.confirm_permanent_delete': 'Warning: This trader will be permanently deleted and cannot be recovered. Are you sure?',

    'brokers.title': 'Brokers',
    'brokers.add': 'Add Broker',
    'brokers.edit': 'Edit Broker',
    'brokers.search_placeholder': 'Find by Name, Commercial Name or Activity',
    'brokers.field.name': 'Broker name',
    'brokers.field.english_name': 'Broker name in English',
    'brokers.empty': 'No brokers found matching your search.',
    'brokers.confirm_delete': 'Are you sure you want to delete this broker?',
    'brokers.confirm_restore': 'Are you sure you want to restore this broker?',
    'brokers.confirm_permanent_delete': 'Warning: This broker will be permanently deleted and cannot be recovered. Are you sure?',

    'companies.title': 'Companies',
    'companies.add': 'Add Company',
    'companies.edit': 'Edit Company',
    'companies.search_placeholder': 'Find by Company Name, CEO Name or Activity',
    'companies.field.company_name': 'Company name',
    'companies.field.english_company_name': 'Company name in English',
    'companies.field.ceo_name': 'CEO Name',
    'companies.field.english_ceo_name': 'English CEO Name',
    'companies.field.company_role': 'Card Template & Manager Role',
    'companies.field.incorporation_certificate_no': 'Incorporation Certificate No',
    'companies.field.incorporation_certificate_symbol': 'Incorporation Certificate Symbol',
    'companies.field.incorporation_certificate_symbol_placeholder': 'Incorporation Certificate Symbol (e.g. م.ش.أ)',
    'companies.empty': 'No companies found matching your search.',
    'companies.confirm_delete': 'Are you sure you want to delete this company?',
    'companies.confirm_restore': 'Are you sure you want to restore this company?',
    'companies.confirm_permanent_delete': 'Warning: This company will be permanently deleted and cannot be recovered. Are you sure?',

    'dashboard.title': 'Dashboard',
    'dashboard.welcome': 'Welcome to Cardval - Karbala Chamber of Commerce',
    'dashboard.subtitle': 'Membership card management, trader registrations, and digital verification portal.',
    'dashboard.view_traders': 'View Traders →',
    'dashboard.view_brokers': 'View Brokers →',
    'dashboard.view_companies': 'View Companies →',
    'dashboard.active_members': 'Active Members',
    'dashboard.valid_memberships': 'Valid memberships',
    'dashboard.photos_synced': 'Photos Synced',
    'dashboard.stored_locally': 'Stored locally',
    'dashboard.card_typography_settings': 'Card Typography Settings',

    'profile.title': 'Profile',
    'profile.heading': 'Profile & Card Typography Settings',
    'modal.default_title': 'Print Trader ID Card',

    'pagination.previous': '« Previous',
    'pagination.next': 'Next »',
    'pagination.showing': 'Showing {from} to {to} of {total} results',
  },
};

export function createTranslator(lang) {
  const safeLang = normalizeLang(lang);
  const dict = TRANSLATIONS[safeLang];
  const fallback = TRANSLATIONS.en;
  return function t(key, vars = {}) {
    let text = dict[key] ?? fallback[key] ?? key;
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v ?? ''));
    }
    return text;
  };
}

const CSV_HEADERS = {
  trader: {
    ar: [
      'اسم التاجر', 'اسم التاجر باللغة الانجليزية', 'الاسم التجاري', 'النشاط', 'النشاط باللغة الانجليزية',
      'رقم الهوية', 'رقم التجديد', 'صنف الهوية', 'الجنس', 'رقم الاسم التجاري', 'التخصص الدقيق',
      'رقم الهاتف', 'العنوان', 'تاريخ الانتماء', 'تاريخ الانتهاء', 'أنشئ بواسطة',
      'تاريخ الإنشاء', 'تاريخ التحديث', 'تاريخ الشطب',
    ],
    en: [
      'Name', 'English Name', 'Commercial Name', 'Activity', 'English Activity',
      'Card No', 'Renewal No', 'Card Class', 'Gender', 'Commercial Name No', 'Speciality',
      'Phone Number', 'Address', 'Affiliation Date', 'Expire Date', 'Created By',
      'Created At', 'Updated At', 'Deleted At',
    ],
  },
  broker: {
    ar: [
      'اسم الدلال', 'اسم الدلال بالانكليزية', 'الاسم التجاري', 'النشاط', 'النشاط باللغة الانجليزية',
      'رقم الهوية', 'رقم الختم', 'رقم التجديد', 'صنف الهوية', 'الجنس', 'رقم الاسم التجاري',
      'رقم الهاتف', 'العنوان', 'تاريخ الانتماء', 'تاريخ الانتهاء', 'أنشئ بواسطة',
      'تاريخ الإنشاء', 'تاريخ التحديث', 'تاريخ الشطب',
    ],
    en: [
      'Name', 'English Name', 'Commercial Name', 'Activity', 'English Activity',
      'Card No', 'Stamp No', 'Renewal No', 'Card Class', 'Gender', 'Commercial Name No',
      'Phone Number', 'Address', 'Affiliation Date', 'Expire Date', 'Created By',
      'Created At', 'Updated At', 'Deleted At',
    ],
  },
  company: {
    ar: [
      'اسم شركة', 'اسم شركة باللغة الانكليزية', 'اسم المدير التنفيذي', 'اسم المدير التنفيذي باللغة الانكليزية',
      'النشاط', 'النشاط باللغة الانجليزية', 'رقم الهوية', 'رقم التجديد', 'صنف الهوية',
      'الجنس', 'صفة المدير', 'رقم الاسم التجاري',
      'رقم شهادة التأسيس', 'رمز شهادة التأسيس', 'التخصص الدقيق',
      'رقم الهاتف', 'العنوان', 'تاريخ الانتماء', 'تاريخ الانتهاء', 'أنشئ بواسطة',
      'تاريخ الإنشاء', 'تاريخ التحديث', 'تاريخ الشطب',
    ],
    en: [
      'Company Name', 'English Company Name', 'CEO Name', 'English CEO Name',
      'Activity', 'English Activity', 'Card No', 'Renewal No', 'Card Class',
      'Gender', 'Manager Role', 'Commercial Name No',
      'Incorporation Certificate No', 'Incorporation Symbol', 'Speciality',
      'Phone Number', 'Address', 'Affiliation Date', 'Expire Date', 'Created By',
      'Created At', 'Updated At', 'Deleted At',
    ],
  },
};

export function getCsvHeaders(memberType, lang) {
  const safeType = CSV_HEADERS[memberType] ? memberType : 'trader';
  const safeLang = normalizeLang(lang);
  return CSV_HEADERS[safeType][safeLang];
}
