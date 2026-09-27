import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const tokenizerIds = {
    NONE: 0, GPT2: 1, OPENAI: 2, LLAMA: 3, NERD: 4, NERD2: 5, API_CURRENT: 6, MISTRAL: 7, YI: 8,
    API_TEXTGENERATIONWEBUI: 9, API_KOBOLD: 10, CLAUDE: 11, LLAMA3: 12, GEMMA: 13, JAMBA: 14, QWEN2: 15,
    COMMAND_R: 16, NEMO: 17, DEEPSEEK: 18, COMMAND_A: 19, BEST_MATCH: 99,
};

const params = { main_api: 'textgenerationwebui', max_context: 4096 };
const power_user = { tokenizer: tokenizerIds.BEST_MATCH, token_padding: 64 };
const scriptNaiSettings = { model_novel: 'kayra-v1' };
const showTokenizerWarnings = jest.fn();
const getStoppingStrings = jest.fn(() => []);

/** @type {Array<{url: string, async: boolean, body: any}>} */
let requests;
/** @type {(url: string, body: any) => any} */
let respond;

function answer(overrides = {}) {
    return {
        id: tokenizerIds.GEMMA,
        name: 'Gemma / Gemini',
        basis: 'local',
        key: 'textgenerationwebui|ooba|http://127.0.0.1:5000||gemma',
        messages: {
            dropped: {
                one: 'Left out {count} entry that need token ids, because no tokenizer is known for this model: {entries}',
                many: 'Left out {count} entries that need token ids, because no tokenizer is known for this model: {entries}',
            },
        },
        ...overrides,
    };
}

/** Ids a fake tokenizer gives: one per character, the character's code. */
function fakeIds(text) {
    return Array.from(text, c => c.charCodeAt(0));
}

function defaultRespond(url, body) {
    if (url === '/api/tokenizers/current/encode') {
        return { ids: body.texts.map(fakeIds), tokenizer: answer() };
    }
    if (url === '/api/tokenizers/current/tokenizer') {
        return { tokenizer: answer() };
    }
    if (url === '/api/tokenizers/current/count') {
        return { counts: body.texts.map(text => text.length), tokenizer: answer() };
    }
    return { ids: [999] };
}

global.jQuery = {
    ajax: jest.fn((options) => {
        const body = options.data ? JSON.parse(options.data) : undefined;
        requests.push({ url: options.url, async: options.async !== false, body });
        const data = respond(options.url, body);
        options.success?.(data);
        return Promise.resolve(data);
    }),
};

// Every jQuery call gives back the same chainable stand-in.
const jq = new Proxy(function () {}, {
    get: (_target, prop) => {
        if (prop === Symbol.toPrimitive) return () => '';
        if (prop === 'length') return 0;
        if (prop === 'then') return undefined;
        return () => jq;
    },
    apply: () => jq,
});
global.$ = jq;
global.document = { getElementById: () => null };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.sessionStorage = { getItem: () => null, setItem: () => {} };
global.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };

jest.unstable_mockModule('../public/lib.js', () => ({ localforage: { createInstance: () => ({ removeItem: async () => {} }) } }));
jest.unstable_mockModule('../public/script.js', () => ({
    abortStatusCheck: { signal: undefined },
    getStoppingStrings,
    nai_settings: scriptNaiSettings,
    online_status: 'no_connection',
    resultCheckStatus: jest.fn(),
    saveSettingsDebounced: jest.fn(),
    setGenerationParamsFromPreset: jest.fn(),
    setOnlineStatus: jest.fn(),
    startStatusLoading: jest.fn(),
    substituteParams: (text) => text,
}));
jest.unstable_mockModule('../public/scripts/generation-params.js', () => params);
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({ getRequestHeaders: () => ({}) }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({
    event_types: {},
    eventSource: { on: jest.fn(), emit: jest.fn() },
}));
jest.unstable_mockModule('../public/scripts/chat-templates.js', () => ({ deriveTemplatesFromChatTemplate: jest.fn() }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (strings) => strings.join('') }));
jest.unstable_mockModule('../public/scripts/instruct-mode.js', () => ({
    autoSelectInstructPreset: jest.fn(), selectContextPreset: jest.fn(), selectInstructPreset: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    MAX_CONTEXT_DEFAULT: 8192,
    MAX_RESPONSE_DEFAULT: 150,
    power_user,
    registerDebugFunction: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/samplerSelect.js', () => ({
    getActiveManualApiSamplers: jest.fn(), loadApiSelectedSamplers: jest.fn(), isSamplerManualPriorityEnabled: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/secrets.js', () => ({ SECRET_KEYS: {}, secret_state: {}, writeSecret: jest.fn() }));
jest.unstable_mockModule('../public/scripts/textgen-models.js', () => ({
    loadAphroditeModels: jest.fn(), loadDreamGenModels: jest.fn(), loadFeatherlessModels: jest.fn(), loadGenericModels: jest.fn(),
    loadInfermaticAIModels: jest.fn(), loadLlamaCppModels: jest.fn(), loadMancerModels: jest.fn(), loadOllamaModels: jest.fn(),
    loadOpenRouterModels: jest.fn(), loadTabbyModels: jest.fn(), loadTogetherAIModels: jest.fn(), loadVllmModels: jest.fn(),
    updateOpenRouterProvidersWarning: jest.fn(),
    getCurrentDreamGenModelTokenizer: jest.fn(), getCurrentOpenRouterModelTokenizer: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    arraysEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    debounce: (fn) => fn,
    getSortableDelay: () => 0,
    getStringHash: (str) => [...String(str)].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) | 0, 7),
    isObject: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
    onlyUnique: (value, index, array) => array.indexOf(value) === index,
    uuidv4: () => 'id',
}));
jest.unstable_mockModule('../public/scripts/tokenizer-notices.js', () => ({ showTokenizerWarnings }));
jest.unstable_mockModule('../public/scripts/chat-completion-settings.js', () => ({
    getChatCompletionModel: () => '',
    oai_settings: { chat_completion_source: 'openai' },
}));
jest.unstable_mockModule('../public/scripts/kai-settings.js', () => ({ kai_settings: { api_server: '' } }));
jest.unstable_mockModule('../public/scripts/horde.js', () => ({ horde_settings: { models: [] } }));

/** @type {typeof import('../public/scripts/tokenizers.js')} */
let tokenizersModule;
/** @type {typeof import('../public/scripts/textgen-settings.js')} */
let textgen;
/** @type {typeof import('../public/scripts/nai-settings.js')} */
let nai;

/**
 * Loads the modules with `api` as main_api (a mocked module export is fixed when it loads).
 * @param {string} api
 */
async function load(api) {
    params.main_api = api;
    jest.resetModules();
    tokenizersModule = await import('../public/scripts/tokenizers.js');
    textgen = await import('../public/scripts/textgen-settings.js');
    nai = await import('../public/scripts/nai-settings.js');
    Object.assign(textgen.textgenerationwebui_settings, {
        type: 'ooba',
        server_urls: { ooba: 'http://127.0.0.1:5000' },
        send_banned_tokens: true,
        banned_tokens: 'forbidden',
        global_banned_tokens: '"verbatim string"\n[7, 8]',
        logit_bias: [{ id: 'a', text: 'hello', value: 5 }, { id: 'b', text: '[42]', value: -1 }],
    });
}

async function settle() {
    for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

function createTextgenData() {
    return textgen.createTextGenGenerationData(textgen.textgenerationwebui_settings, 'model', 'prompt', 100);
}

beforeEach(async () => {
    requests = [];
    respond = defaultRespond;
    showTokenizerWarnings.mockClear();
    getStoppingStrings.mockReset().mockReturnValue([]);
    await load('textgenerationwebui');
});

describe('textgen ids come from the id cache', () => {
    test('with a prefetched cache, createTextGenGenerationData makes no synchronous request', async () => {
        textgen.initTextGenSettings();
        tokenizersModule.prefetchEntryTokenIdsDebounced();
        await settle();
        expect(requests.map(r => [r.url, r.async])).toEqual([['/api/tokenizers/current/encode', true]]);
        expect(requests[0].body.texts).toEqual(['forbidden', ' hello']);
        expect(requests[0].body.state).toMatchObject({ api: 'textgenerationwebui', type: 'ooba' });
        expect(requests[0].body.state).not.toHaveProperty('tokenizer');

        requests = [];
        const data = createTextgenData();
        expect(requests).toEqual([]);
        expect(data.custom_token_bans).toBe([...fakeIds('forbidden'), 7, 8].filter((x, i, a) => a.indexOf(x) === i).join(','));
        expect(data.banned_strings).toEqual(['verbatim string']);
        expect(data.logit_bias).toEqual({ ...Object.fromEntries(fakeIds(' hello').map(id => [String(id), 5])), '42': -1 });
    });

    test('with a miss, createTextGenGenerationData makes exactly one synchronous request, for every missing entry', () => {
        createTextgenData();
        expect(requests.map(r => [r.url, r.async])).toEqual([['/api/tokenizers/current/encode', false]]);
        expect(requests[0].body.texts).toEqual(['forbidden', ' hello']);

        requests = [];
        createTextgenData();
        expect(requests).toEqual([]);
    });

    test('a null entry is left out, with a dropped warning naming it on every send', () => {
        respond = (url, body) => ({
            ids: body.texts.map(text => text === ' hello' ? null : fakeIds(text)),
            tokenizer: answer(),
        });
        for (let send = 1; send <= 2; send++) {
            const data = createTextgenData();
            expect(data.logit_bias).toEqual({ '42': -1 });
            expect(showTokenizerWarnings).toHaveBeenCalledTimes(send);
            expect(showTokenizerWarnings).toHaveBeenLastCalledWith([{
                kind: 'dropped',
                key: answer().key,
                message: 'Left out 1 entry that need token ids, because no tokenizer is known for this model: hello',
                entries: ['hello'],
            }]);
        }
        expect(requests.length).toBe(1);
    });

    test('an answer with basis failed is not stored, so the next send asks again', () => {
        respond = (url, body) => ({ ids: body.texts.map(() => null), tokenizer: answer({ basis: 'failed' }) });
        createTextgenData();
        createTextgenData();
        expect(requests.length).toBe(2);
        expect(showTokenizerWarnings.mock.calls[1][0][0].message)
            .toBe('Left out 2 entries that need token ids, because no tokenizer is known for this model: forbidden, hello');
    });

    test('a changed tokenizer key empties the cache', async () => {
        createTextgenData();
        respond = (url, body) => ({ counts: body.texts.map(() => 1), tokenizer: answer({ key: 'textgenerationwebui|ooba|http://127.0.0.1:5000|other|gemma' }) });
        await tokenizersModule.getTokenCountAsync('something');
        respond = defaultRespond;
        requests = [];
        createTextgenData();
        expect(requests.filter(r => r.url === '/api/tokenizers/current/encode' && !r.async).length).toBe(1);
    });

    test('no request goes to a tokenizer the client picked', () => {
        createTextgenData();
        expect(requests.every(r => r.url.startsWith('/api/tokenizers/current/'))).toBe(true);
    });
});

describe('logit-bias.js', () => {
    test('getLogitBiasListResult with an explicit tokenizer keeps that tokenizer\'s route', async () => {
        const { getLogitBiasListResult } = await import('../public/scripts/logit-bias.js');
        const result = getLogitBiasListResult([{ text: 'hi', value: 3 }], tokenizerIds.LLAMA, (bias, sequence) => ({ bias, sequence }));
        expect(result).toEqual([{ bias: 3, sequence: [999] }]);
        expect(requests.map(r => r.url)).toEqual(['/api/tokenizers/llama/encode']);
    });

    test('getLogitBiasListResult with API_CURRENT reads the id cache and warns about null entries', async () => {
        const { getLogitBiasListResult } = await import('../public/scripts/logit-bias.js');
        respond = (url, body) => ({ ids: body.texts.map(() => null), tokenizer: answer() });
        const result = getLogitBiasListResult([{ text: 'hi', value: 3 }, { text: '[5]', value: 1 }], tokenizerIds.API_CURRENT, (bias, sequence) => ({ bias, sequence }));
        expect(result).toEqual([{ bias: 1, sequence: [5] }]);
        expect(requests.map(r => r.url)).toEqual(['/api/tokenizers/current/encode']);
        expect(showTokenizerWarnings.mock.calls[0][0][0].entries).toEqual(['hi']);
    });

    test('BIAS_CACHE stays exported', async () => {
        const { BIAS_CACHE } = await import('../public/scripts/logit-bias.js');
        expect(BIAS_CACHE).toBeInstanceOf(Map);
    });
});

describe('NovelAI ids come from the id cache', () => {
    function createNovelData() {
        return nai.getNovelGenerationData('prompt', {}, 100, false, false, null, 'normal');
    }

    beforeEach(async () => {
        await load('novel');
        Object.assign(nai.nai_settings, { model_novel: 'kayra-v1', banned_tokens: '', logit_bias: [], prefix: 'vanilla' });
    });

    test('getNovelGenerationData on kayra encodes stop strings from the server\'s ids', () => {
        getStoppingStrings.mockReturnValue(['\nUser:', '\nBot:']);
        const data = createNovelData();
        expect(data.stop_sequences).toEqual([fakeIds('\nUser:'), fakeIds('\nBot:')]);
        expect(requests).toEqual([{
            url: '/api/tokenizers/current/encode',
            async: false,
            body: { state: { api: 'novel', model: 'kayra-v1', tokenizerSetting: tokenizerIds.BEST_MATCH }, texts: ['\nUser:', '\nBot:'] },
        }]);
    });

    test('with every entry null, the payload keeps upstream\'s no-tokenizer shape; raw ids still go through', () => {
        getStoppingStrings.mockReturnValue(['\nUser:']);
        Object.assign(nai.nai_settings, { banned_tokens: 'word', logit_bias: [{ text: 'hi', value: 1 }] });
        respond = (url, body) => ({ ids: body.texts.map(() => null), tokenizer: answer({ id: tokenizerIds.NONE, key: 'novel|||kayra-v1|none' }) });
        const data = createNovelData();
        expect(data.stop_sequences).toBeUndefined();
        expect(data.bad_words_ids).toBeUndefined();
        expect(data.logit_bias_exp).toEqual([]);
        expect(showTokenizerWarnings.mock.calls[0][0][0].entries).toEqual(['\nUser:', 'word', 'hi']);

        Object.assign(nai.nai_settings, { banned_tokens: 'word\n[1, 2]', logit_bias: [{ text: '[3]', value: 1 }] });
        const withRawIds = createNovelData();
        expect(withRawIds.bad_words_ids).toEqual([[1, 2]]);
        expect(withRawIds.logit_bias_exp).toEqual([{ bias: 1, ensure_sequence_finish: false, generate_once: false, sequence: [3] }]);
    });

    test('with a tokenizer and nothing to send, the empty fields stay arrays, as upstream sent them', () => {
        getStoppingStrings.mockReturnValue(['\nUser:']);
        const data = createNovelData();
        expect(data.bad_words_ids).toEqual([]);
        expect(data.logit_bias_exp).toEqual([]);
        expect(showTokenizerWarnings).not.toHaveBeenCalled();
    });
});
