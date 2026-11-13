import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORLD_INFO_GLOBAL_DEFAULTS, worldInfoGlobalsOf } from '../../public/scripts/world-info-globals.js';
import { FIELDS } from '@st/settings/protocol';
import { activateWorldInfoEntries } from './activation.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const SERVER_READERS = [
    'src/world-info/activation.js',
    'src/world-info/key-matching.js',
    'src/chat-completion-generation-input.js',
    'src/text-completion-generation-input.js',
    'src/prompt/text-prompt.js',
].map(read).join('\n');
const PAGE_READERS = read('public/scripts/generation.js');

test('every world info setting is a settings field, and nothing else is', () => {
    const fields = FIELDS.filter(field => field.family === 'worldInfo').map(field => field.path.replace(/^world_info_settings\./, ''));
    assert.deepEqual(new Set(fields), new Set(Object.keys(WORLD_INFO_GLOBAL_DEFAULTS)));
});

test('every setting is read where it acts: the server for activation, the page for the budget alert', () => {
    for (const key of Object.keys(WORLD_INFO_GLOBAL_DEFAULTS)) {
        const readers = key === 'world_info_overflow_alert' ? PAGE_READERS : SERVER_READERS;
        assert.match(readers, new RegExp(`\\b${key}\\b`), `${key} is never read`);
    }
});

test('stored values are taken as the page takes them', () => {
    assert.deepEqual(worldInfoGlobalsOf(undefined), WORLD_INFO_GLOBAL_DEFAULTS);
    const globals = worldInfoGlobalsOf({ world_info_depth: '5', world_info_case_sensitive: 1, world_info_budget: 500, world_info_budget_cap: 'x' });
    assert.equal(globals.world_info_depth, 5);
    assert.equal(globals.world_info_case_sensitive, true);
    assert.equal(globals.world_info_budget, 25, 'a budget over 100% is the old format and reads as the default');
    assert.equal(globals.world_info_budget_cap, 0);
});

test('activation follows the global case and whole-word settings for a key without its own flags', async () => {
    const entries = [
        { uid: '1', world: 'w', key: ['DRAGON'], content: 'upper' },
        { uid: '2', world: 'w', key: ['fly'], content: 'inside' },
        { uid: '3', world: 'w', key: ['DRAGON'], content: 'own flag', caseSensitive: false },
    ];
    const run = async (flags) => (await activateWorldInfoEntries(entries, ['a dragon and a dragonfly'], {
        maxContext: 4000, countTokens: async () => 1,
        globals: worldInfoGlobalsOf({ world_info_depth: 1, world_info_budget: 100, ...flags }),
    })).activatedEntries.map(e => e.content).sort();
    assert.deepEqual(await run({ world_info_case_sensitive: false, world_info_match_whole_words: false }), ['inside', 'own flag', 'upper']);
    assert.deepEqual(await run({ world_info_case_sensitive: true, world_info_match_whole_words: true }), ['own flag']);
});
