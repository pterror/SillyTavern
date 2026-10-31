import assert from 'node:assert/strict';
import { WorldInfoTimedEffects } from './timed-effects.js';

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

{
    const chat = ['a', 'b', 'c'];
    const entry = { world: 'w', uid: '1', hash: 111, sticky: 3 };
    const chatMetadata = { timedWorldInfo: { sticky: { 'w.1': { hash: 111, start: 1, end: 5, protected: false } }, cooldown: {} } };
    const effects = new WorldInfoTimedEffects(chat, [entry], chatMetadata);

    assert.equal(effects.isEffectActive('sticky', entry), false, 'not active until checkTimedEffects() runs');
    effects.checkTimedEffects();
    assert.equal(effects.isEffectActive('sticky', entry), true, 'active - chat.length (3) is within [start=1, end=5)');
}

{
    const chat = ['a', 'b', 'c', 'd', 'e'];
    const entry = { world: 'w', uid: '1', hash: 111, sticky: 3, cooldown: 2 };
    const chatMetadata = { timedWorldInfo: { sticky: { 'w.1': { hash: 111, start: 1, end: 5, protected: false } }, cooldown: {} } };
    const effects = new WorldInfoTimedEffects(chat, [entry], chatMetadata);
    effects.checkTimedEffects();

    assert.equal(chatMetadata.timedWorldInfo.sticky['w.1'], undefined, 'expired sticky entry removed from metadata');
    assert.equal(effects.isEffectActive('sticky', entry), false);
    assert.equal(effects.isEffectActive('cooldown', entry), true, 'ending sticky with a cooldown value immediately starts cooldown');
    assert.ok(chatMetadata.timedWorldInfo.cooldown['w.1'], 'cooldown recorded in metadata too');
}

{
    const chat = ['a'];
    const entry = { world: 'w', uid: '1', hash: 111, sticky: 3 };
    const chatMetadata = { timedWorldInfo: { sticky: { 'w.1': { hash: 111, start: 1, end: 4, protected: false } }, cooldown: {} } };
    const effects = new WorldInfoTimedEffects(chat, [entry], chatMetadata);
    effects.checkTimedEffects();
    assert.equal(chatMetadata.timedWorldInfo.sticky['w.1'], undefined, 'removed - chat.length <= start and not protected');
}

{
    const chat = ['a'];
    const entry = { world: 'w', uid: '1', hash: 111, sticky: 3 };
    const chatMetadata = { timedWorldInfo: { sticky: { 'w.1': { hash: 111, start: 1, end: 4, protected: true } }, cooldown: {} } };
    const effects = new WorldInfoTimedEffects(chat, [entry], chatMetadata);
    effects.checkTimedEffects();
    assert.ok(chatMetadata.timedWorldInfo.sticky['w.1'], 'protected effect survives');
}

{
    const chat = ['a', 'b'];
    const entry = { world: 'w', uid: '1', hash: 111, delay: 5 };
    const chatMetadata = {};
    const effects = new WorldInfoTimedEffects(chat, [entry], chatMetadata);
    effects.checkTimedEffects();
    assert.equal(effects.isEffectActive('delay', entry), true, 'chat.length (2) < delay (5)');
    assert.deepEqual(chatMetadata.timedWorldInfo, { sticky: {}, cooldown: {} });
}

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

{
    const effects = new WorldInfoTimedEffects([], [], {});
    assert.equal(effects.isValidEffectType('sticky'), true);
    assert.equal(effects.isValidEffectType('COOLDOWN'), true);
    assert.equal(effects.isValidEffectType('nonsense'), false);
}

console.log('timed-effects.test.js: all assertions passed');
