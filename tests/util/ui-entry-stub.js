// /ui/entry.js is the built new page, which the server serves (packages/serve-ui); unit tests of old page modules
// import it through public/scripts/new-ui.js but never start it.
export function start() {
    throw new Error('The new page is not available in unit tests');
}
