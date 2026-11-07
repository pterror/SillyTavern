/**
 * Every request the page makes says which session it's from (getRequestHeaders sends X-ST-Session, 'none' before
 * the tab has one), and the server refuses one that doesn't. Tests that call the server's routes stand in for the
 * page, so their requests say it too unless they set it themselves.
 */
const pageFetch = globalThis.fetch;

globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('X-ST-Session')) headers.set('X-ST-Session', 'none');
    return pageFetch(input, { ...init, headers });
};
