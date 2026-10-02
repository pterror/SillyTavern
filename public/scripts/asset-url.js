// The server writes the page's content hashes into it: an import map for modules, and a json map for what code
// fetches or links at runtime. A url carrying its file's current hash is cached by the browser for good.

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
 * The url to load one of our frontend files with: the same file, pinned to the content hash this page was built
 * with. A url that isn't one of ours, or already has a query, comes back unchanged.
 * @param {string} url Relative to the page, or root-relative
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
 * Fetches one of our frontend files at the version this page was built with. If the server no longer has that
 * version, the user is told to reload.
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
 * A file of ours failed to load. If the server's files changed since this page was built, says so; otherwise it
 * was some other failure, and the caller's own error handling stands.
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

/**
 * Tells the user this page is older than the server's files, without blocking anything. For a response that
 * carried the server's stale-file marker.
 */
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

    // A failed dynamic import that its caller catches reaches neither the rejection nor the error listener; its
    // resource timing entry still records the server's 409, where the browser reports the status.
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

// Also loaded outside a page (unit tests import modules that import this one).
if (typeof window !== 'undefined') {
    watchForStaleFiles();
}
