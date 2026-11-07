import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const tokenizerIds = {
    NONE: 0, GPT2: 1, OPENAI: 2, LLAMA: 3, NERD: 4, NERD2: 5, API_CURRENT: 6, MISTRAL: 7, YI: 8,
    API_TEXTGENERATIONWEBUI: 9, API_KOBOLD: 10, CLAUDE: 11, LLAMA3: 12, GEMMA: 13, JAMBA: 14, QWEN2: 15,
    COMMAND_R: 16, NEMO: 17, DEEPSEEK: 18, COMMAND_A: 19, BEST_MATCH: 99, QWEN3: 1000,
};

const settings = {
    mainApi: 'textgenerationwebui',
    power_user: { tokenizer: tokenizerIds.BEST_MATCH, token_padding: 64 },
    textgen: { type: 'llamacpp', llamacpp_model: '', ollama_model: '', server_urls: { llamacpp: 'http://127.0.0.1:8080' } },
    oai: { chat_completion_source: 'nanogpt', nanogpt_model: 'claude-sonnet-4' },
};

/** @type {Array<{url: string, async: boolean, body: any, headers?: Record<string, string>}>} */
let requests;
/** @type {(url: string, body: any) => any} */
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
    if (url === '/api/tokenizers/count') {
        return { counts: body.texts.map(text => text.length), tokenizer: answer() };
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

global.fetch = jest.fn(async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url: String(url), async: true, body, headers: options.headers });
    try {
        const answered = respond(String(url), body);
        return { ok: true, json: async () => answered };
    } catch {
        return { ok: false, json: async () => ({}) };
    }
});

global.jQuery = {
    ajax: jest.fn((options) => {
        const body = options.data ? JSON.parse(options.data) : undefined;
        requests.push({ url: options.url, async: options.async !== false, body, headers: options.headers });
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
    chat_completion_sources: { OPENAI: 'openai', NANOGPT: 'nanogpt', CUSTOM: 'custom' },
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

    test('getTextTokens(OPENAI) and decodeTextTokens(OPENAI) keep ?model= and send the chat-completion state in X-ST-Connection-State', () => {
        respond = (url, body) => url === '/api/tokenizers/current/tokenizer'
            ? { tokenizer: answer({ id: tokenizerIds.OPENAI, name: 'gpt-4o', model: 'gpt-4o', key: 'openai|nanogpt||claude-sonnet-4|openai' }) }
            : defaultRespond(url, body);
        const header = { 'X-ST-Connection-State': JSON.stringify({ api: 'openai', source: 'nanogpt', model: 'claude-sonnet-4', tokenizerSetting: tokenizerIds.BEST_MATCH }) };
        expect(tokenizersModule.getTextTokens(tokenizerIds.OPENAI, 'x')).toEqual([3]);
        tokenizersModule.decodeTextTokens(tokenizerIds.OPENAI, [3]);
        const routeRequests = requests.filter(r => r.url.startsWith('/api/tokenizers/openai/'));
        expect(routeRequests).toEqual([
            { url: '/api/tokenizers/openai/encode?model=gpt-4o', async: false, body: { text: 'x' }, headers: header },
            { url: '/api/tokenizers/openai/decode?model=gpt-4o', async: false, body: { ids: [3] }, headers: header },
        ]);
    });

    test('saveTokenCache stays exported and writes nothing', async () => {
        await tokenizersModule.saveTokenCache();
        expect(store.setItem).not.toHaveBeenCalled();
    });
});

describe('an explicit registry id goes through /current/* as explicitTokenizer', () => {
    const qwen3Answer = (key) => answer({ id: tokenizerIds.QWEN3, name: 'Qwen3 (official)', key });
    const respondQwen3 = (key) => (url, body) => {
        if (url === '/api/tokenizers/current/encode') {
            return { ids: [[5, 6]], chunks: [['a', 'b']], tokenizer: qwen3Answer(key) };
        }
        if (url === '/api/tokenizers/current/decode') {
            return { text: 'ab', chunks: ['a', 'b'], tokenizer: qwen3Answer(key) };
        }
        return defaultRespond(url, body);
    };

    test('getTextTokens(QWEN3) posts to /current/encode with the on-screen state and explicitTokenizer, chunks attached', () => {
        respond = respondQwen3('textgenerationwebui|llamacpp|http://127.0.0.1:8080||qwen3');
        const ids = tokenizersModule.getTextTokens(tokenizerIds.QWEN3, 'ab');
        expect(ids).toEqual([5, 6]);
        expect(/** @type {any} */ (ids).chunks).toEqual(['a', 'b']);
        expect(Object.keys(ids)).toEqual(['0', '1']);
        expect(requests).toEqual([{ url: '/api/tokenizers/current/encode', async: false, body: { state: textgenState, texts: ['ab'], explicitTokenizer: tokenizerIds.QWEN3 } }]);
    });

    test('getTextTokens(QWEN3) while main_api is openai sends the chat-completion state and explicitTokenizer', async () => {
        await useApi('openai');
        respond = respondQwen3('openai|nanogpt||claude-sonnet-4|qwen3');
        const ids = tokenizersModule.getTextTokens(tokenizerIds.QWEN3, 'ab');
        expect(ids).toEqual([5, 6]);
        expect(/** @type {any} */ (ids).chunks).toEqual(['a', 'b']);
        expect(requests).toEqual([{
            url: '/api/tokenizers/current/encode',
            async: false,
            body: { state: { api: 'openai', source: 'nanogpt', model: 'claude-sonnet-4', tokenizerSetting: tokenizerIds.BEST_MATCH }, texts: ['ab'], explicitTokenizer: tokenizerIds.QWEN3 },
        }]);
    });

    test('decodeTextTokens(QWEN3) posts to /current/decode with the on-screen state and explicitTokenizer', () => {
        respond = respondQwen3('textgenerationwebui|llamacpp|http://127.0.0.1:8080||qwen3');
        expect(tokenizersModule.decodeTextTokens(tokenizerIds.QWEN3, [5, 6])).toEqual({ text: 'ab', chunks: ['a', 'b'] });
        expect(requests).toEqual([{ url: '/api/tokenizers/current/decode', async: false, body: { state: textgenState, ids: [5, 6], explicitTokenizer: tokenizerIds.QWEN3 } }]);
    });

    test('a failed explicit request gives no ids, or empty text and chunks', () => {
        respond = () => { throw new Error('offline'); };
        expect(tokenizersModule.getTextTokens(tokenizerIds.QWEN3, 'ab')).toEqual([]);
        expect(tokenizersModule.decodeTextTokens(tokenizerIds.QWEN3, [5, 6])).toEqual({ text: '', chunks: [] });
    });

    test('an explicit response is not the on-screen answer, so it is not remembered', () => {
        respond = respondQwen3('textgenerationwebui|llamacpp|http://127.0.0.1:8080||qwen3');
        tokenizersModule.getTextTokens(tokenizerIds.QWEN3, 'ab');
        respond = defaultRespond;
        expect(tokenizersModule.getTokenizerBestMatch()).toBe(tokenizerIds.GEMMA);
        expect(requests.map(r => r.url)).toEqual(['/api/tokenizers/current/encode', '/api/tokenizers/current/tokenizer']);
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

describe('counting is one action the server answers', () => {
    test('countWithConnection posts the texts alone, and gives the counts and the tokenizer they are in', async () => {
        const counted = await tokenizersModule.countWithConnection(['abc', 'hello']);
        expect(requests).toEqual([expect.objectContaining({ url: '/api/tokenizers/count', body: { texts: ['abc', 'hello'] } })]);
        expect(counted).toEqual({ counts: [3, 5], tokenizer: answer() });
    });

    test('a failed count gives estimates and no tokenizer', async () => {
        respond = () => { throw new Error('down'); };
        const counted = await tokenizersModule.countWithConnection(['abcdefg']);
        expect(counted.tokenizer).toBeNull();
        expect(counted.counts).toEqual([expect.any(Number)]);
    });

    test('a message count the server answered an action with is shown without asking', async () => {
        tokenizersModule.takeMessageCount('Two days on foot.', 6, answer());
        expect(await tokenizersModule.getMessageTokenCounts(['Two days on foot.'])).toEqual([6]);
        expect(requests).toEqual([]);
    });

    test('the messages it doesn\'t know are counted in one request, then known', async () => {
        expect(await tokenizersModule.getMessageTokenCounts(['ab', '', 'abcd'])).toEqual([2, 0, 4]);
        expect(requests.map(r => r.body)).toEqual([{ texts: ['ab', 'abcd'] }]);
        expect(await tokenizersModule.getMessageTokenCounts(['ab', 'abcd'])).toEqual([2, 4]);
        expect(requests).toHaveLength(1);
    });
});
