import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import Handlebars from 'handlebars';

global.$ = cheerio.load('');

/** @type {cheerio.CheerioAPI|null} */
let view = null;

jest.unstable_mockModule('../public/lib.js', () => ({
    DiffMatchPatch: jest.fn(),
    DOMPurify: { sanitize: jest.fn() },
    localforage: { createInstance: jest.fn() },
}));
jest.unstable_mockModule('../public/script.js', () => ({
    getCurrentChatId: jest.fn(),
    getSelectionState: jest.fn(() => ({ type: 'none' })),
    reloadCurrentChat: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/node-identity.js', () => ({ isStoredNodeId: jest.fn(() => true) }));
jest.unstable_mockModule('../public/scripts/chat-state.js', () => ({ chat: [] }));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({ getRequestHeaders: jest.fn(() => ({})) }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({
    event_types: {},
    eventSource: { emit: jest.fn(), on: jest.fn() },
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
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
    getTokenizerState: jest.fn(() => ({ api: 'textgenerationwebui' })),
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({ copyText: jest.fn(), escapeHtml: jest.fn(s => s) }));

/** @type {typeof import('../public/scripts/itemized-prompts.js').itemizedParams} */
let itemizedParams;
/** @type {typeof import('../public/scripts/itemized-prompts.js').promptItemize} */
let promptItemize;

beforeAll(async () => {
    ({ itemizedParams, promptItemize } = await import('../public/scripts/itemized-prompts.js'));
});

const unknownModel = 'No tokenizer is known for this model, so token counts are estimates. A tokenizer can be picked in Advanced Formatting → Tokenizer.';

/**
 * @param {string} name
 * @param {string} basis
 */
const answer = (name, basis) => ({ id: 13, name, basis, key: 'textgenerationwebui|llamacpp|u|m1|gemma', messages: { unknownModel } });

const textSet = (tokenizer = answer('Gemma / Gemini', 'local')) => ({
    mesId: 0, api: 'textgenerationwebui', preset: 'Simple', sampler_config: { temp: 0.7 }, tokenizer,
    max_context: 4000, padding: 64, rawPrompt: 'the prompt', messages_count: 3, examples_count: 1,
    tokens: {
        total: 100, story_string: 20, description: 10, personality: 5, scenario: 2, persona: 1, system_prompt: 4, examples: 6,
        world_info: 10, chat_history: 40, post_history: 8, extensions: 12, summary: 3, authors_note: 4, smart_context: 0,
        chat_vectors: 1, data_bank_vectors: 0, bias: 2,
    },
});

const chatSet = (tokenizer = answer('Gemma / Gemini', 'local')) => ({
    mesId: 0, api: 'openai', preset: null, sampler_config: {}, tokenizer,
    max_context: 8000, padding: 0, rawPrompt: [{ role: 'system', content: 'x' }], messages_count: 4, examples_count: 0,
    tokens: {
        total: 200, main: 30, chat_start: 2, post_history: 9, auxiliary: 0, nudge: 1, impersonate: 0,
        description: 20, personality: 5, scenario: 5, persona: 4, examples: 6, other_prompts: 3, world_info: 15,
        chat_history: 90, extensions: 8, summary: 0, authors_note: 8, smart_context: 0, chat_vectors: 0, data_bank_vectors: 0, bias: 2,
    },
});

beforeEach(() => {
    view = null;
    global.$ = cheerio.load('');
});

describe('the prompt view shows what the server counted', () => {
    test('a text completion itemization: its parts, post-history instructions in the chat history', async () => {
        const params = await itemizedParams([textSet()], 0, 0);
        expect(params).toMatchObject({
            this_main_api: 'textgenerationwebui', presetName: 'Simple', messagesCount: '3', examplesCount: '1',
            samplerConfig: JSON.stringify({ temp: 0.7 }, null, 2), selectedTokenizer: 'Gemma / Gemini',
            storyStringTokens: 20, charDescriptionTokens: 10, instructionTokens: 4, examplesStringTokens: 6, worldInfoStringTokens: 10,
            ActualChatHistoryTokens: 48, postHistoryTokens: 8, allAnchorsTokens: 12, authorsNoteStringTokens: 4, promptBiasTokens: 2,
            totalTokensInPrompt: 100, thisPrompt_max_context: 4000, thisPrompt_padding: 64, thisPrompt_actual: 3936,
            storyStringTokensPercentage: '20.00', ActualChatHistoryTokensPercentage: '48.00',
        });
    });

    test('a chat completion itemization: its parts, post-history instructions among the system ones', async () => {
        const params = await itemizedParams([chatSet()], 0, 0);
        expect(params).toMatchObject({
            this_main_api: 'openai', presetName: '(Unknown)',
            oaiMainTokens: 30, oaiStartTokens: 2, oaiJailbreakTokens: 9, oaiNudgeTokens: 1, oaiSystemTokens: 42,
            oaiPromptTokens: 43, ActualChatHistoryTokens: 90, allAnchorsTokens: 8, authorsNoteStringTokens: 8, oaiBiasTokens: 2,
            finalPromptTokens: 200, thisPrompt_max_context: 8000,
            oaiSystemTokensPercentage: '20.00', oaiStartTokensPercentage: '1.00', ActualChatHistoryTokensPercentage: '45.00',
        });
    });

    test('an itemization without counts shows zeros, not NaN', async () => {
        const params = await itemizedParams([{ mesId: 0, api: 'textgenerationwebui', rawPrompt: 'p' }], 0, 0);
        expect(params.totalTokensInPrompt).toBe(0);
        expect(params.storyStringTokensPercentage).toBe('0.00');
        expect(params.tokenizerAnswer).toBe(null);
    });

    test('the rendered views show the counts', async () => {
        await promptItemize([textSet()], 0);
        expect(view('body').text()).toContain('Post-History Instructions:');
        expect(view('body').text().replace(/\s+/g, ' ')).toContain('Total Tokens in Prompt: 100');
        await promptItemize([chatSet()], 0);
        expect(view('body').text().replace(/\s+/g, ' ')).toContain('Total Tokens in Prompt: 200');
    });
});

describe('the prompt view marks the counter\'s basis beside its name', () => {
    const nameSpan = () => view('#itemizationTokenizerName');

    test('basis unknown: ~ before the name and the marker after it, the name text unchanged', async () => {
        await promptItemize([textSet(answer('API (llama.cpp)', 'unknown'))], 0);

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

    test('a fallback copy: its name is the one shown, no (Name) label, no ~', async () => {
        await promptItemize([textSet(answer('Gemma / Gemini', 'fallback'))], 0);

        const name = nameSpan();
        expect(name.text()).toBe('Gemma / Gemini');
        expect(name.prev().text()).toBe('');
        expect(name.next().text()).toBe('');
        expect(name.next().children()).toHaveLength(0);
    });

    test('the chat completion view marks the name too', async () => {
        await promptItemize([chatSet(answer('API (llama.cpp)', 'unknown'))], 0);

        const name = nameSpan();
        expect(name.text()).toBe('API (llama.cpp)');
        expect(name.prev().text()).toBe('~');
        expect(name.next().children('i').hasClass('fa-circle-question')).toBe(true);
    });
});
