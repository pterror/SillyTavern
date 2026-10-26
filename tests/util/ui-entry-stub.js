// /ui/entry.js is the built new page, which the server serves (packages/serve-ui); unit tests of old page modules
// import it through public/scripts/new-ui.js but never start it.
export function start() {
    throw new Error('The new page is not available in unit tests');
}

/** No settings are the server's in unit tests of old page modules: they keep the old page's behavior. */
export const SERVER_OWNED = new Set();
