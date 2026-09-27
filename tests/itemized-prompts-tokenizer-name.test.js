import { beforeAll, describe, expect, jest, test } from '@jest/globals';

// The itemized view names the tokenizer its own count batch used, not the stored name.

const jqueryElement = {
    first: jest.fn(function () { return this; }),
    text: jest.fn(() => ''),
};
global.$ = jest.fn(() => jqueryElement);

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
jest.unstable_mockModule('../public/scripts/popup.js', () => ({ Popup: jest.fn(), POPUP_TYPE: {} }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: { token_padding: 0 },
    registerDebugFunction: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ isMobile: jest.fn(() => false) }));
jest.unstable_mockModule('../public/scripts/templates.js', () => ({ renderTemplateAsync: jest.fn() }));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    getTokenCountsWithTokenizer: jest.fn(async (strings) => ({
        counts: strings.map(() => 0),
        tokenizer: { tokenizerName: 'Gemma / Gemini', tokenizerKey: 'gemma', tokenizerId: 13 },
    })),
    getTokenCountsAsyncBatch: jest.fn(async (strings) => strings.map(() => 0)),
    getFriendlyTokenizerName: jest.fn(() => ({ tokenizerName: 'Llama 1/2', tokenizerKey: 'llama', tokenizerId: 3 })),
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({ copyText: jest.fn() }));

/** @type {typeof import('../public/scripts/itemized-prompts.js').itemizedParams} */
let itemizedParams;

beforeAll(async () => {
    ({ itemizedParams } = await import('../public/scripts/itemized-prompts.js'));
});

const textFields = {
    charDescription: '', charPersonality: '', scenarioText: '', userPersona: '', worldInfoString: '',
    allAnchors: '', summarizeString: '', authorsNoteString: '', smartContextString: '',
    beforeScenarioAnchor: '', afterScenarioAnchor: '', zeroDepthAnchor: '', chatInjects: '',
    chatVectorsString: '', dataBankVectorsString: '',
};

describe('the itemized view names its count batch\'s tokenizer', () => {
    test('a non-chat-completion prompt set shows the batch\'s tokenizer, not the stored one', async () => {
        const set = {
            ...textFields,
            mesId: 0,
            main_api: 'textgenerationwebui',
            padding: 0,
            this_max_context: 0,
            tokenizer: 'Llama 1/2',
            finalPrompt: '', storyString: '', examplesString: '', mesSendString: '', instruction: '', promptBias: '',
        };
        expect((await itemizedParams([set], 0, 0)).selectedTokenizer).toBe('Gemma / Gemini');
    });

    test('a chat-completion prompt set shows the batch\'s tokenizer', async () => {
        const set = {
            ...textFields,
            mesId: 0,
            main_api: 'openai',
            padding: 0,
            oaiMainTokens: 0, oaiStartTokens: 0, oaiConversationTokens: 0, oaiExamplesTokens: 0, oaiPromptTokens: 0,
            oaiBiasTokens: 0, oaiJailbreakTokens: 0, oaiNudgeTokens: 0, oaiImpersonateTokens: 0, oaiNsfwTokens: 0,
        };
        expect((await itemizedParams([set], 0, 0)).selectedTokenizer).toBe('Gemma / Gemini');
    });
});
