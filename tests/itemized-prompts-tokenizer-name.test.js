import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import Handlebars from 'handlebars';

// The itemized view names the tokenizer its own count batch used, not the stored name, and marks
// that batch's basis beside the name.

global.$ = cheerio.load('');

/** The batch `getTokenCountsWithTokenizer` answers with. */
let batch;

/** @type {cheerio.CheerioAPI|null} The rendered view. */
let view = null;

jest.unstable_mockModule('../public/lib.js', () => ({
    DiffMatchPatch: jest.fn(),
    DOMPurify: { sanitize: jest.fn() },
    localforage: { createInstance: () => ({}) },
}));
jest.unstable_mockModule('../public/script.js', () => ({
    getCurrentChatId: jest.fn(),
    reloadCurrentChat: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/chat-state.js', () => ({ chat: [] }));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({ getRequestHeaders: jest.fn(() => ({})) }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({
    event_types: {},
    eventSource: { emit: jest.fn(), on: jest.fn() },
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
jest.unstable_mockModule('../public/scripts/chat-completion-settings.js', () => ({
    oai_settings: { openai_max_context: 0, openai_max_tokens: 0 },
}));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    POPUP_TYPE: {},
    Popup: class {
        /** @param {string} template */
        constructor(template) {
            view = cheerio.load(template);
            global.$ = view;
            const control = () => ({ style: {}, addEventListener: jest.fn() });
            this.dlg = {
                querySelector: (selector) => {
                    const node = view(selector)[0];
                    if (['#diffPrevPrompt', '#copyPromptToClipboard', '#showRawPrompt'].includes(selector)) {
                        return control();
                    }
                    return node ?? null;
                },
            };
        }
        async show() {}
    },
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: { token_padding: 0 },
    registerDebugFunction: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ isMobile: jest.fn(() => false) }));
jest.unstable_mockModule('../public/scripts/templates.js', () => ({
    renderTemplateAsync: jest.fn(async (templateId, data) => {
        const source = readFileSync(new URL(`../public/scripts/templates/${templateId}.html`, import.meta.url), 'utf8');
        return Handlebars.compile(source)(data);
    }),
}));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    getTokenCountsWithTokenizer: jest.fn(async (strings) => ({ counts: strings.map(() => 0), ...batch })),
    getTokenCountsAsyncBatch: jest.fn(async (strings) => strings.map(() => 0)),
    getFriendlyTokenizerName: jest.fn(() => ({ tokenizerName: 'Llama 1/2', tokenizerKey: 'llama', tokenizerId: 3 })),
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({ copyText: jest.fn() }));

/** @type {typeof import('../public/scripts/itemized-prompts.js').itemizedParams} */
let itemizedParams;
/** @type {typeof import('../public/scripts/itemized-prompts.js').promptItemize} */
let promptItemize;

beforeAll(async () => {
    ({ itemizedParams, promptItemize } = await import('../public/scripts/itemized-prompts.js'));
});

const unknownModel = 'No tokenizer is known for this model, so token counts are estimates. A tokenizer can be picked in Advanced Formatting → Tokenizer.';

/**
 * A batch whose shown name is `shownName` and whose answer has `basis` and `name`.
 * @param {string} shownName
 * @param {string} basis
 * @param {string} name
 */
function makeBatch(shownName, basis, name) {
    return {
        tokenizer: { tokenizerName: shownName, tokenizerKey: 'gemma', tokenizerId: 13 },
        answer: { id: 13, name, basis, key: 'textgenerationwebui|llamacpp|u|m1|gemma', messages: { unknownModel } },
    };
}

beforeEach(() => {
    batch = makeBatch('Gemma / Gemini', 'local', 'Gemma / Gemini');
    view = null;
    global.$ = cheerio.load('');
});

const textFields = {
    charDescription: '', charPersonality: '', scenarioText: '', userPersona: '', worldInfoString: '',
    allAnchors: '', summarizeString: '', authorsNoteString: '', smartContextString: '',
    beforeScenarioAnchor: '', afterScenarioAnchor: '', zeroDepthAnchor: '', chatInjects: '',
    chatVectorsString: '', dataBankVectorsString: '',
};

const textSet = () => ({
    ...textFields,
    mesId: 0,
    main_api: 'textgenerationwebui',
    padding: 0,
    this_max_context: 0,
    tokenizer: 'Llama 1/2',
    finalPrompt: '', storyString: '', examplesString: '', mesSendString: '', instruction: '', promptBias: '',
});

const chatSet = () => ({
    ...textFields,
    mesId: 0,
    main_api: 'openai',
    padding: 0,
    oaiMainTokens: 0, oaiStartTokens: 0, oaiConversationTokens: 0, oaiExamplesTokens: 0, oaiPromptTokens: 0,
    oaiBiasTokens: 0, oaiJailbreakTokens: 0, oaiNudgeTokens: 0, oaiImpersonateTokens: 0, oaiNsfwTokens: 0,
});

const zeroCounts = {
    charDescriptionTokens: 0, charPersonalityTokens: 0, scenarioTextTokens: 0, userPersonaStringTokens: 0,
    worldInfoStringTokens: 0, allAnchorsTokens: 0, summarizeStringTokens: 0, authorsNoteStringTokens: 0,
    smartContextStringTokens: 0, beforeScenarioAnchorTokens: 0, afterScenarioAnchorTokens: 0,
    zeroDepthAnchorTokens: 0, chatInjects: 0, chatVectorsStringTokens: 0, dataBankVectorsStringTokens: 0,
};

const shared = {
    thisPrompt_padding: 0,
    modelUsed: undefined,
    apiUsed: undefined,
    presetName: '(Unknown)',
    messagesCount: '',
    examplesCount: '',
    samplerConfig: '{}',
};

/** Every field itemizedParams returns for textSet() besides tokenizerAnswer. */
const textParamsBefore = {
    ...zeroCounts,
    finalPromptTokens: 0, storyStringTokens: 0, examplesStringTokens: 0, mesSendStringTokens: 0,
    instructionTokens: 0, promptBiasTokens: 0,
    ...shared,
    this_main_api: 'textgenerationwebui',
    mainApiFriendlyName: 'textgenerationwebui',
    ActualChatHistoryTokens: 0,
    totalTokensInPrompt: 0,
    thisPrompt_max_context: 0,
    thisPrompt_actual: 0,
    storyStringTokensPercentage: 'NaN',
    ActualChatHistoryTokensPercentage: 'NaN',
    promptBiasTokensPercentage: 'NaN',
    worldInfoStringTokensPercentage: 'NaN',
    allAnchorsTokensPercentage: 'NaN',
    selectedTokenizer: 'Gemma / Gemini',
};

/** Every field itemizedParams returns for chatSet() besides tokenizerAnswer. */
const chatParamsBefore = {
    ...zeroCounts,
    ...shared,
    this_main_api: 'openai',
    mainApiFriendlyName: 'openai',
    oaiMainTokens: 0, oaiStartTokens: 0, ActualChatHistoryTokens: 0, examplesStringTokens: 0, oaiPromptTokens: 0,
    oaiBiasTokens: 0, oaiJailbreakTokens: 0, oaiNudgeTokens: 0, oaiImpersonateTokens: 0, oaiNsfwTokens: 0,
    finalPromptTokens: 0,
    thisPrompt_max_context: 0,
    oaiStartTokensPercentage: 'NaN',
    storyStringTokensPercentage: 'NaN',
    ActualChatHistoryTokensPercentage: 'NaN',
    promptBiasTokensPercentage: 'NaN',
    worldInfoStringTokensPercentage: 'NaN',
    allAnchorsTokensPercentage: 'NaN',
    selectedTokenizer: 'Gemma / Gemini',
    oaiSystemTokens: 0,
    oaiSystemTokensPercentage: 'NaN',
};

describe('the itemized view names its count batch\'s tokenizer', () => {
    test('a non-chat-completion prompt set shows the batch\'s tokenizer, not the stored one', async () => {
        expect((await itemizedParams([textSet()], 0, 0)).selectedTokenizer).toBe('Gemma / Gemini');
    });

    test('a chat-completion prompt set shows the batch\'s tokenizer', async () => {
        expect((await itemizedParams([chatSet()], 0, 0)).selectedTokenizer).toBe('Gemma / Gemini');
    });
});

describe('itemizedParams returns the batch\'s answer', () => {
    test('a non-chat-completion prompt set: tokenizerAnswer is the batch\'s, every other field unchanged', async () => {
        expect(await itemizedParams([textSet()], 0, 0)).toStrictEqual({ ...textParamsBefore, tokenizerAnswer: batch.answer });
    });

    test('a chat-completion prompt set: tokenizerAnswer is the batch\'s, every other field unchanged', async () => {
        expect(await itemizedParams([chatSet()], 0, 0)).toStrictEqual({ ...chatParamsBefore, tokenizerAnswer: batch.answer });
    });
});

describe('the itemized view marks the batch\'s basis beside the tokenizer name', () => {
    const nameSpan = () => view('#itemizationTokenizerName');

    test('basis unknown: ~ before the name and the marker after it, the name text unchanged', async () => {
        batch = makeBatch('API (llama.cpp)', 'unknown', 'API (llama.cpp)');
        await promptItemize([textSet()], 0);

        const name = nameSpan();
        expect(name).toHaveLength(1);
        expect(name.text()).toBe('API (llama.cpp)');
        expect(name.prev().is('span.token_count_approx')).toBe(true);
        expect(name.prev().text()).toBe('~');
        expect(name.next().is('span.token_count_basis')).toBe(true);
        const marker = name.next().children('i');
        expect(marker.hasClass('fa-circle-question')).toBe(true);
        expect(marker.attr('title')).toBe(unknownModel);
        expect(name.parent().text().replace(/\s+/g, ' ').trim()).toBe('Tokenizer: ~API (llama.cpp)');
    });

    test('a fallback copy whose name is the shown name: no (Name) label, no ~', async () => {
        batch = makeBatch('Gemma / Gemini', 'fallback', 'Gemma / Gemini');
        await promptItemize([textSet()], 0);

        const name = nameSpan();
        expect(name.text()).toBe('Gemma / Gemini');
        expect(name.prev().is('span.token_count_approx')).toBe(true);
        expect(name.prev().text()).toBe('');
        expect(name.next().is('span.token_count_basis')).toBe(true);
        expect(name.next().text()).toBe('');
        expect(name.next().children()).toHaveLength(0);
    });

    test('the chat-completion view marks the name too', async () => {
        batch = makeBatch('some-model', 'unknown', 'API (llama.cpp)');
        await promptItemize([chatSet()], 0);

        const name = nameSpan();
        expect(name.text()).toBe('some-model');
        expect(name.prev().text()).toBe('~');
        expect(name.next().children('i').hasClass('fa-circle-question')).toBe(true);
    });
});
