import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'default', 'config.yaml'));

const { TEXTGEN_TYPES } = await import('./constants.js');
const { fetchLlamaCppProps } = await import('./llamacpp-props.js');
const { lookupBackendModel } = await import('./backend-status.js');
const { lookupCustomLlamaCppModel } = await import('./custom-llamacpp.js');
const { encodeWithTokenizer, resolveTokenizer } = await import('./tokenizer-resolve.js');

/** @returns {Promise<string>} */
function closedPortUrl() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {net.AddressInfo} */ (probe.address());
            probe.close(() => resolve(`http://127.0.0.1:${port}`));
        });
    });
}

/**
 * @param {() => Promise<void>} fn
 * @returns {Promise<string[]>}
 */
async function consoleLinesOf(fn) {
    const methods = /** @type {const} */ (['log', 'info', 'warn', 'error', 'debug']);
    const saved = methods.map(name => console[name]);
    /** @type {string[]} */
    const lines = [];
    for (const name of methods) {
        console[name] = (...args) => {
            lines.push(...args.map(arg => arg instanceof Error ? String(arg.stack) : typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ').split('\n'));
        };
    }
    try {
        await fn();
    } finally {
        methods.forEach((name, i) => { console[name] = saved[i]; });
    }
    return lines;
}

test('a llama.cpp that isn\'t running is logged once, in one line, with no stack trace', async () => {
    const url = await closedPortUrl();
    const lines = await consoleLinesOf(async () => {
        assert.equal(await fetchLlamaCppProps({ url }), null);
        assert.equal(await lookupBackendModel({ api: 'textgenerationwebui', type: TEXTGEN_TYPES.LLAMACPP, url }), null);
        assert.equal(await lookupCustomLlamaCppModel({ url, headers: {} }), null);
        const remote = /** @type {any} */ ({ kind: 'remote', name: 'API (Text Completion)', llamaCpp: { url, model: '', headers: {} } });
        for (let i = 0; i < 3; i++) {
            assert.equal(await encodeWithTokenizer(remote, `Text ${i}`), null);
        }
    });
    assert.equal(lines.length, 1, `expected one line, got:\n${lines.join('\n')}`);
    assert.match(lines[0], new RegExp(url.replace(/[.:/]/g, '\\$&')));
    assert.match(lines[0], /ECONNREFUSED|isn't running|not running|reach/i);
});

test('with no URL set nothing is asked and nothing is logged', async () => {
    const lines = await consoleLinesOf(async () => {
        assert.equal(await fetchLlamaCppProps({ url: '' }), null);
        for (const type of [TEXTGEN_TYPES.LLAMACPP, TEXTGEN_TYPES.OOBA]) {
            assert.equal(await lookupBackendModel({ api: 'textgenerationwebui', type, url: '' }), null);
        }
        for (const type of [TEXTGEN_TYPES.LLAMACPP, TEXTGEN_TYPES.OOBA]) {
            const resolved = await resolveTokenizer({ api: 'textgenerationwebui', type, url: '', model: '' });
            assert.notEqual(resolved.kind, 'remote');
        }
    });
    assert.deepEqual(lines, []);
});
