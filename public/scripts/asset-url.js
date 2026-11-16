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
/** The header each API answer names the server's build of the page in, as the page's `st-build` meta names its own */
const BUILD_HEADER = 'X-ST-Build';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let lastBuildCheck = 0;
let outdated = false;

/** A write the page didn't send, because the server was updated and might misread what this page sends */
export class PageOutdatedError extends Error {
    constructor() {
        super('SillyTavern was updated; the page sends no more writes until it is reloaded');
        this.name = 'PageOutdatedError';
    }
}

/**
 * @returns {Promise<void>}
 */
async function reportAssetLoadFailure() {
    if (outdated || Date.now() - lastBuildCheck < BUILD_CHECK_INTERVAL_MS) {
        return;
    }
    lastBuildCheck = Date.now();
    try {
        const response = await fetch('/api/frontend/build', { cache: 'no-store' });
        if (!response.ok) {
            return;
        }
        const { buildId } = await response.json();
        takeServerBuild(buildId);
    } catch {
        // The server can't be reached; that has its own notices.
    }
}

/**
 * @param {unknown} build the server's build of the page
 */
function takeServerBuild(build) {
    const own = document.querySelector('meta[name="st-build"]')?.getAttribute('content');
    if (own && typeof build === 'string' && build !== '' && build !== own) {
        showReloadNotice();
    }
}

/**
 * @param {string} method
 * @param {string} url
 * @returns {boolean} whether the request is a write to the server's API
 */
function isApiWrite(method, url) {
    if (!WRITE_METHODS.has(method.toUpperCase())) return false;
    try {
        const target = new URL(url, location.href);
        return target.origin === location.origin && target.pathname.startsWith('/api/');
    } catch {
        return false;
    }
}

/**
 * The page is older than the server's: it sends no more writes, and says so once, with a way to reload. It doesn't
 * reload by itself, so nothing typed is lost.
 */
export function showReloadNotice() {
    if (outdated) {
        return;
    }
    outdated = true;
    const toastr = /** @type {any} */ (window).toastr;
    const message = 'SillyTavern was updated. Reload to keep going.'
        + '<br><button type="button" class="menu_button stReloadPage">Reload</button>';
    const options = { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: false, escapeHtml: false, preventDuplicates: true };
    const toast = toastr?.warning(message, '', options);
    const button = toast?.[0]?.querySelector?.('.stReloadPage');
    button?.addEventListener('click', () => location.reload());
    document.body.dataset.frontendOutdated = 'true';
}

/**
 * @returns {boolean} whether the page knows the server serves a newer build of it
 */
export function isPageOutdated() {
    return outdated;
}

/**
 * Reads the server's build off every API answer, and holds back every API write once the page is outdated: through
 * fetch and through jQuery's ajax
 */
function watchServerBuild() {
    const fetch = window.fetch;
    window.fetch = async function (input, init) {
        const request = input instanceof Request ? input : null;
        const url = request ? request.url : String(input);
        if (outdated && isApiWrite(init?.method ?? request?.method ?? 'GET', url)) {
            throw new PageOutdatedError();
        }
        const response = await fetch.call(this, input, init);
        takeServerBuild(response.headers.get(BUILD_HEADER));
        return response;
    };
    const jQuery = /** @type {any} */ (window).jQuery;
    jQuery?.ajaxPrefilter?.((/** @type {any} */ options, /** @type {any} */ _original, /** @type {any} */ xhr) => {
        if (outdated && isApiWrite(String(options.type ?? options.method ?? 'GET'), String(options.url ?? ''))) {
            xhr.abort('the page is outdated');
        }
    });
    jQuery?.(document).ajaxComplete?.((/** @type {unknown} */ _event, /** @type {any} */ xhr) => {
        takeServerBuild(xhr?.getResponseHeader?.(BUILD_HEADER));
    });
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
    watchServerBuild();
}
