import assert from 'node:assert/strict';
import { WorldInfoTimedEffects } from './timed-effects.js';

// setTimedEffects() records a sticky effect for an activated entry with a `sticky` field
{
    const chat = ['a', 'b'];
    const entry = { world: 'w', uid: '1', hash: 111, sticky: 3 };
    const chatMetadata = {};
    const effects = new WorldInfoTimedEffects(chat, [entry], chatMetadata);
    effects.setTimedEffects([entry]);

    const meta = effects.getEffectMetadata('sticky', entry);
    assert.equal(meta.start, 2);
    assert.equal(meta.end, 5, 'end = chat.length + sticky duration');
    assert.equal(meta.protected, false);
}

// isEffectActive reflects checkTimedEffects()'s buffer, not just whatever's in metadata
{
    const chat = ['a', 'b', 'c'];
    const entry = { world: 'w', uid: '1', hash: 111, sticky: 3 };
    const chatMetadata = { timedWorldInfo: { sticky: { 'w.1': { hash: 111, start: 1, end: 5, protected: false } }, cooldown: {} } };
    const effects = new WorldInfoTimedEffects(chat, [entry], chatMetadata);

    assert.equal(effects.isEffectActive('sticky', entry), false, 'not active until checkTimedEffects() runs');
    effects.checkTimedEffects();
    assert.equal(effects.isEffectActive('sticky', entry), true, 'active - chat.length (3) is within [start=1, end=5)');
}

// A sticky effect that has expired (chat.length >= end) is removed and triggers the cooldown handoff
{
    const chat = ['a', 'b', 'c', 'd', 'e']; // length 5, matches end
    const entry = { world: 'w', uid: '1', hash: 111, sticky: 3, cooldown: 2 };
    const chatMetadata = { timedWorldInfo: { sticky: { 'w.1': { hash: 111, start: 1, end: 5, protected: false } }, cooldown: {} } };
    const effects = new WorldInfoTimedEffects(chat, [entry], chatMetadata);
    effects.checkTimedEffects();

    assert.equal(chatMetadata.timedWorldInfo.sticky['w.1'], undefined, 'expired sticky entry removed from metadata');
    assert.equal(effects.isEffectActive('sticky', entry), false);
    assert.equal(effects.isEffectActive('cooldown', entry), true, 'ending sticky with a cooldown value immediately starts cooldown');
    assert.ok(chatMetadata.timedWorldInfo.cooldown['w.1'], 'cooldown recorded in metadata too');
}

// An effect is removed if the chat hasn't advanced past its start, unless protected
{
    const chat = ['a']; // length 1, same as start
    const entry = { world: 'w', uid: '1', hash: 111, sticky: 3 };
    const chatMetadata = { timedWorldInfo: { sticky: { 'w.1': { hash: 111, start: 1, end: 4, protected: false } }, cooldown: {} } };
    const effects = new WorldInfoTimedEffects(chat, [entry], chatMetadata);
    effects.checkTimedEffects();
    assert.equal(chatMetadata.timedWorldInfo.sticky['w.1'], undefined, 'removed - chat.length <= start and not protected');
}

// ...but a protected effect survives even when chat.length <= start
{
    const chat = ['a'];
    const entry = { world: 'w', uid: '1', hash: 111, sticky: 3 };
    const chatMetadata = { timedWorldInfo: { sticky: { 'w.1': { hash: 111, start: 1, end: 4, protected: true } }, cooldown: {} } };
    const effects = new WorldInfoTimedEffects(chat, [entry], chatMetadata);
    effects.checkTimedEffects();
    assert.ok(chatMetadata.timedWorldInfo.sticky['w.1'], 'protected effect survives');
}

// Delay effect: computed fresh each check, not persisted to chatMetadata
{
    const chat = ['a', 'b'];
    const entry = { world: 'w', uid: '1', hash: 111, delay: 5 };
    const chatMetadata = {};
    const effects = new WorldInfoTimedEffects(chat, [entry], chatMetadata);
    effects.checkTimedEffects();
    assert.equal(effects.isEffectActive('delay', entry), true, 'chat.length (2) < delay (5)');
    // The constructor always initializes timedWorldInfo.sticky/cooldown (even with no sticky/cooldown
    // entries in play) - delay itself just never populates them further.
    assert.deepEqual(chatMetadata.timedWorldInfo, { sticky: {}, cooldown: {} });
}

// Dry run: sticky/cooldown are never checked or set; delay still is
{
    const chat = ['a'];
    const stickyEntry = { world: 'w', uid: '1', hash: 111, sticky: 3 };
    const delayEntry = { world: 'w', uid: '2', hash: 222, delay: 5 };
    const chatMetadata = {};
    const effects = new WorldInfoTimedEffects(chat, [stickyEntry, delayEntry], chatMetadata, true);
    effects.setTimedEffects([stickyEntry]);
    assert.equal(effects.getEffectMetadata('sticky', stickyEntry), undefined, 'dry run never sets sticky');

    effects.checkTimedEffects();
    assert.equal(effects.isEffectActive('delay', delayEntry), true, 'delay still evaluated on a dry run');
}

// setTimedEffect: manual force-set/clear
{
    const chat = ['a', 'b'];
    const entry = { world: 'w', uid: '1', hash: 111, sticky: 3 };
    const chatMetadata = {};
    const effects = new WorldInfoTimedEffects(chat, [entry], chatMetadata);

    effects.setTimedEffect('sticky', entry, true);
    assert.ok(effects.getEffectMetadata('sticky', entry));

    effects.setTimedEffect('sticky', entry, false);
    assert.equal(effects.getEffectMetadata('sticky', entry), undefined);
}

// isValidEffectType
{
    const effects = new WorldInfoTimedEffects([], [], {});
    assert.equal(effects.isValidEffectType('sticky'), true);
    assert.equal(effects.isValidEffectType('COOLDOWN'), true);
    assert.equal(effects.isValidEffectType('nonsense'), false);
}

console.log('timed-effects.test.js: all assertions passed');
