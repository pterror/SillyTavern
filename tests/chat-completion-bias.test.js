import fs from 'node:fs';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const showTokenizerWarnings = jest.fn();
const power_user = { tokenizer: 99, token_padding: 64 };

// Stands in for every import these tests don't exercise: callable, constructible, and every
// property is itself.
const stub = new Proxy(function () {}, {
    get: (_target, prop) => {
        if (prop === Symbol.toPrimitive) return () => '';
        if (prop === 'then') return undefined;
        if (prop === 'length') return 0;
        return stub;
    },
    apply: () => stub,
    construct: () => stub,
});
global.$ = stub;
global.jQuery = { ajax: jest.fn() };
global.document = stub;
global.window = stub;
global.CSS = stub;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.sessionStorage = { getItem: () => null, setItem: () => {} };
global.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };

const overrides = {
    '../lib.js': { localforage: { createInstance: () => ({ removeItem: async () => {} }) } },
    '../script.js': { nai_settings: { model_novel: '' }, online_status: 'no_connection' },
    './generation-params.js': { main_api: 'openai' },
    './request-headers.js': { getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) },
    './power-user.js': { power_user },
    './tokenizer-notices.js': { showTokenizerWarnings },
    './utils.js': { debounce: (fn) => fn, getStringHash: (str) => String(str).length },
    './i18n.js': { t: (strings) => strings.join('') },
    './textgen-settings.js': {
        SERVER_INPUTS: {}, textgen_types: {}, textgenerationwebui_settings: { type: 'ooba' },
        getTextGenServer: () => '', getTextGenModel: () => '',
    },
    './kai-settings.js': { kai_settings: { api_server: '' } },
    './horde.js': { horde_settings: { models: [] } },
};

// Every module the two real modules import is mocked, with stubs for the names they import.
const realModules = ['chat-completion-settings.js', 'tokenizers.js'];
const scriptsUrl = new URL('../public/scripts/', import.meta.url);
/** @type {Map<string, object>} */
const mocks = new Map();
for (const file of realModules) {
    const source = fs.readFileSync(new URL(file, scriptsUrl), 'utf8');
    for (const [, names, from] of source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';/gm)) {
        if (realModules.includes(from.replace('./', ''))) continue;
        const stubs = names.split(',').map(name => name.trim().split(/\s+as\s+/)[0]).filter(Boolean).map(name => [name, stub]);
        mocks.set(from, { ...mocks.get(from), ...Object.fromEntries(stubs), ...overrides[from] });
    }
}
for (const [from, exports] of mocks) {
    jest.unstable_mockModule(new URL(from, scriptsUrl).pathname, () => exports);
}

function answer(overrides = {}) {
    return {
        id: 0,
        name: 'None',
        basis: 'unknown',
        key: 'openai|openai||some-unheard-of-model|none',
        messages: {
            dropped: {
                one: 'Left out {count} entry that need token ids, because no tokenizer is known for this model: {entries}',
                many: 'Left out {count} entries that need token ids, because no tokenizer is known for this model: {entries}',
            },
        },
        ...overrides,
    };
}

/** @type {(url: string, body: any) => any} */
let respond;

/** @type {typeof import('../public/scripts/chat-completion-settings.js')} */
let openai;
/** @type {typeof import('../public/scripts/tokenizers.js')} */
let tokenizersModule;

beforeEach(async () => {
    showTokenizerWarnings.mockClear();
    respond = () => ({ count: 1, tokenizer: answer() });
    global.jQuery.ajax = jest.fn((options) => {
        const data = respond(options.url, options.data ? JSON.parse(options.data) : undefined);
        options.success?.(data);
        return Promise.resolve(data);
    });
    global.fetch = jest.fn(async () => ({
        json: async () => ({ 11: 2 }),
        headers: new Headers({ 'X-ST-Tokenizer-Dropped': JSON.stringify(['hello', 'café']).replace(/é/, '\\u00e9') }),
    }));
    jest.resetModules();
    tokenizersModule = await import('../public/scripts/tokenizers.js');
    openai = await import('../public/scripts/chat-completion-settings.js');
    openai.initOpenAI();
    Object.assign(openai.oai_settings, {
        chat_completion_source: 'openai',
        openai_model: 'some-unheard-of-model',
        bias_preset_selected: 'Drop',
        bias_presets: { Drop: [{ id: 'a', text: 'hello', value: -5 }, { id: 'b', text: '[11]', value: 2 }, { id: 'c', text: 'café', value: 1 }] },
    });
    // The answer boot fetches.
    tokenizersModule.getFriendlyTokenizerName('openai');
});

function send() {
    return openai.createGenerationParameters(openai.oai_settings, 'some-unheard-of-model', 'normal', [{ role: 'user', content: 'Hi.' }]);
}

describe('chat-completion bias gets its ids from the server with the connection state', () => {
    test('the /bias request carries the state header, the bare entries body and no ?model=', async () => {
        const { generate_data } = await send();
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe('/api/backends/chat-completions/bias');
        expect(JSON.parse(init.body)).toEqual(openai.oai_settings.bias_presets.Drop);
        const header = init.headers['X-ST-Connection-State'];
        expect(header).toMatch(/^[\x20-\x7e]*$/);
        expect(JSON.parse(header)).toMatchObject({ api: 'openai', source: 'openai', model: 'some-unheard-of-model' });
        expect(JSON.parse(header)).not.toHaveProperty('tokenizer');
        expect(generate_data.logit_bias).toEqual({ 11: 2 });
    });

    test('every send toasts the entries the response header lists, in the server\'s words', async () => {
        await send();
        await send();
        expect(fetch).toHaveBeenCalledTimes(1);
        const warning = {
            kind: 'dropped',
            key: 'openai|openai||some-unheard-of-model|none',
            message: 'Left out 2 entries that need token ids, because no tokenizer is known for this model: hello, café',
            entries: ['hello', 'café'],
        };
        expect(showTokenizerWarnings.mock.calls).toEqual([[[warning]], [[warning]]]);
    });

    test('the cached bias is emptied when the server names a different tokenizer', async () => {
        await send();
        await send();
        expect(fetch).toHaveBeenCalledTimes(1);
        respond = (url) => url === '/api/tokenizers/current/count'
            ? { count: 1, tokenizer: answer({ id: 2, name: 'gpt-4o', basis: 'local', key: 'openai|openai||some-unheard-of-model|openai' }) }
            : { tokenizer: answer() };
        await tokenizersModule.countTokensOpenAIAsync({ role: 'user', content: 'x' });
        await send();
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
