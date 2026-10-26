// The packages are TypeScript that Node runs by stripping the types (erasable syntax only). Jest loads modules
// itself, so it strips them the same way, with Node's own stripper: what runs in a test is what runs in the server.
const { stripTypeScriptTypes } = require('node:module');

module.exports = {
    process(source) {
        return { code: stripTypeScriptTypes(source, { mode: 'strip' }) };
    },
};
