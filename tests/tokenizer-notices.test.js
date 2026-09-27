import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

/** In-memory sessionStorage stand-in. */
function makeStorage() {
    const map = new Map();
    return {
        getItem: jest.fn((k) => (map.has(k) ? map.get(k) : null)),
        setItem: jest.fn((k, v) => { map.set(k, String(v)); }),
        removeItem: jest.fn((k) => { map.delete(k); }),
        clear: jest.fn(() => map.clear()),
    };
}

// A minimal DOM and jQuery: just what renderCountBasis uses.

class FakeNode {
    /**
     * @param {string} tag
     * @param {string} [className]
     */
    constructor(tag, className = '') {
        this.tag = tag;
        this.className = className;
        this.ownText = '';
        /** @type {FakeNode[]} */
        this.children = [];
        /** @type {FakeNode|null} */
        this.parent = null;
        /** @type {Record<string, string>} */
        this.attrs = {};
    }

    get textContent() {
        return this.ownText + this.children.map(child => child.textContent).join('');
    }

    /** @param {string} selector `tag.class` */
    matches(selector) {
        const [tag, cls] = selector.split('.');
        return (!tag || tag === this.tag) && (!cls || this.className.split(' ').includes(cls));
    }

    sibling(offset) {
        const siblings = this.parent?.children ?? [];
        return siblings[siblings.indexOf(this) + offset] ?? null;
    }

    insert(node, offset) {
        node.parent?.children.splice(node.parent.children.indexOf(node), 1);
        const siblings = this.parent.children;
        siblings.splice(siblings.indexOf(this) + offset, 0, node);
        node.parent = this.parent;
    }
}

class FakeQuery {
    /** @param {FakeNode[]} nodes */
    constructor(nodes) {
        this.nodes = nodes;
        this.length = nodes.length;
        nodes.forEach((node, i) => { this[i] = node; });
    }

    prev(selector) {
        const node = this.nodes[0]?.sibling(-1);
        return new FakeQuery(node && node.matches(selector) ? [node] : []);
    }

    next(selector) {
        const node = this.nodes[0]?.sibling(1);
        return new FakeQuery(node && node.matches(selector) ? [node] : []);
    }

    before(content) {
        this.nodes[0].insert(fake$(content).nodes[0], 0);
        return this;
    }

    after(content) {
        this.nodes[0].insert(fake$(content).nodes[0], 1);
        return this;
    }

    text(value) {
        if (value === undefined) {
            return this.nodes.map(node => node.textContent).join('');
        }
        this.nodes.forEach(node => { node.children = []; node.ownText = String(value); });
        return this;
    }

    empty() {
        this.nodes.forEach(node => { node.children = []; node.ownText = ''; });
        return this;
    }

    append(content) {
        const child = fake$(content).nodes[0];
        child.parent = this.nodes[0];
        this.nodes[0].children.push(child);
        return this;
    }

    attr(name, value) {
        if (value === undefined) {
            return this.nodes[0]?.attrs[name];
        }
        this.nodes.forEach(node => { node.attrs[name] = String(value); });
        return this;
    }
}

/**
 * @param {string|FakeNode|FakeQuery} content `<tag class="...">` markup, a node or a query.
 * @returns {FakeQuery}
 */
function fake$(content) {
    if (content instanceof FakeQuery) return content;
    if (content instanceof FakeNode) return new FakeQuery([content]);
    const match = /^<(\w+)(?: class="([^"]*)")?>/.exec(String(content));
    if (!match) throw new Error(`fake $ can't handle ${content}`);
    return new FakeQuery([new FakeNode(match[1], match[2] ?? '')]);
}

/**
 * A count element inside a parent, as on screen.
 * @param {string} text
 */
function makeCounter(text) {
    const parent = new FakeNode('div');
    const counter = new FakeNode('span', 'token_counter');
    counter.ownText = text;
    counter.parent = parent;
    parent.children.push(counter);
    return { parent, counter };
}

// tokenizers.js's module dependencies, for the count and send notices.

const tokenizerIds = { NONE: 0, OPENAI: 2, LLAMA3: 12, GEMMA: 13, API_TEXTGENERATIONWEBUI: 9, BEST_MATCH: 99 };

const settings = {
    mainApi: 'textgenerationwebui',
    power_user: { tokenizer: tokenizerIds.BEST_MATCH, token_padding: 64 },
    textgen: { type: 'llamacpp', llamacpp_model: 'm1', server_urls: { llamacpp: 'http://127.0.0.1:8080' } },
    oai: { chat_completion_source: 'nanogpt', nanogpt_model: 'claude-sonnet-4' },
};

/** @type {Array<{url: string, async: boolean, body: any}>} */
let requests;
/** @type {(url: string, body: any) => any} */
let respond;

global.jQuery = {
    ajax: jest.fn((options) => {
        const body = options.data ? JSON.parse(options.data) : undefined;
        requests.push({ url: options.url, async: options.async !== false, body });
        const data = respond(options.url, body);
        options.success?.(data);
        return Promise.resolve(data);
    }),
};
global.$ = fake$;
global.document = {};

jest.unstable_mockModule('../public/lib.js', () => ({ localforage: { createInstance: () => ({ removeItem: async () => {} }) } }));
jest.unstable_mockModule('../public/script.js', () => ({ nai_settings: { model_novel: 'kayra-v1' } }));
jest.unstable_mockModule('../public/scripts/generation-params.js', () => ({ main_api: settings.mainApi }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({ event_types: {}, eventSource: { on: jest.fn() } }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: settings.power_user }));
jest.unstable_mockModule('../public/scripts/chat-completion-settings.js', () => ({
    getChatCompletionModel: () => settings.oai.nanogpt_model,
    oai_settings: settings.oai,
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    debounce: (fn) => fn,
    getStringHash: (str) => [...String(str)].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) | 0, 7),
}));
jest.unstable_mockModule('../public/scripts/kai-settings.js', () => ({ kai_settings: { api_server: '' } }));
jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    SERVER_INPUTS: {},
    textgen_types: { LLAMACPP: 'llamacpp', OLLAMA: 'ollama' },
    textgenerationwebui_settings: settings.textgen,
    getTextGenServer: (type) => settings.textgen.server_urls[type ?? settings.textgen.type] ?? '',
    getTextGenModel: (s) => (s ?? settings.textgen).llamacpp_model || undefined,
}));
jest.unstable_mockModule('../public/scripts/horde.js', () => ({ horde_settings: { models: [] } }));

const unknownModel = 'No tokenizer is known for this model, so token counts are estimates. A tokenizer can be picked in Advanced Formatting → Tokenizer.';
const trimEstimate = 'The backend\'s tokenizer failed, so the prompt was fitted to the context by an estimated token count.';

/**
 * A `/current/*` tokenizer answer for the on-screen llama.cpp model.
 * @param {string} basis
 */
function answer(basis) {
    const estimated = basis === 'failed' || basis === 'unknown';
    return {
        id: estimated ? (basis === 'failed' ? tokenizerIds.API_TEXTGENERATIONWEBUI : tokenizerIds.NONE) : tokenizerIds.GEMMA,
        name: basis === 'fallback' ? 'Gemma / Gemini' : 'API (llama.cpp)',
        basis,
        key: `textgenerationwebui|llamacpp|http://127.0.0.1:8080|${settings.textgen.llamacpp_model}|api_textgenerationwebui`,
        messages: { dropped: { one: '{entries}', many: '{entries}' }, trimEstimate, unknownModel },
    };
}

/**
 * The `warnings` a `/current/*` response carries for its tokenizer answer, as the server builds them.
 * @param {ReturnType<typeof answer>} tokenizer
 */
function warningsFor(tokenizer) {
    if (tokenizer.basis === 'failed') {
        return [{ kind: 'estimate', key: tokenizer.key, message: `The backend's tokenizer failed, so token counts are estimates. (${tokenizer.key})` }];
    }
    if (tokenizer.basis === 'fallback') {
        return [{ kind: 'fallback-copy', key: tokenizer.key, message: `Local copy used. (${tokenizer.key})` }];
    }
    return [];
}

/**
 * Answers every `/current/*` route with `basis`, and its warnings.
 * @param {string} basis
 */
function respondWith(basis) {
    return (url, body) => {
        const tokenizer = answer(basis);
        const warnings = warningsFor(tokenizer);
        const extra = warnings.length > 0 ? { warnings } : {};
        switch (url) {
            case '/api/tokenizers/current/count':
                return body.messages
                    ? { count: 7, tokenizer, ...extra }
                    : { counts: body.texts.map(text => text.length + body.padding), tokenizer, ...extra };
            case '/api/tokenizers/current/encode':
                return { ids: body.texts.map(() => [1, 2]), tokenizer, ...extra };
            case '/api/tokenizers/current/decode':
                return { text: 'ab', chunks: ['a', 'b'], tokenizer, ...extra };
            case '/api/tokenizers/current/trim':
                return { text: 'trimmed', tokenizer, ...extra };
            default:
                return { tokenizer };
        }
    };
}

/** @type {typeof import('../public/scripts/tokenizers.js')} */
let tokenizersModule;

/**
 * Loads tokenizers.js with `api` as main_api (a mocked module export is fixed when it loads).
 * @param {string} api
 */
async function useApi(api) {
    settings.mainApi = api;
    jest.resetModules();
    tokenizersModule = await import('../public/scripts/tokenizers.js');
}

let showTokenizerWarnings;
let renderCountBasis;

beforeAll(async () => {
    ({ showTokenizerWarnings, renderCountBasis } = await import('../public/scripts/tokenizer-notices.js'));
});

beforeEach(() => {
    globalThis.toastr = { warning: jest.fn() };
    globalThis.sessionStorage = makeStorage();
    requests = [];
    respond = respondWith('remote');
    settings.textgen.llamacpp_model = 'm1';
});

const estimate = (key) => ({ kind: 'estimate', key, message: `Counts are estimates for ${key}` });

describe('showTokenizerWarnings', () => {
    test('a repeated estimate key toasts once', () => {
        showTokenizerWarnings([estimate('textgen|llamacpp|u|m1|t')]);
        showTokenizerWarnings([estimate('textgen|llamacpp|u|m1|t')]);
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.warning).toHaveBeenCalledWith('Counts are estimates for textgen|llamacpp|u|m1|t');
    });

    test('a dropped warning toasts on every call', () => {
        const dropped = { kind: 'dropped', key: 'k', message: 'Dropped: a, b', entries: ['a', 'b'] };
        showTokenizerWarnings([dropped]);
        showTokenizerWarnings([dropped]);
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(2);
    });

    test('a new model key toasts again', () => {
        showTokenizerWarnings([estimate('textgen|llamacpp|u|m1|t')]);
        showTokenizerWarnings([estimate('textgen|llamacpp|u|m2|t')]);
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(2);
    });

    test('storage throwing still toasts', () => {
        globalThis.sessionStorage = {
            getItem: jest.fn(() => { throw new Error('denied'); }),
            setItem: jest.fn(() => { throw new Error('denied'); }),
        };
        expect(() => showTokenizerWarnings([estimate('k')])).not.toThrow();
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
    });
});

describe('renderCountBasis', () => {
    /**
     * @param {FakeNode} parent
     * @returns {string[]} The parent's children, as `class:text`.
     */
    const layout = (parent) => parent.children.map(child => `${child.className}:${child.textContent}`);

    test('basis unknown: ~ before the count, the marker after it with the server\'s title', () => {
        const { parent, counter } = makeCounter('120');
        renderCountBasis(counter, answer('unknown'));
        expect(layout(parent)).toEqual(['token_count_approx:~', 'token_counter:120', 'token_count_basis:']);
        const icon = parent.children[2].children[0];
        expect(icon.tag).toBe('i');
        expect(icon.className).toBe('fa-solid fa-circle-question');
        expect(icon.attrs.title).toBe(unknownModel);
    });

    test('basis failed: ~ and the marker, like unknown', () => {
        const { parent, counter } = makeCounter('120');
        renderCountBasis(new FakeQuery([counter]), answer('failed'));
        expect(layout(parent)).toEqual(['token_count_approx:~', 'token_counter:120', 'token_count_basis:']);
        expect(parent.children[2].children[0].className).toBe('fa-solid fa-circle-question');
    });

    test('the marker has no title when the answer carries no wording for it', () => {
        const { parent, counter } = makeCounter('120');
        renderCountBasis(counter, { ...answer('unknown'), messages: {} });
        expect(parent.children[2].children[0].attrs.title).toBeUndefined();
    });

    test('basis fallback: the copy\'s name in parentheses, no ~', () => {
        const { parent, counter } = makeCounter('120');
        renderCountBasis(counter, answer('fallback'));
        expect(layout(parent)).toEqual(['token_count_approx:', 'token_counter:120', 'token_count_basis:(Gemma / Gemini)']);
    });

    test('basis none, remote, local and no answer: nothing', () => {
        for (const tokenizer of [answer('none'), answer('remote'), answer('local'), null, undefined]) {
            const { parent, counter } = makeCounter('120');
            renderCountBasis(counter, tokenizer);
            expect(layout(parent)).toEqual(['token_count_approx:', 'token_counter:120', 'token_count_basis:']);
        }
    });

    test('omitCopyLabel: a fallback copy gets no label, and unknown and failed still get ~ and the marker', () => {
        const fallback = makeCounter('120');
        renderCountBasis(fallback.counter, answer('fallback'), { omitCopyLabel: true });
        expect(layout(fallback.parent)).toEqual(['token_count_approx:', 'token_counter:120', 'token_count_basis:']);
        expect(fallback.parent.children[2].children).toHaveLength(0);

        for (const basis of ['unknown', 'failed']) {
            const { parent, counter } = makeCounter('120');
            renderCountBasis(counter, answer(basis), { omitCopyLabel: true });
            expect(layout(parent)).toEqual(['token_count_approx:~', 'token_counter:120', 'token_count_basis:']);
            expect(parent.children[2].children[0].className).toBe('fa-solid fa-circle-question');
            expect(parent.children[2].children[0].attrs.title).toBe(unknownModel);
        }
    });

    test('re-rendering reuses the two siblings and never changes the count\'s text', () => {
        const { parent, counter } = makeCounter('120');
        renderCountBasis(counter, answer('unknown'));
        renderCountBasis(counter, answer('fallback'));
        renderCountBasis(new FakeQuery([counter]), answer('failed'));
        expect(parent.children).toHaveLength(3);
        expect(layout(parent)).toEqual(['token_count_approx:~', 'token_counter:120', 'token_count_basis:']);
        expect(parent.children[2].children).toHaveLength(1);
        renderCountBasis(counter, answer('remote'));
        expect(layout(parent)).toEqual(['token_count_approx:', 'token_counter:120', 'token_count_basis:']);
        expect(counter.textContent).toBe('120');
    });
});

describe('notices from counts', () => {
    test('two estimate count responses toast once; a model change toasts again', async () => {
        await useApi('textgenerationwebui');
        respond = respondWith('failed');
        await tokenizersModule.getTokenCountAsync('abc');
        await tokenizersModule.getTokenCountAsync('abc');
        expect(requests.filter(r => r.url === '/api/tokenizers/current/count')).toHaveLength(2);
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);

        settings.textgen.llamacpp_model = 'm2';
        await tokenizersModule.getTokenCountAsync('abc');
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(2);
        expect(globalThis.toastr.warning.mock.calls[1][0]).toContain('|m2|');
    });

    test('the sync count, encode and trim responses show their warnings too', async () => {
        await useApi('textgenerationwebui');
        respond = respondWith('fallback');
        tokenizersModule.getTokenCount('abc');
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);

        globalThis.sessionStorage = makeStorage();
        tokenizersModule.encodeCurrentTokens('abc');
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(2);

        globalThis.sessionStorage = makeStorage();
        await tokenizersModule.trimCurrentTokens('abc', 1, 'start');
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(3);
    });

    test('decode responses show no warning', async () => {
        await useApi('textgenerationwebui');
        respond = respondWith('failed');
        tokenizersModule.decodeCurrentTokens([1, 2]);
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    test('chat completion\'s sync and async message counts show their warnings', async () => {
        await useApi('openai');
        respond = respondWith('failed');
        await tokenizersModule.countTokensOpenAIAsync({ content: 'abc' });
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);

        globalThis.sessionStorage = makeStorage();
        tokenizersModule.countTokensOpenAI({ content: 'abc' });
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(2);
    });

    test('a notice that throws doesn\'t make a count throw or reject', async () => {
        await useApi('textgenerationwebui');
        respond = respondWith('failed');
        globalThis.toastr = { warning: jest.fn(() => { throw new Error('toastr broke'); }) };
        await expect(tokenizersModule.getTokenCountAsync('abc')).resolves.toBe(3);
        expect(() => tokenizersModule.getTokenCount('abcd')).not.toThrow();
        await useApi('openai');
        await expect(tokenizersModule.countTokensOpenAIAsync({ content: 'abc' })).resolves.toBe(5);
    });
});

describe('getRememberedTokenizerAnswer', () => {
    test('gives the remembered answer for the current state without asking the server', async () => {
        await useApi('textgenerationwebui');
        expect(tokenizersModule.getRememberedTokenizerAnswer()).toBeNull();
        expect(requests).toEqual([]);

        respond = respondWith('unknown');
        await tokenizersModule.getTokenCountAsync('abc');
        const before = requests.length;
        expect(tokenizersModule.getRememberedTokenizerAnswer()).toEqual(answer('unknown'));
        expect(requests).toHaveLength(before);

        settings.textgen.llamacpp_model = 'm2';
        expect(tokenizersModule.getRememberedTokenizerAnswer()).toBeNull();
        expect(requests).toHaveLength(before);
    });
});

describe('trim on browser-built sends', () => {
    test('a send that counted with basis failed shows one trim-estimate warning', async () => {
        await useApi('textgenerationwebui');
        respond = respondWith('failed');
        await tokenizersModule.getTokenCountAsync('abc');
        await tokenizersModule.getTokenCountAsync('abcd');
        globalThis.toastr.warning.mockClear();

        tokenizersModule.showTrimEstimateWarning();
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.warning).toHaveBeenCalledWith(trimEstimate);

        tokenizersModule.showTrimEstimateWarning();
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(2);
    });

    test('a send that counted with basis unknown shows none', async () => {
        await useApi('textgenerationwebui');
        respond = respondWith('unknown');
        await tokenizersModule.getTokenCountAsync('abc');
        tokenizersModule.showTrimEstimateWarning();
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    test('no remembered answer shows none and asks nothing', async () => {
        await useApi('textgenerationwebui');
        tokenizersModule.showTrimEstimateWarning();
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
    });
});
