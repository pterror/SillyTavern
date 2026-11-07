import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import Handlebars from 'handlebars';

const window = new Window();
const jquery = { exports: /** @type {any} */ ({}) };
new Function('window', 'module', readFileSync(new URL('../public/lib/jquery-3.5.1.min.js', import.meta.url), 'utf8'))(window, jquery);
/** @type {JQueryStatic} */
const view = jquery.exports;
global.$ = view;

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
            window.document.body.innerHTML = template;
            const control = () => ({ style: {}, addEventListener: jest.fn() });
            this.dlg = {
                querySelector: (selector) => {
                    if (['#diffPrevPrompt', '#copyPromptToClipboard', '#showRawPrompt'].includes(selector)) {
                        return control();
                    }
                    return window.document.querySelector(selector);
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
    total: 100,
    parts: [
        { part: 'story_string', tokens: 20 }, { part: 'system_prompt', tokens: 4 }, { part: 'description', tokens: 10 },
        { part: 'examples', tokens: 6 }, { part: 'chat_history', tokens: 52 }, { part: 'post_history', tokens: 8 },
    ],
});

const chatSet = (tokenizer = answer('Gemma / Gemini', 'local')) => ({
    mesId: 0, api: 'openai', preset: null, sampler_config: {}, tokenizer,
    max_context: 8000, padding: 0, rawPrompt: [{ role: 'system', content: 'x' }], messages_count: 4, examples_count: 0,
    total: 200,
    parts: [
        { part: 'main', tokens: 30 }, { part: 'description', tokens: 20 }, { part: 'chat_history', tokens: 90 },
        { part: 'authors_note', tokens: 8 }, { part: 'post_history', tokens: 52 },
    ],
});

beforeEach(() => {
    window.document.body.innerHTML = '';
});

describe('the prompt view lists the stored parts', () => {
    test('in their order, with their counts and shares; the chat history and examples with how many', async () => {
        const params = await itemizedParams([textSet()], 0, 0);
        expect(params.parts.map(p => [p.label, p.tokens, p.count, p.percent])).toEqual([
            ['Story string', 20, undefined, '20.00'], ['System prompt', 4, undefined, '4.00'], ['Description', 10, undefined, '10.00'],
            ['Example dialogues', 6, 1, '6.00'], ['Chat history', 52, 3, '52.00'], ['Post-history instructions', 8, undefined, '8.00'],
        ]);
        expect(params).toMatchObject({
            presetName: 'Simple', samplerConfig: JSON.stringify({ temp: 0.7 }, null, 2), selectedTokenizer: 'Gemma / Gemini',
            total: 100, maxContext: 4000, padding: 64,
        });
    });

    test('each API shows only its own parts', async () => {
        const params = await itemizedParams([chatSet()], 0, 0);
        expect(params.parts.map(p => p.label)).toEqual(['Main prompt', 'Description', 'Chat history', 'Author\'s Note', 'Post-history instructions']);
        expect(params.presetName).toBe('(Unknown)');
    });

    test('an empty part is never a row', async () => {
        const set = { ...textSet(), parts: [{ part: 'bias', tokens: 0 }, { part: 'chat_history', tokens: 5 }] };
        expect((await itemizedParams([set], 0, 0)).parts.map(p => p.label)).toEqual(['Chat history']);
        expect((await itemizedParams([{ mesId: 0, api: 'textgenerationwebui', rawPrompt: 'p' }], 0, 0))).toMatchObject({ parts: [], total: 0, tokenizerAnswer: null });
    });

    test('the one view renders every API\'s parts, and padding only when there is some', async () => {
        await promptItemize([textSet()], 0);
        const text = view('body').text().replace(/\s+/g, ' ');
        expect(text).toContain('Post-history instructions 8');
        expect(text).toContain('Chat history (3) 52');
        expect(text).toContain('Total Tokens in Prompt: 100');
        expect(text).toContain('Padding: 64');
        expect(text).not.toContain('Bias');

        await promptItemize([chatSet()], 0);
        const chatText = view('body').text().replace(/\s+/g, ' ');
        expect(chatText).toContain('Main prompt 30');
        expect(chatText).toContain('Total Tokens in Prompt: 200');
        expect(chatText).not.toContain('Padding');
        expect(view('.tokenGraph > div')).toHaveLength(5);
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
