// Removes the emscripten glue's empty process-wide uncaughtException listener from
// @agnai/web-tokenizers. That listener swallows every uncaught exception once a tokenizer has
// loaded, so the process keeps running (and `node --test` files exit 0) after a crash.
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'node_modules', '@agnai', 'web-tokenizers', 'lib', 'index.js');
const listener = 'process.on("uncaughtException",function(ex){if(!(ex instanceof ExitStatus)){}});';
const before = 'process.argv.slice(2);';
const after = 'var nodeMajor=process.versions.node.split(".")[0];';
const originalForm = before + listener + after;
const patchedForm = before + after;

function fail(message) {
    console.error(`patch-web-tokenizers: ${message} (${file})`);
    process.exit(1);
}

if (!fs.existsSync(file)) {
    fail('file not found');
}

const source = fs.readFileSync(file, 'utf8');
const count = (text) => source.split(text).length - 1;
const originalCount = count(originalForm);
const patchedCount = count(patchedForm);

if (originalCount === 1 && patchedCount === 0) {
    fs.writeFileSync(file, source.replace(originalForm, patchedForm));
    console.log('patch-web-tokenizers: removed the uncaughtException listener');
} else if (originalCount === 0 && patchedCount === 1) {
    console.log('patch-web-tokenizers: already patched');
} else {
    fail(`unexpected shape: original form found ${originalCount} time(s), patched form found ${patchedCount} time(s)`);
}
