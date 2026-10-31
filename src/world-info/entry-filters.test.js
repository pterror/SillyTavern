import assert from 'node:assert/strict';
import { passesEntryFilters } from './entry-filters.js';

assert.equal(passesEntryFilters({}), true);

{
    const entry = { triggers: ['normal', 'impersonate'] };
    assert.equal(passesEntryFilters(entry, { trigger: 'normal' }), true);
    assert.equal(passesEntryFilters(entry, { trigger: 'quiet' }), false);
    assert.equal(passesEntryFilters(entry, {}), false, 'no trigger given, entry requires one of a specific set');
}

{
    const entry = { characterFilter: { names: ['alice.png'], isExclude: false } };
    assert.equal(passesEntryFilters(entry, { characterFilename: 'alice.png' }), true);
    assert.equal(passesEntryFilters(entry, { characterFilename: 'bob.png' }), false);
}

{
    const entry = { characterFilter: { names: ['alice.png'], isExclude: true } };
    assert.equal(passesEntryFilters(entry, { characterFilename: 'alice.png' }), false, 'excluded character is filtered out');
    assert.equal(passesEntryFilters(entry, { characterFilename: 'bob.png' }), true, 'non-excluded character passes');
}

{
    const entry = { characterFilter: { tags: ['npc'], isExclude: false } };
    assert.equal(passesEntryFilters(entry, { characterTags: ['npc', 'friendly'] }), true);
    assert.equal(passesEntryFilters(entry, { characterTags: ['friendly'] }), false);
    assert.equal(passesEntryFilters(entry, {}), false, 'no known tags, inclusion mode filters out');
}

{
    const entry = { characterFilter: { tags: ['npc'], isExclude: true } };
    assert.equal(passesEntryFilters(entry, { characterTags: ['npc'] }), false, 'has the excluded tag');
    assert.equal(passesEntryFilters(entry, { characterTags: ['friendly'] }), true, 'doesn\'t have the excluded tag');
}

{
    const entry = { characterFilter: { names: ['alice.png'], tags: ['npc'], isExclude: false } };
    assert.equal(passesEntryFilters(entry, { characterFilename: 'alice.png', characterTags: ['npc'] }), true);
    assert.equal(passesEntryFilters(entry, { characterFilename: 'alice.png', characterTags: ['friendly'] }), false, 'fails tag filter despite passing name filter');
}

console.log('entry-filters.test.js: all assertions passed');
