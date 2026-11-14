import { beforeAll, describe, expect, jest, test } from '@jest/globals';

const stubs = {
    'lib.js': ['DOMPurify'],
    'scripts/chat-text/surface.js': ['drawnText', 'grammarOf', 'lookOf', 'redrawEditor', 'TEXT_CLASS'],
    'scripts/chat-text/search.js': ['liveSearch', 'showPresets'],
    'scripts/chat-text/suggest.js': ['macroSuggestions', 'mentionSuggestions'],
    'scripts/chat-text/tooltips.js': ['editorTooltips'],
    'scripts/chat-text/macros.js': ['macroCursorTooltip', 'macroPills', 'macroValueRequests', 'openableMacros'],
};
for (const [module, names] of Object.entries(stubs)) {
    jest.unstable_mockModule(`../public/${module}`, () => Object.fromEntries(names.map(name => [name, {}])));
}

/** @type {typeof import('../public/scripts/chat-text/editor.js')} */
let editor;
/** @type {string[]} */
let chosen = [];

beforeAll(async () => {
    editor = await import('../public/scripts/chat-text/editor.js');
    editor.initChatEditors(/** @type {any} */ ({ toolbarChoice: () => chosen, t: (/** @type {TemplateStringsArray} */ strings) => strings[0] }));
});

/** @param {string[]} ids */
const toolsById = ids => new Map(ids.map(id => [id, /** @type {any} */ ({ id })]));

describe('the tools an editor\'s toolbar shows', () => {
    const formatting = ['bold', 'italic', 'underline', 'strike', 'code', 'heading', 'link', 'quote', 'list', 'codeBlock', 'image'];

    test('are every formatting command, and find and replace where the editor has it, when none are chosen', () => {
        chosen = [];
        const all = toolsById([...formatting, 'macros', 'find', 'presets']);
        expect(editor.shownTools(all).get().map(tool => tool.id)).toEqual([...formatting, 'find']);
    });

    test('are only the formatting commands in an editor without find and replace', () => {
        chosen = [];
        expect(editor.shownTools(toolsById(formatting)).get().map(tool => tool.id)).toEqual(formatting);
    });

    test('are those the person chose, in their order, when they chose some', () => {
        chosen = ['presets', 'bold', 'nothing'];
        expect(editor.shownTools(toolsById([...formatting, 'find', 'presets'])).get().map(tool => tool.id)).toEqual(['presets', 'bold']);
    });
});
