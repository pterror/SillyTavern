const VERSION_PARAM = 'stv';

/** @type {{modules: Record<string, string>, runtime: Record<string, string>}|null} */
let maps = null;

function readMaps() {
    if (maps) {
        return maps;
    }
    const parse = (/** @type {Element|null} */ element) => {
        try {
            return element?.textContent ? JSON.parse(element.textContent) : {};
        } catch {
            return {};
        }
    };
    maps = {
        modules: parse(document.querySelector('script[type="importmap"]'))?.imports ?? {},
        runtime: parse(document.getElementById('st-asset-versions')),
    };
    return maps;
}

/**
 * @param {string} url
 * @returns {string}
 */
export function assetUrl(url) {
    let resolved;
    try {
        resolved = new URL(url, document.baseURI);
    } catch {
        return url;
    }
    if (resolved.origin !== location.origin || resolved.search) {
        return url;
    }
    const { modules, runtime } = readMaps();
    const pathname = decodeURIComponent(resolved.pathname);
    if (modules[pathname]) {
        return modules[pathname] + resolved.hash;
    }
    if (runtime[pathname]) {
        return `${resolved.pathname}?${VERSION_PARAM}=${runtime[pathname]}${resolved.hash}`;
    }
    return url;
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function fetchAsset(url, init) {
    const response = await fetch(assetUrl(url), init);
    if (response.status === 409 && response.headers.get('X-ST-Stale-Asset')) {
        showReloadNotice();
    }
    return response;
}

const BUILD_CHECK_INTERVAL_MS = 10000;
let lastBuildCheck = 0;
let reloadNoticeShown = false;

/**
 * @returns {Promise<void>}
 */
export async function reportAssetLoadFailure() {
    if (reloadNoticeShown || Date.now() - lastBuildCheck < BUILD_CHECK_INTERVAL_MS) {
        return;
    }
    lastBuildCheck = Date.now();
    const ownBuild = document.querySelector('meta[name="st-build"]')?.getAttribute('content');
    if (!ownBuild) {
        return;
    }
    try {
        const response = await fetch('/api/frontend/build', { cache: 'no-store' });
        if (!response.ok) {
            return;
        }
        const { buildId } = await response.json();
        if (buildId && buildId !== ownBuild) {
            showReloadNotice();
        }
    } catch {
        // The server can't be reached; that has its own notices.
    }
}

export function showReloadNotice() {
    if (reloadNoticeShown) {
        return;
    }
    reloadNoticeShown = true;
    const toastr = /** @type {any} */ (window).toastr;
    const message = 'The server has newer files than this page. Reload to use them; until then, parts that haven\'t loaded yet may not work.'
        + '<br><button type="button" class="menu_button stReloadPage">Reload</button>';
    const options = { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true, escapeHtml: false, preventDuplicates: true };
    const toast = toastr?.warning(message, 'SillyTavern was updated', options);
    const button = toast?.[0]?.querySelector?.('.stReloadPage');
    button?.addEventListener('click', () => location.reload());
    document.body.dataset.frontendOutdated = 'true';
}

const MODULE_LOAD_FAILURE = /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

function watchForStaleFiles() {
    window.addEventListener('unhandledrejection', event => {
        const reason = event.reason;
        const message = reason instanceof Error ? reason.message : String(reason ?? '');
        if (MODULE_LOAD_FAILURE.test(message)) {
            void reportAssetLoadFailure();
        }
    });

    if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('resource')) {
        new PerformanceObserver(list => {
            for (const entry of /** @type {PerformanceResourceTiming[]} */ (list.getEntries())) {
                if (entry.responseStatus === 409 && entry.name.includes(`${VERSION_PARAM}=`)) {
                    showReloadNotice();
                }
            }
        }).observe({ type: 'resource', buffered: true });
    }

    window.addEventListener('error', event => {
        const target = event.target;
        if (target instanceof HTMLScriptElement || target instanceof HTMLLinkElement) {
            void reportAssetLoadFailure();
        }
    }, true);
}

if (typeof window !== 'undefined') {
    watchForStaleFiles();
}
