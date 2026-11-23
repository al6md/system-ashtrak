(() => {
    if (window.__cardvalFastNav) return;
    window.__cardvalFastNav = true;

    const CACHE_MAX_ENTRIES = 25;
    const CACHE_TTL_MS = 20000;
    const MAX_CONCURRENT_PREFETCHES = 2;
    const HOVER_DEBOUNCE_MS = 80;
    const PROGRESS_ID = 'cardval-nav-progress';

    const pageCache = new Map();
    const inflightFetches = new Map();
    const prefetchedHeadUrls = new Set();

    let activePrefetches = 0;
    let activeNavController = null;
    let navToken = 0;
    let hoverTimer = null;
    let progressShowTimer = null;
    let progressHideTimer = null;
    let progressBarEl = null;
    let cardModalCssPromise = null;
    let cardModalJsPromise = null;
    const initialAssetRev = document.getElementById('printModal')?.dataset?.assetRev || '';

    function isAssetRevStale(remoteRev) {
        return Boolean(initialAssetRev && remoteRev && remoteRev !== initialAssetRev);
    }

    function getCacheKey(urlObj) {
        return `${urlObj.origin}${urlObj.pathname}${urlObj.search}`;
    }

    let currentPageKey = (() => {
        try {
            return getCacheKey(new URL(window.location.href));
        } catch (_) {
            return '';
        }
    })();

    window.cardvalClearNavCache = () => {
        pageCache.clear();
    };

    function getCachedPage(key) {
        const entry = pageCache.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
            pageCache.delete(key);
            return null;
        }
        return entry;
    }

    function setCachedPage(key, html, finalUrl) {
        if (pageCache.has(key)) {
            pageCache.delete(key);
        }
        while (pageCache.size >= CACHE_MAX_ENTRIES) {
            const oldestKey = pageCache.keys().next().value;
            pageCache.delete(oldestKey);
        }
        pageCache.set(key, {
            html,
            finalUrl,
            expiresAt: Date.now() + CACHE_TTL_MS
        });
    }

    function isPjaxEligibleUrl(urlObj) {
        if (!urlObj || urlObj.origin !== window.location.origin) return false;
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return false;
        if (!document.getElementById('pjax-container')) return false;

        const pathname = urlObj.pathname || '';
        if (
            pathname.startsWith('/profile') ||
            pathname.startsWith('/traders/validate/') ||
            pathname.startsWith('/uploads/') ||
            pathname.startsWith('/api/') ||
            pathname.startsWith('/language/') ||
            pathname.includes('/language/') ||
            pathname.includes('export/csv') ||
            (urlObj.search && urlObj.search.includes('export/csv'))
        ) {
            return false;
        }
        return true;
    }

    function getProgressBar() {
        if (progressBarEl && document.body && document.body.contains(progressBarEl)) {
            return progressBarEl;
        }
        if (!document.body) return null;

        let el = document.getElementById(PROGRESS_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = PROGRESS_ID;
            el.setAttribute('aria-hidden', 'true');
            el.style.cssText = [
                'position: fixed',
                'top: 0',
                'left: 0',
                'width: 0%',
                'height: 2px',
                'background-color: #4f46e5',
                'z-index: 99999',
                'pointer-events: none',
                'opacity: 0',
                'transition: width 180ms ease, opacity 180ms ease'
            ].join('; ');
            document.body.appendChild(el);
        }
        progressBarEl = el;
        return el;
    }

    function startProgress() {
        clearTimeout(progressShowTimer);
        clearTimeout(progressHideTimer);
        const bar = getProgressBar();
        if (bar) {
            bar.style.transition = 'none';
            bar.style.width = '0%';
            bar.style.opacity = '0';
            void bar.offsetWidth;
            bar.style.transition = 'width 260ms ease, opacity 150ms ease';
        }
        progressShowTimer = setTimeout(() => {
            const el = getProgressBar();
            if (!el) return;
            el.style.opacity = '1';
            el.style.width = '68%';
        }, 100);
    }

    function finishProgress() {
        clearTimeout(progressShowTimer);
        progressShowTimer = null;
        const bar = getProgressBar();
        if (!bar) return;
        if (bar.style.opacity === '1') {
            bar.style.transition = 'width 140ms ease, opacity 180ms ease';
            bar.style.width = '100%';
            progressHideTimer = setTimeout(() => {
                bar.style.opacity = '0';
                progressHideTimer = setTimeout(() => {
                    bar.style.transition = 'none';
                    bar.style.width = '0%';
                }, 190);
            }, 140);
        } else {
            bar.style.width = '0%';
            bar.style.opacity = '0';
        }
    }

    function fetchPjaxHtml(urlObj, signal) {
        const key = getCacheKey(urlObj);
        const promise = (async () => {
            const res = await fetch(urlObj.href, {
                method: 'GET',
                headers: {
                    'X-PJAX': '1',
                    'Accept': 'text/html'
                },
                credentials: 'same-origin',
                signal
            });

            const finalUrl = res.url || urlObj.href;
            const finalUrlObj = new URL(finalUrl, window.location.href);
            const contentType = (res.headers.get('content-type') || '').toLowerCase();
            const remoteRev = res.headers.get('x-cardval-asset-rev') || '';

            if (isAssetRevStale(remoteRev)) {
                pageCache.clear();
                const err = new Error('Asset revision updated');
                err.fallbackUrl = finalUrlObj.href;
                throw err;
            }

            if (!res.ok || !contentType.includes('text/html') || !isPjaxEligibleUrl(finalUrlObj)) {
                const err = new Error('PJAX fallback');
                err.fallbackUrl = finalUrlObj.href;
                throw err;
            }

            const html = await res.text();
            const finalKey = getCacheKey(finalUrlObj);
            setCachedPage(finalKey, html, finalUrlObj.href);
            if (key !== finalKey) {
                setCachedPage(key, html, finalUrlObj.href);
            }
            return html;
        })();

        inflightFetches.set(key, promise);
        promise.finally(() => {
            if (inflightFetches.get(key) === promise) {
                inflightFetches.delete(key);
            }
        });
        return promise;
    }

    function parseCandidateAnchor(a) {
        if (!a || a.target === '_blank' || a.hasAttribute('download') || a.hasAttribute('data-no-pjax')) {
            return null;
        }
        const rawHref = a.getAttribute('href');
        if (!rawHref) return null;
        const trimmed = rawHref.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.toLowerCase().startsWith('javascript:')) {
            return null;
        }

        let urlObj;
        try {
            urlObj = new URL(a.href, window.location.href);
        } catch (_) {
            return null;
        }

        if (urlObj.origin !== window.location.origin) return null;
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return null;

        const pathname = urlObj.pathname || '';
        if (
            pathname.includes('export/csv') ||
            (urlObj.search && urlObj.search.includes('export/csv')) ||
            pathname.startsWith('/traders/validate/') ||
            pathname.startsWith('/uploads/') ||
            pathname.startsWith('/api/') ||
            pathname.startsWith('/language/') ||
            pathname.includes('/language/')
        ) {
            return null;
        }
        return urlObj;
    }

    function prefetchUrl(urlObj) {
        if (!urlObj) return;
        const key = getCacheKey(urlObj);

        if (isPjaxEligibleUrl(urlObj)) {
            if (getCachedPage(key) || inflightFetches.has(key)) return;
            if (activePrefetches >= MAX_CONCURRENT_PREFETCHES) return;

            activePrefetches++;
            fetchPjaxHtml(urlObj, undefined)
                .catch(() => {})
                .finally(() => {
                    activePrefetches = Math.max(0, activePrefetches - 1);
                });
            return;
        }

        // Standard prefetch once for non-PJAX pages (e.g. /profile or leaving /profile)
        if (!prefetchedHeadUrls.has(key) && document.head) {
            prefetchedHeadUrls.add(key);
            const link = document.createElement('link');
            link.rel = 'prefetch';
            link.href = urlObj.href;
            document.head.appendChild(link);
        }
    }

    const DESKTOP_ACTIVE_CLASSES = ['border-indigo-400', 'text-gray-900'];
    const DESKTOP_INACTIVE_CLASSES = ['border-transparent', 'text-gray-500', 'hover:text-gray-700', 'hover:border-gray-300'];
    const MOBILE_ACTIVE_CLASSES = ['border-indigo-400', 'text-indigo-700', 'bg-indigo-50'];
    const MOBILE_INACTIVE_CLASSES = ['border-transparent', 'text-gray-600', 'hover:text-gray-800', 'hover:bg-gray-50', 'hover:border-gray-300'];

    function updateActiveNavLinks(activePath) {
        const normalizedActive = (activePath || '/').replace(/\/+$/, '') || '/';
        const navLinks = document.querySelectorAll('[data-nav-link]');
        navLinks.forEach((link) => {
            const targetPath = (link.getAttribute('data-nav-link') || '').replace(/\/+$/, '') || '/';
            const variant = link.getAttribute('data-nav-variant');
            const isActive = normalizedActive === targetPath;

            if (variant === 'mobile') {
                link.classList.remove(...MOBILE_ACTIVE_CLASSES, ...MOBILE_INACTIVE_CLASSES);
                link.classList.add(...(isActive ? MOBILE_ACTIVE_CLASSES : MOBILE_INACTIVE_CLASSES));
            } else {
                link.classList.remove(...DESKTOP_ACTIVE_CLASSES, ...DESKTOP_INACTIVE_CLASSES);
                link.classList.add(...(isActive ? DESKTOP_ACTIVE_CLASSES : DESKTOP_INACTIVE_CLASSES));
            }
        });
    }

    async function navigateTo(href, { pushState = true, fromPopstate = false } = {}) {
        let urlObj;
        try {
            urlObj = new URL(href, window.location.href);
        } catch (_) {
            window.location.assign(href);
            return;
        }

        if (!isPjaxEligibleUrl(urlObj)) {
            window.location.assign(urlObj.href);
            return;
        }

        if (activeNavController) {
            activeNavController.abort();
            activeNavController = null;
        }

        const controller = new AbortController();
        activeNavController = controller;
        const myToken = ++navToken;
        const key = getCacheKey(urlObj);

        startProgress();

        try {
            let html = null;
            let finalUrl = urlObj.href;

            const cached = getCachedPage(key);
            if (cached) {
                html = cached.html;
                finalUrl = cached.finalUrl || urlObj.href;
            } else {
                const existingInflight = inflightFetches.get(key);
                if (existingInflight) {
                    try {
                        html = await existingInflight;
                        const cachedAfter = getCachedPage(key);
                        if (cachedAfter && cachedAfter.finalUrl) {
                            finalUrl = cachedAfter.finalUrl;
                        }
                    } catch (err) {
                        if (err && err.fallbackUrl) {
                            if (myToken === navToken && !controller.signal.aborted) {
                                window.location.assign(err.fallbackUrl);
                            }
                            return;
                        }
                        html = null;
                    }
                }

                if (html === null) {
                    if (myToken !== navToken || controller.signal.aborted) return;
                    try {
                        html = await fetchPjaxHtml(urlObj, controller.signal);
                        const cachedAfter = getCachedPage(key);
                        if (cachedAfter && cachedAfter.finalUrl) {
                            finalUrl = cachedAfter.finalUrl;
                        }
                    } catch (err) {
                        if (err && err.name === 'AbortError') return;
                        if (myToken !== navToken || controller.signal.aborted) return;
                        window.location.assign((err && err.fallbackUrl) || urlObj.href);
                        return;
                    }
                }
            }

            if (myToken !== navToken || controller.signal.aborted) return;

            const finalUrlObj = new URL(finalUrl, window.location.href);
            if (!isPjaxEligibleUrl(finalUrlObj)) {
                window.location.assign(finalUrlObj.href);
                return;
            }

            const nextDoc = new DOMParser().parseFromString(html, 'text/html');
            const nextModalRev = nextDoc.getElementById('printModal')?.dataset?.assetRev || '';
            const nextContainer = nextDoc.getElementById('pjax-container');
            const currentContainer = document.getElementById('pjax-container');
            if (!nextContainer || !currentContainer || isAssetRevStale(nextModalRev)) {
                pageCache.clear();
                window.location.assign(finalUrlObj.href);
                return;
            }

            const printModal = document.getElementById('printModal');
            if (printModal && printModal.style.display !== 'none' && !printModal.classList.contains('hidden')) {
                window.closePrintModal?.();
            }

            currentContainer.innerHTML = nextContainer.innerHTML;
            currentContainer.dataset.navPath = nextContainer.dataset.navPath || '';

            if (nextDoc.title) {
                document.title = nextDoc.title;
            }

            const navPath = nextContainer.dataset.navPath || finalUrlObj.pathname;
            updateActiveNavLinks(navPath);

            const targetFullUrl = urlObj.hash && finalUrlObj.href === urlObj.href.split('#')[0]
                ? `${finalUrlObj.href}${urlObj.hash}`
                : finalUrlObj.href;

            if (pushState && !fromPopstate && targetFullUrl !== window.location.href) {
                history.pushState({ pjax: true, url: targetFullUrl }, '', targetFullUrl);
            }

            currentPageKey = getCacheKey(finalUrlObj);

            if (!fromPopstate) {
                window.scrollTo(0, 0);
            }
        } finally {
            if (myToken === navToken) {
                activeNavController = null;
                finishProgress();
            }
        }
    }

    // Hover / Pointerdown / Touchstart Prefetch
    document.addEventListener('mouseover', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        if (e.relatedTarget && a.contains(e.relatedTarget)) return;
        const urlObj = parseCandidateAnchor(a);
        if (!urlObj) return;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => prefetchUrl(urlObj), HOVER_DEBOUNCE_MS);
    }, { passive: true });

    document.addEventListener('mouseout', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        if (e.relatedTarget && a.contains(e.relatedTarget)) return;
        clearTimeout(hoverTimer);
    }, { passive: true });

    document.addEventListener('pointerdown', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        const urlObj = parseCandidateAnchor(a);
        if (urlObj) prefetchUrl(urlObj);
    }, { passive: true });

    document.addEventListener('touchstart', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        const urlObj = parseCandidateAnchor(a);
        if (urlObj) prefetchUrl(urlObj);
    }, { passive: true });

    // Click Interception
    document.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
            return;
        }
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        const urlObj = parseCandidateAnchor(a);
        if (!urlObj || !isPjaxEligibleUrl(urlObj)) return;

        // Allow native same-page hash scrolling
        if (
            urlObj.hash &&
            urlObj.pathname === window.location.pathname &&
            urlObj.search === window.location.search
        ) {
            return;
        }

        e.preventDefault();
        navigateTo(urlObj.href);
    });

    // Browser Back/Forward
    window.addEventListener('popstate', () => {
        if (!document.getElementById('pjax-container')) return;
        let currentUrlObj;
        try {
            currentUrlObj = new URL(window.location.href);
        } catch (_) {
            return;
        }
        const nextKey = getCacheKey(currentUrlObj);
        if (nextKey === currentPageKey && currentUrlObj.hash) {
            return;
        }
        navigateTo(window.location.href, { pushState: false, fromPopstate: true });
    });

    // Form Interception: Instant AJAX Delete, Mutation Cache Clear, GET Search PJAX
    document.addEventListener('submit', async (e) => {
        const form = e.target;
        if (!form || form.tagName !== 'FORM' || e.defaultPrevented) return;

        const methodInput = form.querySelector('input[name="_method"]');
        const overrideMethod = methodInput ? String(methodInput.value || '').trim().toLowerCase() : '';
        const formMethod = String(form.getAttribute('method') || 'get').trim().toLowerCase();

        // 1. Instant AJAX Delete
        if (overrideMethod === 'delete') {
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
                    },
                    credentials: 'same-origin'
                });
                const data = await res.json().catch(() => null);
                if (res.ok && data && data.success) {
                    pageCache.clear();
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

            if (rowEl) {
                rowEl.style.opacity = '1';
                rowEl.style.pointerEvents = '';
            }
            pageCache.clear();
            form.submit();
            return;
        }

        // 1b. Instant AJAX Restore & Permanent Delete
        const isRestore = form.hasAttribute('data-restore-form');
        const isPermanentDelete = form.hasAttribute('data-permanent-delete-form');
        if (isRestore || isPermanentDelete) {
            e.preventDefault();
            const rowEl = form.closest('.p-6.flex.space-x-2');
            const isDeletedFilter = new URLSearchParams(window.location.search).get('status') === 'deleted';
            if (rowEl) {
                rowEl.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
                rowEl.style.opacity = '0.35';
                rowEl.style.pointerEvents = 'none';
            }

            try {
                const res = await fetch(form.action, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'X-Requested-With': 'fetch'
                    },
                    credentials: 'same-origin'
                });
                const data = await res.json().catch(() => null);
                if (res.ok && data && data.success) {
                    pageCache.clear();
                    if (rowEl && (isPermanentDelete || isDeletedFilter)) {
                        rowEl.style.opacity = '0';
                        rowEl.style.transform = 'translateX(12px)';
                        setTimeout(() => rowEl.remove(), 160);
                    } else if (isPermanentDelete && data.redirectUrl) {
                        window.location.assign(data.redirectUrl);
                    } else {
                        window.location.reload();
                    }
                    return;
                }
            } catch (_) {}

            if (rowEl) {
                rowEl.style.opacity = '1';
                rowEl.style.pointerEvents = '';
            }
            pageCache.clear();
            form.submit();
            return;
        }

        // 2. Non-GET Mutations: clear nav cache and allow normal submission
        if (formMethod !== 'get' || (overrideMethod && overrideMethod !== 'get')) {
            pageCache.clear();
            return;
        }

        // 3. GET Search Forms
        const formTarget = e.submitter?.getAttribute('formtarget') || form.getAttribute('target');
        if (formTarget === '_blank') return;

        const actionAttr = e.submitter?.getAttribute('formaction') || form.getAttribute('action') || window.location.pathname;
        if (actionAttr.includes('export/csv')) return;

        let resolvedAction;
        try {
            resolvedAction = new URL(actionAttr, window.location.href);
        } catch (_) {
            return;
        }

        if (!isPjaxEligibleUrl(resolvedAction)) return;

        const params = new URLSearchParams();
        const fd = new FormData(form);
        for (const [k, v] of fd.entries()) {
            if (typeof v === 'string') {
                params.append(k, v);
            }
        }
        const qs = params.toString();
        const targetUrl = qs
            ? `${resolvedAction.origin}${resolvedAction.pathname}?${qs}`
            : `${resolvedAction.origin}${resolvedAction.pathname}`;

        e.preventDefault();
        navigateTo(targetUrl);
    });

    // Delegated Photo Preview (#person_pic)
    window.readURL = function (input) {
        if (!input || !input.files || !input.files[0]) return;
        if (input.__cardvalReadPending) return;
        input.__cardvalReadPending = true;
        queueMicrotask(() => {
            input.__cardvalReadPending = false;
        });

        const preview = document.getElementById('pp_preview');
        if (!preview) return;
        const reader = new FileReader();
        reader.onload = function (e) {
            const targetPreview = document.getElementById('pp_preview');
            if (targetPreview && e.target && e.target.result) {
                targetPreview.src = e.target.result;
            }
        };
        reader.readAsDataURL(input.files[0]);
    };

    document.addEventListener('change', (e) => {
        const input = e.target;
        if (input && input.id === 'person_pic') {
            window.readURL(input);
        }
    });

    // Lazy Print Modal Loader
    function ensureCardModalCss() {
        if (document.querySelector('link[href*="/css/cardModal.css"]')) {
            return Promise.resolve();
        }
        if (cardModalCssPromise) return cardModalCssPromise;
        cardModalCssPromise = new Promise((resolve) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = '/css/cardModal.css?v=10';
            link.onload = () => resolve();
            link.onerror = () => {
                cardModalCssPromise = null;
                link.remove();
                resolve();
            };
            document.head.appendChild(link);
        });
        return cardModalCssPromise;
    }

    function ensureCardModalJs() {
        if (typeof window.__realOpenPrintModal === 'function') {
            return Promise.resolve();
        }
        if (cardModalJsPromise) return cardModalJsPromise;
        cardModalJsPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/js/cardModal.js?v=26';
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => {
                cardModalJsPromise = null;
                reject(new Error('Failed to load /js/cardModal.js?v=26'));
            };
            document.head.appendChild(script);
        });
        return cardModalJsPromise;
    }

    if (typeof window.__realOpenPrintModal !== 'function') {
        let lazyModalToken = 0;

        if (typeof window.closePrintModal !== 'function') {
            window.closePrintModal = function () {
                lazyModalToken++;
                const modalEl = document.getElementById('printModal');
                if (modalEl) {
                    modalEl.style.display = 'none';
                    modalEl.classList.add('hidden');
                }
            };
        }

        const lazyOpenPrintModal = async function (traderId, uuid, options) {
            const token = ++lazyModalToken;
            const modalEl = document.getElementById('printModal');
            const titleEl = document.getElementById('modalTitle');
            const isArUi = String(document.documentElement.lang || 'ar').toLowerCase().startsWith('ar');
            if (modalEl) {
                modalEl.style.display = 'block';
                modalEl.classList.remove('hidden');
            }
            if (titleEl) {
                titleEl.innerText = isArUi ? 'جاري تحميل أداة الطباعة...' : 'Loading print tool...';
            }

            try {
                await Promise.all([ensureCardModalCss(), ensureCardModalJs()]);
                if (token !== lazyModalToken) return;
                if (typeof window.__realOpenPrintModal === 'function') {
                    return window.__realOpenPrintModal(traderId, uuid, options);
                }
                if (typeof window.openPrintModal === 'function' && window.openPrintModal !== lazyOpenPrintModal) {
                    return window.openPrintModal(traderId, uuid, options);
                }
            } catch (err) {
                if (token === lazyModalToken && titleEl) {
                    titleEl.innerText = isArUi ? 'تعذر تحميل أداة الطباعة' : 'Failed to load print tool';
                }
            }
        };

        window.openPrintModal = lazyOpenPrintModal;
    }

    // Reopen pending print modal automatically after an asset-revision reload
    try {
        const rawPending = sessionStorage.getItem('cardval_pending_modal');
        if (rawPending) {
            sessionStorage.removeItem('cardval_pending_modal');
            const pending = JSON.parse(rawPending);
            if (pending && Date.now() - Number(pending.ts || 0) < 15000 && typeof window.openPrintModal === 'function') {
                setTimeout(() => {
                    window.openPrintModal(pending.traderId || '', pending.uuid || '', pending.options || {});
                }, 0);
            }
        }
    } catch (_) {}
})();
