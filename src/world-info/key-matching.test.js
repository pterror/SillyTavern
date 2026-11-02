import assert from 'node:assert/strict';
import { matchKeys, parseRegexFromString, WorldInfoBuffer, matchesEntryKeys, world_info_logic, scan_state } from './key-matching.js';
import { LOOSE, globalsWith } from './test-globals.js';

assert.equal(matchKeys('the dragon sleeps', 'dragon', {}, LOOSE), true);
assert.equal(matchKeys('the dragon sleeps', 'griffin', {}, LOOSE), false);

assert.equal(matchKeys('The DRAGON sleeps', 'dragon', {}, LOOSE), true, 'case-insensitive by default');
assert.equal(matchKeys('The DRAGON sleeps', 'dragon', { caseSensitive: true }, LOOSE), false);
assert.equal(matchKeys('The DRAGON sleeps', 'DRAGON', { caseSensitive: true }, LOOSE), true);

assert.equal(matchKeys('dragonfly', 'dragon', { matchWholeWords: true }, LOOSE), false);
assert.equal(matchKeys('a dragon flies', 'dragon', { matchWholeWords: true }, LOOSE), true);
assert.equal(matchKeys('a dragon.', 'dragon', { matchWholeWords: true }, LOOSE), true, 'punctuation counts as a word boundary');

assert.equal(matchKeys('DRAGON', '/dragon/i', { caseSensitive: true }, LOOSE), true);
assert.equal(matchKeys('griffin', '/dragon/i', {}, LOOSE), false);
assert.equal(parseRegexFromString('not a regex'), null);
assert.ok(parseRegexFromString('/abc/gi') instanceof RegExp);

{
    const buffer = new WorldInfoBuffer(['most recent message', 'older message'], { characterDescription: 'a tall knight' }, globalsWith({ world_info_depth: 2 }));
    const text = buffer.get({ matchCharacterDescription: true }, scan_state.INITIAL);
    assert.ok(text.includes('most recent message'));
    assert.ok(text.includes('older message'));
    assert.ok(text.includes('a tall knight'));
}

{
    const buffer = new WorldInfoBuffer(['msg0'], {}, globalsWith({ world_info_depth: 1 }));
    buffer.addRecurse('injected from recursion');
    const text = buffer.get({}, scan_state.RECURSION);
    assert.ok(text.includes('injected from recursion'));
    assert.equal(buffer.hasRecurse(), true);
}

{
    const buffer = new WorldInfoBuffer(['the dragon appears'], {}, globalsWith({ world_info_depth: 1 }));
    const text = buffer.get({}, scan_state.INITIAL);
    assert.equal(matchesEntryKeys(text, { key: ['dragon'] }, buffer), true);
    assert.equal(matchesEntryKeys(text, { key: ['griffin'] }, buffer), false);
    assert.equal(matchesEntryKeys(text, { key: [] }, buffer), false, 'no keys defined never activates');
}

{
    const buffer = new WorldInfoBuffer(['the dragon breathes fire'], {}, globalsWith({ world_info_depth: 1 }));
    const text = buffer.get({}, scan_state.INITIAL);
    const entry = { key: ['dragon'], selective: true, keysecondary: ['fire', 'ice'], selectiveLogic: world_info_logic.AND_ANY };
    assert.equal(matchesEntryKeys(text, entry, buffer), true, 'AND_ANY: fire matches');
    const entryNoMatch = { key: ['dragon'], selective: true, keysecondary: ['ice', 'water'], selectiveLogic: world_info_logic.AND_ANY };
    assert.equal(matchesEntryKeys(text, entryNoMatch, buffer), false);
}

{
    const buffer = new WorldInfoBuffer(['the dragon breathes fire and smoke'], {}, globalsWith({ world_info_depth: 1 }));
    const text = buffer.get({}, scan_state.INITIAL);
    const entryAll = { key: ['dragon'], selective: true, keysecondary: ['fire', 'smoke'], selectiveLogic: world_info_logic.AND_ALL };
    assert.equal(matchesEntryKeys(text, entryAll, buffer), true);
    const entryPartial = { key: ['dragon'], selective: true, keysecondary: ['fire', 'ice'], selectiveLogic: world_info_logic.AND_ALL };
    assert.equal(matchesEntryKeys(text, entryPartial, buffer), false);
}

{
    const buffer = new WorldInfoBuffer(['the dragon sleeps peacefully'], {}, globalsWith({ world_info_depth: 1 }));
    const text = buffer.get({}, scan_state.INITIAL);
    const notAny = { key: ['dragon'], selective: true, keysecondary: ['fire', 'ice'], selectiveLogic: world_info_logic.NOT_ANY };
    assert.equal(matchesEntryKeys(text, notAny, buffer), true, 'neither secondary word present');
    const notAll = { key: ['dragon'], selective: true, keysecondary: ['sleeps', 'ice'], selectiveLogic: world_info_logic.NOT_ALL };
    assert.equal(matchesEntryKeys(text, notAll, buffer), true, 'not all secondary words present (ice is missing)');
}

{
    const forced = { uid: '1', world: 'w', content: 'forced' };
    const buffer = new WorldInfoBuffer(['irrelevant'], {}, globalsWith(), new Map([['w.1', forced]]));
    assert.equal(buffer.getExternallyActivated({ uid: '1', world: 'w' }), forced);
    assert.equal(buffer.getExternallyActivated({ uid: '2', world: 'w' }), undefined);
}

{
    const buffer = new WorldInfoBuffer(['irrelevant'], {}, globalsWith());
    assert.equal(buffer.getExternallyActivated({ uid: '1', world: 'w' }), undefined);
}

console.log('key-matching.test.js: all assertions passed');
