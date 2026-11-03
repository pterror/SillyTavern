import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
    PromptOverBudgetError, PromptPlacementError, childrenOf, collectSections, findNode, fitBudget, isActive,
    outletMarker, place, registerProvider, renderChat, renderText,
} from './model.js';

const plain = (/** @type {any} */ section, /** @type {string} */ inner) => `${section.name ? `${section.name}: ` : ''}${inner}\n`;

/**
 * @param {import('./model.js').Section[]} sections
 */
function text(sections, { excluded = new Set(), formatMessage = plain } = {}) {
    const { root } = place(sections);
    return renderText(root, { excluded, unitOf: new Map(), formatMessage }).text;
}

/**
 * @param {import('./model.js').Section[]} sections
 * @param {number} budget
 */
async function budgeted(sections, budget) {
    const { root } = place(sections);
    const { rendered, excluded } = await fitBudget(root, {
        budget,
        render: async (excludedIds, unitOf) => renderText(root, { excluded: excludedIds, unitOf, formatMessage: plain }),
        measure: async (full) => {
            const units = new Map();
            let kept = 0;
            for (const piece of full.pieces) {
                if (piece.unit === null) kept += piece.text.length;
                else units.set(piece.unit, (units.get(piece.unit) ?? 0) + piece.text.length);
            }
            return { kept, units, describeKept: async () => full.pieces.filter(p => p.unit === null).map(p => ({ id: p.section.id, tokens: p.text.length })) };
        },
    });
    return { text: rendered.text, excluded };
}

registerProvider('test-history', (/** @type {string[]} */ lines) => lines.map((line, i) => ({ id: `m${i}`, role: 'user', text: line, budget: 'drop' })));

test('first and last children sit around a section\'s own text; the rest follow it in order, then id', () => {
    assert.equal(text([
        { id: 'note', text: 'NOTE', join: '|' },
        { id: 'top', parent: 'note', at: { first: true }, text: 'top' },
        { id: 'b', parent: 'note', text: 'b' },
        { id: 'a', parent: 'note', text: 'a' },
        { id: 'z', parent: 'note', order: -1, text: 'z' },
    ]), 'top|NOTE|z|a|b');
});

test('before and after put a section next to its target, in the target\'s parent', () => {
    assert.equal(text([
        { id: 'list', join: ',' },
        { id: 'x', parent: 'list', text: 'x' },
        { id: 'y', parent: 'list', text: 'y' },
        { id: 'pre', at: { before: 'y' }, text: 'pre' },
        { id: 'post', at: { after: 'x' }, text: 'post' },
    ]), 'x,post,pre,y');
});

test('n from the end counts only the provider\'s children; past the start it goes first, the deeper one earlier', async () => {
    const sections = await collectSections([
        { id: 'history', provider: 'test-history' },
        { id: 'one', parent: 'history', at: { fromEnd: 1 }, role: 'system', text: 'one' },
        { id: 'zero', parent: 'history', at: { fromEnd: 0 }, role: 'system', text: 'zero' },
        { id: 'far', parent: 'history', at: { fromEnd: 9 }, role: 'system', text: 'far' },
        { id: 'farther', parent: 'history', at: { fromEnd: 12 }, role: 'system', text: 'farther' },
        { id: 'from-start', parent: 'history', at: { fromStart: 1 }, role: 'system', text: 'second' },
    ], {}, { 'test-history': ['a', 'b', 'c'] });
    const { root } = place(sections);
    assert.deepEqual(childrenOf(/** @type {any} */ (findNode(root, 'history'))).map(s => s.id), ['farther', 'far', 'm0', 'from-start', 'm1', 'one', 'm2', 'zero']);
});

test('n from the end of the rendered section counts everything rendered there, once the budget has settled it', () => {
    const sections = [
        { id: 'chat' },
        { id: 'a', parent: 'chat', role: 'user', text: 'a' },
        { id: 'b', parent: 'chat', role: 'user', text: 'b' },
        { id: 'c', parent: 'chat', role: 'user', text: 'c' },
        { id: 'cfg', parent: 'chat', at: { fromEndRendered: 2 }, text: 'CFG\n' },
    ];
    assert.equal(text(/** @type {any} */ (sections)), 'a\nCFG\nb\nc\n');
    assert.equal(text(/** @type {any} */ (sections), { excluded: new Set(['a']) }), 'CFG\nb\nc\n');
});

test('a section whose parent isn\'t in the prompt goes to its fallback, or isn\'t placed and says why', () => {
    const { root, unplaced } = place([
        { id: 'home', text: 'H' },
        { id: 'lost', parent: 'gone', text: 'L' },
        { id: 'saved', parent: 'gone', fallback: 'home', text: 'S' },
    ]);
    assert.deepEqual(unplaced, [{ id: 'lost', reason: 'its parent "gone" isn\'t in this prompt' }]);
    assert.deepEqual(childrenOf(/** @type {any} */ (findNode(root, 'home'))).map(s => s.id), ['saved']);
});

test('placements that loop are refused', () => {
    assert.throws(() => place([{ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }]), PromptPlacementError);
    assert.throws(() => place([{ id: 'a', at: { after: 'b' } }, { id: 'b', at: { before: 'a' } }]), PromptPlacementError);
});

test('a reference to an outlet in any section\'s text declares it, and entries placed in it fill it', () => {
    assert.equal(text([
        { id: 'description', text: `A ranger. Outlet: ${outletMarker('spot')}.` },
        { id: 'lore1', parent: 'outlet:spot', text: 'cold river' },
        { id: 'lore2', parent: 'outlet:spot', order: 1, text: 'old trees' },
    ]), 'A ranger. Outlet: cold river\nold trees.');
    assert.equal(text([{ id: 'description', text: `Outlet: ${outletMarker('empty')}.` }]), 'Outlet: .');
});

test('a joining text section merges into the message before it with today\'s newline and space rules', () => {
    const chat = (/** @type {any} */ joins, /** @type {string} */ joined) => text([
        { id: 'history' },
        { id: 'm', parent: 'history', role: 'user', name: 'User', text: 'hi' },
        { id: 'reply', parent: 'history', order: 1, text: joined, joins },
    ]);
    assert.equal(chat({ trimNewline: true }, ''), 'User: hi');
    assert.equal(chat({ trimNewline: true, breakBefore: true }, 'Aria:'), 'User: hi\nAria:');
    assert.equal(chat({ breakBefore: true }, 'Aria:'), 'User: hi\nAria:');
    assert.equal(chat({ trimNewline: true }, ''), 'User: hi');
    assert.equal(chat({ spaceBefore: true }, 'Sure'), 'User: hi\nSure');
    assert.equal(chat({ trimNewline: true, spaceBefore: true }, 'Sure'), 'User: hi Sure');
    assert.equal(text([{ id: 'history' }, { id: 'reply', parent: 'history', text: 'Aria:', joins: { breakBefore: true } }]), '\nAria:', 'with nothing to join it joins an empty one');
});

test('the first message, the last user message and the continued one get their variants', () => {
    const seen = [];
    text([
        { id: 'a', role: 'assistant', text: 'a' },
        { id: 'b', role: 'user', order: 1, text: 'b' },
        { id: 'c', role: 'user', order: 2, text: 'c' },
        { id: 'd', role: 'assistant', order: 3, text: 'd', continued: true },
    ], { formatMessage: (section, inner, variant) => { seen.push([section.id, variant]); return inner; } });
    assert.deepEqual(seen, [
        ['a', { first: true, lastUser: false, continued: false }],
        ['b', { first: false, lastUser: false, continued: false }],
        ['c', { first: false, lastUser: true, continued: false }],
        ['d', { first: false, lastUser: false, continued: true }],
    ]);
});

test('chat: each section with a role is a message of its descendants\' text', () => {
    const { root } = place([
        { id: 'sys', role: 'system', join: '\n' },
        { id: 'x', parent: 'sys', text: 'one' },
        { id: 'y', parent: 'sys', text: 'two' },
        { id: 'u', order: 1, role: 'user', text: 'hello' },
    ]);
    assert.deepEqual(renderChat(root, { excluded: new Set(), unitOf: new Map() }).specs.map(s => [s.role, s.content]), [['system', 'one\ntwo'], ['user', 'hello']]);
});

test('conditions: always, generation type, all / any / not, and an evaluator\'s outcome', () => {
    assert.equal(isActive(undefined, {}), true);
    assert.equal(isActive({ types: ['impersonate'] }, { type: 'impersonate' }), true);
    assert.equal(isActive({ types: ['impersonate'] }, { type: 'normal' }), false);
    assert.equal(isActive({ all: [{ always: true }, { not: { types: ['quiet'] } }] }, { type: 'normal' }), true);
    assert.equal(isActive({ any: [{ is: false, by: 'keywords' }, { types: ['continue'] }] }, { type: 'normal' }), false);
});

test('budget: what\'s kept is counted first, and alone over the budget the request is refused, naming its parts', async () => {
    const sections = [{ id: 'system', text: 'x'.repeat(50) }, { id: 'card', order: 1, text: 'y'.repeat(30) }];
    await assert.rejects(budgeted(sections, 79), (error) => {
        assert.ok(error instanceof PromptOverBudgetError);
        assert.equal(error.kept, 80);
        assert.deepEqual(error.sections, [{ id: 'system', tokens: 50 }, { id: 'card', tokens: 30 }]);
        return true;
    });
    assert.equal((await budgeted(sections, 80)).text.length, 80, 'a total at the budget fits');
});

test('budget: history fills newest first in whole messages, stopping at the first that doesn\'t fit; entries in it are kept', async () => {
    const sections = await collectSections([
        { id: 'history', provider: 'test-history', budget: 'trim', trimFrom: 'start', priority: 0 },
        { id: 'note', parent: 'history', at: { fromEnd: 3 }, role: 'system', text: 'NOTE' },
    ], {}, { 'test-history': ['aaaa', 'bb', 'cccccccc', 'dd', 'ee'] });
    const { text: out, excluded } = await budgeted(sections, 5 + 3 + 3 + 9 + 2);
    assert.deepEqual([...excluded], ['m1', 'm0'], 'cccccccc fit; bb would too but the oldest are dropped together');
    assert.equal(out, 'NOTE\ncccccccc\ndd\nee\n');
});

test('budget: examples fill after history, or before it when pinned; a dropped-whole section by its priority', async () => {
    const layout = (pinned) => collectSections([
        { id: 'examples', budget: 'trim', trimFrom: 'end', priority: pinned ? -1 : 1 },
        { id: 'e0', parent: 'examples', budget: 'drop', text: 'EXAMPLE-A\n' },
        { id: 'e1', parent: 'examples', order: 1, budget: 'drop', text: 'EXAMPLE-B\n' },
        { id: 'history', order: 1, provider: 'test-history', budget: 'trim', trimFrom: 'start', priority: 0 },
        { id: 'filler', order: 2, budget: 'drop', priority: 5, text: 'F\n' },
    ], {}, { 'test-history': ['111111111', '222222222'] });
    assert.deepEqual([...(await budgeted(await layout(false), 30)).excluded].sort(), ['e1', 'filler']);
    assert.deepEqual([...(await budgeted(await layout(true), 30)).excluded].sort(), ['filler', 'm0']);
});

test('the prompt is built in one place: the builders it replaced are gone', () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    for (const file of [
        'text-completion-prompt-orchestrator.js', 'chat-completion-prepare-messages.js', 'chat-completion-prepare-prompts.js',
        'chat-completion-populate.js', 'chat-completion-injection-prompts.js', 'chat-completion-history.js', 'chat-completion-dialogue-examples.js',
        'chat-completion-system-prompts.js', 'chat-completion-prompt-collection.js', 'chat-completion-budget.js', 'chat-history-budget.js',
        'prompt-size-backoff.js', 'final-prompt-combination.js', 'story-string-assembly.js', 'prompt-injections.js', 'extension-prompt-table.js',
    ]) assert.equal(fs.existsSync(path.join(src, file)), false, `${file} is back beside the prompt model`);
});
