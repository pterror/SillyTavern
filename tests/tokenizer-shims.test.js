import { beforeEach, describe, expect, jest, test } from '@jest/globals';

// The client's token counts and tokenizer-name shims ask the server's /api/tokenizers/current/*
// routes, sending the on-screen state and never a tokenizer.

const tokenizerIds = {
    NONE: 0, GPT2: 1, OPENAI: 2, LLAMA: 3, NERD: 4, NERD2: 5, API_CURRENT: 6, MISTRAL: 7, YI: 8,
    API_TEXTGENERATIONWEBUI: 9, API_KOBOLD: 10, CLAUDE: 11, LLAMA3: 12, GEMMA: 13, JAMBA: 14, QWEN2: 15,
    COMMAND_R: 16, NEMO: 17, DEEPSEEK: 18, COMMAND_A: 19, BEST_MATCH: 99,
};

const settings = {
    mainApi: 'textgenerationwebui',
    power_user: { tokenizer: tokenizerIds.BEST_MATCH, token_padding: 64 },
    textgen: { type: 'llamacpp', llamacpp_model: '', ollama_model: '', server_urls: { llamacpp: 'http://127.0.0.1:8080' } },
    oai: { chat_completion_source: 'nanogpt', nanogpt_model: 'claude-sonnet-4' },
};

/** @type {Array<{url: string, async: boolean, body: any}>} */
let requests;
/** @type {(url: string, body: any) => any} Answers a request; throwing makes it fail. */
let respond;
const storeItems = new Map([['tokenCache', { some_chat: { 'x-1+0': 5 } }]]);
const eventHandlers = new Map();

function answer(overrides = {}) {
    return { id: tokenizerIds.GEMMA, name: 'Gemma / Gemini', basis: 'local', key: 'textgenerationwebui|llamacpp|http://127.0.0.1:8080||gemma', ...overrides };
}

function defaultRespond(url, body) {
    if (url === '/api/tokenizers/current/tokenizer') {
        return { tokenizer: answer() };
    }
    if (url === '/api/tokenizers/current/count') {
        if (body.messages) {
            return { count: 7, tokenizer: answer({ id: tokenizerIds.OPENAI, name: 'gpt-4o', model: 'gpt-4o', key: 'openai|nanogpt||gpt-4o|openai' }) };
        }
        return { counts: body.texts.map(text => text.length + body.padding), tokenizer: answer() };
    }
    if (url === '/api/tokenizers/current/encode') {
        return { ids: body.texts.map(() => [1, 2]), tokenizer: answer() };
    }
    if (url === '/api/tokenizers/current/decode') {
        return { text: 'ab', chunks: ['a', 'b'], tokenizer: answer() };
    }
    if (url === '/api/tokenizers/current/trim') {
        return { text: 'trimmed', tokenizer: answer() };
    }
    return { ids: [3], count: 1, token_count: 1, text: '' };
}

global.jQuery = {
    ajax: jest.fn((options) => {
        const body = options.data ? JSON.parse(options.data) : undefined;
        requests.push({ url: options.url, async: options.async !== false, body });
        let data;
        try {
            data = respond(options.url, body);
        } catch (error) {
            options.error?.({}, 'error', error);
            return options.async === false ? {} : Promise.reject(error);
        }
        options.success?.(data);
        return Promise.resolve(data);
    }),
};
const jqueryElement = {
    on: jest.fn(function () { return this; }),
    find: jest.fn(function () { return this; }),
    text: jest.fn(() => 'None / Estimated'),
    val: jest.fn(() => String(settings.power_user.tokenizer)),
    toArray: jest.fn(() => []),
};
global.$ = jest.fn(() => jqueryElement);
global.document = {};
global.toastr = { info: jest.fn(), success: jest.fn(), error: jest.fn(), warning: jest.fn() };
global.sessionStorage = { getItem: jest.fn(() => null), setItem: jest.fn(), removeItem: jest.fn() };

const store = {
    getItem: jest.fn(async (key) => storeItems.get(key)),
    setItem: jest.fn(async (key, value) => { storeItems.set(key, value); }),
    removeItem: jest.fn(async (key) => { storeItems.delete(key); }),
};

jest.unstable_mockModule('../public/lib.js', () => ({ localforage: { createInstance: () => store } }));
jest.unstable_mockModule('../public/script.js', () => ({
    getCurrentCharacter: () => ({ chat: 'chat' }),
    getSelectionState: () => ({ type: 'character' }),
    nai_settings: { model_novel: 'kayra-v1' },
    online_status: 'no_connection',
}));
jest.unstable_mockModule('../public/scripts/generation-params.js', () => ({
    main_api: settings.mainApi,
}));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({ getRequestHeaders: () => ({}) }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({
    event_types: {
        CHAT_CHANGED: 'chat_id_changed', ONLINE_STATUS_CHANGED: 'online_status_changed',
        CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed', CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
        CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
    },
    eventSource: { on: (event, handler) => eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]) },
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: settings.power_user,
    registerDebugFunction: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/chat-completion-settings.js', () => ({
    chat_completion_sources: { OPENAI: 'openai', NANOGPT: 'nanogpt' },
    getChatCompletionModel: () => settings.oai.nanogpt_model,
    model_list: [],
    oai_settings: settings.oai,
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ groupsStore: { get: () => undefined } }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    debounce: (fn) => fn,
    getStringHash: (str) => [...String(str)].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) | 0, 7),
}));
jest.unstable_mockModule('../public/scripts/kai-settings.js', () => ({ kai_flags: {}, kai_settings: { api_server: '' } }));
jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    SERVER_INPUTS: { llamacpp: '#llamacpp_api_url_text' },
    textgen_types: { OOBA: 'ooba', TABBY: 'tabby', KOBOLDCPP: 'koboldcpp', LLAMACPP: 'llamacpp', VLLM: 'vllm', APHRODITE: 'aphrodite', OLLAMA: 'ollama', OPENROUTER: 'openrouter', DREAMGEN: 'dreamgen' },
    textgenerationwebui_settings: settings.textgen,
    getTextGenServer: (type) => settings.textgen.server_urls[type ?? settings.textgen.type] ?? '',
    getTextGenModel: (s) => (s ?? settings.textgen).type === 'llamacpp' ? ((s ?? settings.textgen).llamacpp_model || undefined) : undefined,
}));
jest.unstable_mockModule('../public/scripts/textgen-models.js', () => ({
    getCurrentDreamGenModelTokenizer: jest.fn(),
    getCurrentOpenRouterModelTokenizer: jest.fn(),
    openRouterModels: [],
}));
jest.unstable_mockModule('../public/scripts/horde.js', () => ({ horde_settings: { models: [] } }));

/** @type {typeof import('../public/scripts/tokenizers.js')} */
let tokenizersModule;

beforeEach(async () => {
    requests = [];
    respond = defaultRespond;
    settings.power_user.tokenizer = tokenizerIds.BEST_MATCH;
    eventHandlers.clear();
    await useApi('textgenerationwebui');
});

/**
 * Loads the module with `api` as main_api (a mocked module export is fixed when it loads).
 * @param {string} api
 */
async function useApi(api) {
    settings.mainApi = api;
    jest.resetModules();
    tokenizersModule = await import('../public/scripts/tokenizers.js');
}

const textgenState = {
    api: 'textgenerationwebui', type: 'llamacpp', url: 'http://127.0.0.1:8080', model: '', tokenizerSetting: tokenizerIds.BEST_MATCH,
};

describe('counts ask /current/count with the on-screen state', () => {
    test('getTokenCountsAsyncBatch posts every text in one request, with state and no tokenizer', async () => {
        const counts = await tokenizersModule.getTokenCountsAsyncBatch(['ab', '', 'cde'], 1);
        expect(counts).toEqual([3, 0, 4]);
        expect(requests.map(r => r.url)).toEqual(['/api/tokenizers/current/count']);
        expect(requests[0].body).toEqual({ state: textgenState, texts: ['ab', 'cde'], padding: 1 });
    });

    test('getTokenCountAsync posts to /current/count', async () => {
        expect(await tokenizersModule.getTokenCountAsync('abcd')).toBe(4);
        expect(requests).toEqual([{ url: '/api/tokenizers/current/count', async: true, body: { state: textgenState, texts: ['abcd'], padding: 0 } }]);
    });

    test('getTokenCount returns a number synchronously', () => {
        expect(tokenizersModule.getTokenCount('abcdef', 2)).toBe(8);
        expect(requests).toEqual([{ url: '/api/tokenizers/current/count', async: false, body: { state: textgenState, texts: ['abcdef'], padding: 2 } }]);
    });

    test('a failed count request gives the estimate plus padding, uncached', async () => {
        respond = () => { throw new Error('offline'); };
        const text = 'x'.repeat(67);
        expect(await tokenizersModule.getTokenCountAsync(text, 3)).toBe(Math.ceil(67 / 3.35) + 3);
        expect(tokenizersModule.getTokenCount(text, 3)).toBe(Math.ceil(67 / 3.35) + 3);
        respond = defaultRespond;
        expect(await tokenizersModule.getTokenCountAsync(text, 3)).toBe(70);
    });

    test('a chat-completion count posts messages with chat-completion state', async () => {
        await useApi('openai');
        expect(await tokenizersModule.getTokenCountAsync('hello')).toBe(7);
        expect(requests[0].url).toBe('/api/tokenizers/current/count');
        expect(requests[0].body).toEqual({
            state: { api: 'openai', source: 'nanogpt', model: 'claude-sonnet-4', tokenizerSetting: tokenizerIds.BEST_MATCH },
            messages: [{ content: 'hello' }],
        });
    });

    test('the chat-completion shadow-prompt count stays the local estimate', async () => {
        await useApi('openai');
        expect(await tokenizersModule.getTokenCountAsync('abcdefg', 64)).toBe(Math.ceil(7 / 3.35) + 64);
        expect(requests).toEqual([]);
    });

    test('a chat-completion HTTP error still rejects getTokenCountAsync', async () => {
        await useApi('openai');
        respond = () => { throw new Error('500'); };
        await expect(tokenizersModule.getTokenCountAsync('hello')).rejects.toThrow('500');
    });
});

describe('count cache', () => {
    test('a repeated count is served from the cache', async () => {
        await tokenizersModule.getTokenCountAsync('abc');
        await tokenizersModule.getTokenCountAsync('abc');
        expect(requests.length).toBe(1);
    });

    test('a count response naming a new tokenizer empties the cache', async () => {
        await tokenizersModule.getTokenCountAsync('abc');
        respond = (url, body) => ({ counts: body.texts.map(() => 1), tokenizer: answer({ id: tokenizerIds.API_TEXTGENERATIONWEBUI, key: 'other' }) });
        await tokenizersModule.getTokenCountAsync('zz');
        respond = defaultRespond;
        await tokenizersModule.getTokenCountAsync('abc');
        expect(requests.map(r => r.body.texts)).toEqual([['abc'], ['zz'], ['abc']]);
    });

    test('a count with basis failed is not cached', async () => {
        respond = (url, body) => ({ counts: body.texts.map(() => 9), tokenizer: answer({ basis: 'failed' }) });
        await tokenizersModule.getTokenCountAsync('abc');
        await tokenizersModule.getTokenCountAsync('abc');
        expect(requests.length).toBe(2);
    });

    test('CHAT_CHANGED empties the cache', async () => {
        await tokenizersModule.initTokenizers();
        await tokenizersModule.getTokenCountAsync('abc');
        eventHandlers.get('chat_id_changed').forEach(handler => handler());
        await tokenizersModule.getTokenCountAsync('abc');
        expect(requests.filter(r => r.url.endsWith('/count')).length).toBe(2);
    });
});

describe('tokenizer shims', () => {
    test('getTextTokens with a local id posts to that tokenizer\'s route', () => {
        expect(tokenizersModule.getTextTokens(tokenizerIds.LLAMA, 'x')).toEqual([3]);
        expect(requests.map(r => r.url)).toEqual(['/api/tokenizers/llama/encode']);
    });

    test('getTextTokens with an API id posts to /current/encode with the on-screen state', () => {
        expect(tokenizersModule.getTextTokens(tokenizerIds.API_TEXTGENERATIONWEBUI, 'x')).toEqual([1, 2]);
        expect(requests).toEqual([{ url: '/api/tokenizers/current/encode', async: false, body: { state: textgenState, texts: ['x'] } }]);
    });

    test('before the first answer, the shims ask synchronously once; after it they read it', () => {
        expect(tokenizersModule.getTokenizerBestMatch()).toBe(tokenizerIds.GEMMA);
        expect(requests).toEqual([{ url: '/api/tokenizers/current/tokenizer', async: false, body: { state: textgenState } }]);
        expect(tokenizersModule.getFriendlyTokenizerName()).toEqual({ tokenizerName: 'Gemma / Gemini', tokenizerKey: 'gemma', tokenizerId: tokenizerIds.GEMMA });
        expect(tokenizersModule.getTokenizerBestMatch('textgenerationwebui')).toBe(tokenizerIds.GEMMA);
        expect(requests.length).toBe(1);
    });

    test('an estimate answer gives NONE, never LLAMA', () => {
        respond = () => ({ tokenizer: answer({ id: tokenizerIds.NONE, name: 'None / Estimated', basis: 'unknown' }) });
        expect(tokenizersModule.getTokenizerBestMatch()).toBe(tokenizerIds.NONE);
        expect(tokenizersModule.getFriendlyTokenizerName()).toEqual({ tokenizerName: 'None / Estimated', tokenizerKey: 'none', tokenizerId: tokenizerIds.NONE });
    });

    test('the answer is fetched in the background at boot, and the old stored cache is deleted', async () => {
        await tokenizersModule.initTokenizers();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(requests).toEqual([{ url: '/api/tokenizers/current/tokenizer', async: true, body: { state: textgenState } }]);
        expect(storeItems.has('tokenCache')).toBe(false);
        expect(tokenizersModule.getTokenizerBestMatch()).toBe(tokenizerIds.GEMMA);
        expect(requests.length).toBe(1);
    });

    test('a state change asks again; a response for an older state is not remembered', () => {
        tokenizersModule.getTokenizerBestMatch();
        settings.power_user.tokenizer = tokenizerIds.LLAMA3;
        respond = () => ({ tokenizer: answer({ id: tokenizerIds.LLAMA3, name: 'Llama 3', key: 'k3' }) });
        expect(tokenizersModule.getTokenizerBestMatch()).toBe(tokenizerIds.LLAMA3);
        expect(requests.length).toBe(2);
        expect(requests[1].body.state.tokenizerSetting).toBe(tokenizerIds.LLAMA3);
    });

    test('another API is asked synchronously with its own state', () => {
        respond = () => ({ tokenizer: answer({ id: tokenizerIds.NERD2, name: 'NerdStash v2 (NovelAI Kayra)' }) });
        expect(tokenizersModule.getTokenizerBestMatch('novel')).toBe(tokenizerIds.NERD2);
        expect(requests[0].body).toEqual({ state: { api: 'novel', model: 'kayra-v1', tokenizerSetting: tokenizerIds.BEST_MATCH } });
    });

    test('chat completion keeps upstream\'s shapes: best match NONE, friendly name OPENAI with the model string', async () => {
        await useApi('openai');
        respond = () => ({ tokenizer: answer({ id: tokenizerIds.OPENAI, name: 'gpt-4o', model: 'gpt-4o', key: 'openai|nanogpt||gpt-4o|openai' }) });
        expect(tokenizersModule.getTokenizerBestMatch()).toBe(tokenizerIds.NONE);
        expect(tokenizersModule.getFriendlyTokenizerName()).toEqual({ tokenizerName: 'gpt-4o', tokenizerKey: 'openai', tokenizerId: tokenizerIds.OPENAI });
        expect(tokenizersModule.getTokenizerModel()).toBe('gpt-4o');
        expect(requests.map(r => r.url)).toEqual(['/api/tokenizers/current/tokenizer']);
    });

    test('getTokenizerModel gives the chat-completion model name when the answer is an estimate', () => {
        respond = () => ({ tokenizer: answer({ id: tokenizerIds.NONE, name: 'None / Estimated', basis: 'unknown', key: 'openai|nanogpt||claude-sonnet-4|none' }) });
        expect(tokenizersModule.getTokenizerModel()).toBe('claude-sonnet-4');
        expect(requests[0].body.state).toEqual({ api: 'openai', source: 'nanogpt', model: 'claude-sonnet-4', tokenizerSetting: tokenizerIds.BEST_MATCH });
    });

    test('saveTokenCache stays exported and writes nothing', async () => {
        await tokenizersModule.saveTokenCache();
        expect(store.setItem).not.toHaveBeenCalled();
    });
});

describe('decode and trim ask /current/*', () => {
    test('decodeCurrentTokens posts the ids to /current/decode with the API\'s state', () => {
        expect(tokenizersModule.decodeCurrentTokens([1, 2], 'novel')).toEqual({ text: 'ab', chunks: ['a', 'b'] });
        expect(requests).toEqual([{
            url: '/api/tokenizers/current/decode',
            async: false,
            body: { state: { api: 'novel', model: 'kayra-v1', tokenizerSetting: tokenizerIds.BEST_MATCH }, ids: [1, 2] },
        }]);
    });

    test('a failed decode request gives empty text and chunks', () => {
        respond = () => { throw new Error('offline'); };
        expect(tokenizersModule.decodeCurrentTokens([1, 2], 'novel')).toEqual({ text: '', chunks: [] });
    });

    test('trimCurrentTokens makes one /current/trim request', async () => {
        expect(await tokenizersModule.trimCurrentTokens('hello world', 1, 'end')).toEqual({ text: 'trimmed', tokenizer: answer() });
        expect(requests).toEqual([{
            url: '/api/tokenizers/current/trim',
            async: true,
            body: { state: textgenState, text: 'hello world', limit: 1, direction: 'end' },
        }]);
    });

    test('a trim response updates the remembered answer', async () => {
        respond = () => ({ text: 'trimmed', tokenizer: answer({ id: tokenizerIds.LLAMA3, name: 'Llama 3', key: 'k3' }) });
        await tokenizersModule.trimCurrentTokens('hello world', 1, 'end');
        expect(tokenizersModule.getTokenizerBestMatch()).toBe(tokenizerIds.LLAMA3);
        expect(requests.length).toBe(1);
    });

    test('a failed trim request resolves null', async () => {
        respond = () => { throw new Error('offline'); };
        await expect(tokenizersModule.trimCurrentTokens('hello world', 1, 'end')).resolves.toBeNull();
    });
});

describe('the token counter encode asks /current/encode', () => {
    test('encodeCurrentTokens posts to /current/encode and gives the ids, chunks and tokenizer', () => {
        respond = () => ({ ids: [[1, 2]], chunks: [['a', 'b']], tokenizer: answer() });
        expect(tokenizersModule.encodeCurrentTokens('x')).toEqual({ ids: [1, 2], chunks: ['a', 'b'], tokenizer: answer() });
        expect(requests).toEqual([{ url: '/api/tokenizers/current/encode', async: false, body: { state: textgenState, texts: ['x'] } }]);
    });

    test('an estimate gives no ids and no chunks, with its tokenizer', () => {
        const estimate = answer({ id: tokenizerIds.NONE, name: 'None / Estimated', basis: 'unknown' });
        respond = () => ({ ids: [null], tokenizer: estimate });
        expect(tokenizersModule.encodeCurrentTokens('x')).toEqual({ ids: [], chunks: null, tokenizer: estimate });
    });

    test('a failed encode request gives no ids, no chunks and no tokenizer', () => {
        respond = () => { throw new Error('offline'); };
        expect(tokenizersModule.encodeCurrentTokens('x')).toEqual({ ids: [], chunks: null, tokenizer: null });
    });

    test('an encode response updates the remembered answer', () => {
        respond = () => ({ ids: [[1, 2]], tokenizer: answer({ id: tokenizerIds.LLAMA3, name: 'Llama 3', key: 'k3' }) });
        tokenizersModule.encodeCurrentTokens('x');
        expect(tokenizersModule.getTokenizerBestMatch()).toBe(tokenizerIds.LLAMA3);
        expect(requests.length).toBe(1);
    });
});

describe('count batches name their tokenizer', () => {
    test('a textgen batch makes one /current/count request and names the response\'s tokenizer', async () => {
        expect(await tokenizersModule.getTokenCountsWithTokenizer(['ab', 'c'])).toEqual({
            counts: [2, 1],
            tokenizer: { tokenizerName: 'Gemma / Gemini', tokenizerKey: 'gemma', tokenizerId: tokenizerIds.GEMMA },
        });
        expect(requests.map(r => r.url)).toEqual(['/api/tokenizers/current/count']);
    });

    test('the name is the response\'s, not the remembered one', async () => {
        tokenizersModule.getTokenizerBestMatch();
        respond = (url, body) => ({ counts: body.texts.map(text => text.length), tokenizer: answer({ id: tokenizerIds.LLAMA3, name: 'Llama 3', key: 'k3' }) });
        const { tokenizer } = await tokenizersModule.getTokenCountsWithTokenizer(['ab']);
        expect(tokenizer).toEqual({ tokenizerName: 'Llama 3', tokenizerKey: 'llama3', tokenizerId: tokenizerIds.LLAMA3 });
    });

    test('an all-cached batch makes no request and names the same tokenizer', async () => {
        const first = await tokenizersModule.getTokenCountsWithTokenizer(['ab']);
        const second = await tokenizersModule.getTokenCountsWithTokenizer(['ab']);
        expect(requests.length).toBe(1);
        expect(second.tokenizer).toEqual(first.tokenizer);
    });

    test('a failed request gives the estimate and names None', async () => {
        respond = () => { throw new Error('offline'); };
        expect(await tokenizersModule.getTokenCountsWithTokenizer(['ab'])).toEqual({
            counts: [tokenizersModule.guesstimate('ab')],
            tokenizer: { tokenizerName: 'None / Estimated', tokenizerKey: 'none', tokenizerId: tokenizerIds.NONE },
        });
    });

    test('a chat-completion batch names the chat-completion tokenizer model', async () => {
        await useApi('openai');
        expect(await tokenizersModule.getTokenCountsWithTokenizer(['ab'])).toEqual({
            counts: [7],
            tokenizer: { tokenizerName: 'gpt-4o', tokenizerKey: 'openai', tokenizerId: tokenizerIds.OPENAI },
        });
    });
});
