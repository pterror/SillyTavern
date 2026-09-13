import assert from 'node:assert/strict';
import { matchKeys, parseRegexFromString, WorldInfoBuffer, matchesEntryKeys, world_info_logic, scan_state } from './key-matching.js';

// Plain substring matching
assert.equal(matchKeys('the dragon sleeps', 'dragon', {}), true);
assert.equal(matchKeys('the dragon sleeps', 'griffin', {}), false);

// Case sensitivity
assert.equal(matchKeys('The DRAGON sleeps', 'dragon', {}), true, 'case-insensitive by default');
assert.equal(matchKeys('The DRAGON sleeps', 'dragon', { caseSensitive: true }), false);
assert.equal(matchKeys('The DRAGON sleeps', 'DRAGON', { caseSensitive: true }), true);

// Whole word matching
assert.equal(matchKeys('dragonfly', 'dragon', { matchWholeWords: true }), false);
assert.equal(matchKeys('a dragon flies', 'dragon', { matchWholeWords: true }), true);
assert.equal(matchKeys('a dragon.', 'dragon', { matchWholeWords: true }), true, 'punctuation counts as a word boundary');

// Regex keys override everything else
assert.equal(matchKeys('DRAGON', '/dragon/i', { caseSensitive: true }), true);
assert.equal(matchKeys('griffin', '/dragon/i', {}), false);
assert.equal(parseRegexFromString('not a regex'), null);
assert.ok(parseRegexFromString('/abc/gi') instanceof RegExp);

// WorldInfoBuffer: depth window + global scan data
{
    const buffer = new WorldInfoBuffer(['most recent message', 'older message'], { characterDescription: 'a tall knight' }, { depth: 2 });
    const text = buffer.get({ matchCharacterDescription: true }, scan_state.INITIAL);
    assert.ok(text.includes('most recent message'));
    assert.ok(text.includes('older message'));
    assert.ok(text.includes('a tall knight'));
}

// WorldInfoBuffer: scanDepth override and recursion buffer
{
    const buffer = new WorldInfoBuffer(['msg0'], {}, { depth: 1 });
    buffer.addRecurse('injected from recursion');
    const text = buffer.get({}, scan_state.RECURSION);
    assert.ok(text.includes('injected from recursion'));
    assert.equal(buffer.hasRecurse(), true);
}

// matchesEntryKeys: primary only
{
    const buffer = new WorldInfoBuffer(['the dragon appears'], {}, { depth: 1 });
    const text = buffer.get({}, scan_state.INITIAL);
    assert.equal(matchesEntryKeys(text, { key: ['dragon'] }, buffer), true);
    assert.equal(matchesEntryKeys(text, { key: ['griffin'] }, buffer), false);
    assert.equal(matchesEntryKeys(text, { key: [] }, buffer), false, 'no keys defined never activates');
}

// matchesEntryKeys: secondary AND_ANY (default)
{
    const buffer = new WorldInfoBuffer(['the dragon breathes fire'], {}, { depth: 1 });
    const text = buffer.get({}, scan_state.INITIAL);
    const entry = { key: ['dragon'], selective: true, keysecondary: ['fire', 'ice'], selectiveLogic: world_info_logic.AND_ANY };
    assert.equal(matchesEntryKeys(text, entry, buffer), true, 'AND_ANY: fire matches');
    const entryNoMatch = { key: ['dragon'], selective: true, keysecondary: ['ice', 'water'], selectiveLogic: world_info_logic.AND_ANY };
    assert.equal(matchesEntryKeys(text, entryNoMatch, buffer), false);
}

// matchesEntryKeys: secondary AND_ALL
{
    const buffer = new WorldInfoBuffer(['the dragon breathes fire and smoke'], {}, { depth: 1 });
    const text = buffer.get({}, scan_state.INITIAL);
    const entryAll = { key: ['dragon'], selective: true, keysecondary: ['fire', 'smoke'], selectiveLogic: world_info_logic.AND_ALL };
    assert.equal(matchesEntryKeys(text, entryAll, buffer), true);
    const entryPartial = { key: ['dragon'], selective: true, keysecondary: ['fire', 'ice'], selectiveLogic: world_info_logic.AND_ALL };
    assert.equal(matchesEntryKeys(text, entryPartial, buffer), false);
}

// matchesEntryKeys: NOT_ANY / NOT_ALL
{
    const buffer = new WorldInfoBuffer(['the dragon sleeps peacefully'], {}, { depth: 1 });
    const text = buffer.get({}, scan_state.INITIAL);
    const notAny = { key: ['dragon'], selective: true, keysecondary: ['fire', 'ice'], selectiveLogic: world_info_logic.NOT_ANY };
    assert.equal(matchesEntryKeys(text, notAny, buffer), true, 'neither secondary word present');
    const notAll = { key: ['dragon'], selective: true, keysecondary: ['sleeps', 'ice'], selectiveLogic: world_info_logic.NOT_ALL };
    assert.equal(matchesEntryKeys(text, notAll, buffer), true, 'not all secondary words present (ice is missing)');
}

// WorldInfoBuffer#getExternallyActivated: keyed by `${world}.${uid}`, returns the stored (possibly
// different-reference) entry object, or undefined if not force-activated.
{
    const forced = { uid: '1', world: 'w', content: 'forced' };
    const buffer = new WorldInfoBuffer(['irrelevant'], {}, {}, new Map([['w.1', forced]]));
    assert.equal(buffer.getExternallyActivated({ uid: '1', world: 'w' }), forced);
    assert.equal(buffer.getExternallyActivated({ uid: '2', world: 'w' }), undefined);
}

// Default (no externalActivations given) - nothing is ever force-activated
{
    const buffer = new WorldInfoBuffer(['irrelevant'], {}, {});
    assert.equal(buffer.getExternallyActivated({ uid: '1', world: 'w' }), undefined);
}

console.log('key-matching.test.js: all assertions passed');
