const { stripTypeScriptTypes } = require('node:module');

module.exports = {
    process(source) {
        return { code: stripTypeScriptTypes(source, { mode: 'strip' }) };
    },
};
