import assert from 'node:assert/strict';
import {
    INJECTION_POSITION,
    Prompt,
    PromptCollection,
    getPromptOrderForCharacter,
    getPromptById,
    getPromptOrderEntry,
    isPromptDisabledForCharacter,
    shouldTrigger,
    preparePrompt,
    getPromptCollection,
} from './chat-completion-prompt-collection.js';

// --- INJECTION_POSITION enum -------------------------------------------------
{
    assert.deepEqual(INJECTION_POSITION, { RELATIVE: 0, ABSOLUTE: 1 });
}

// --- Prompt constructor: marker is not a field, defaults apply --------------
{
    const prompt = new Prompt({ identifier: 'main', role: 'system', content: 'hi', marker: true });
    assert.equal(prompt.identifier, 'main');
    assert.equal(prompt.content, 'hi');
    assert.equal(prompt.extension, false);
    assert.equal(prompt.injection_order, 100);
    assert.deepEqual(prompt.injection_trigger, []);
    // marker was passed in the raw object but the class never assigns it - confirms it's dead.
    assert.equal('marker' in prompt, false);
}
{
    const prompt = new Prompt({ identifier: 'x', extension: true, injection_order: 5, injection_trigger: ['continue'] });
    assert.equal(prompt.extension, true);
    assert.equal(prompt.injection_order, 5);
    assert.deepEqual(prompt.injection_trigger, ['continue']);
}

// --- PromptCollection: add/get/index/has -------------------------------------
{
    const p1 = new Prompt({ identifier: 'a' });
    const p2 = new Prompt({ identifier: 'b' });
    const collection = new PromptCollection(p1);
    collection.add(p2);

    assert.deepEqual(collection.collection, [p1, p2]);
    assert.equal(collection.get('a'), p1);
    assert.equal(collection.get('b'), p2);
    assert.equal(collection.get('missing'), undefined);
    assert.equal(collection.index('b'), 1);
    assert.equal(collection.index('missing'), -1);
    assert.equal(collection.has('a'), true);
    assert.equal(collection.has('missing'), false);
}

// --- PromptCollection.add: type validation throw, exact message -------------
{
    const collection = new PromptCollection();
    assert.throws(
        () => collection.add({ identifier: 'not-a-prompt-instance' }),
        (err) => err instanceof Error && err.message === 'Only Prompt instances can be added to PromptCollection',
    );
}

// --- PromptCollection.set: direct index assignment ---------------------------
{
    const p1 = new Prompt({ identifier: 'a' });
    const p2 = new Prompt({ identifier: 'b' });
    const collection = new PromptCollection(p1);
    collection.set(p2, 0);
    assert.equal(collection.collection[0], p2);
    assert.equal(collection.collection.length, 1);

    assert.throws(() => collection.set({ identifier: 'nope' }, 0));
}

// --- PromptCollection.override: set() + overriddenPrompts side effect -------
{
    const p1 = new Prompt({ identifier: 'a', content: 'orig' });
    const p2 = new Prompt({ identifier: 'a', content: 'override' });
    const collection = new PromptCollection(p1);
    collection.override(p2, 0);

    assert.equal(collection.collection[0], p2);
    assert.deepEqual(collection.overriddenPrompts, ['a']);
}

// --- getPromptOrderForCharacter: string-vs-numeric id coercion --------------
{
    // numeric characterId param matched against a string character_id in the fixture.
    const promptOrder = [{ character_id: '100000', order: [{ identifier: 'main', enabled: true }] }];
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, 100000), [{ identifier: 'main', enabled: true }]);
}
{
    // string characterId param matched against a numeric character_id in the fixture.
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }];
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, '100000'), [{ identifier: 'main', enabled: true }]);
}
{
    // no character -> [].
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }];
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, null), []);
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, undefined), []);
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, 0), []);
}
{
    // no matching entry -> [].
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }];
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, 999), []);
}
{
    // matching entry with no `order` key -> [].
    const promptOrder = [{ character_id: 100000 }];
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, 100000), []);
}

// --- getPromptById: found/not-found ------------------------------------------
{
    const prompts = [{ identifier: 'main', content: 'a' }, { identifier: 'nsfw', content: 'b' }];
    assert.deepEqual(getPromptById(prompts, 'nsfw'), { identifier: 'nsfw', content: 'b' });
    assert.equal(getPromptById(prompts, 'missing'), null);
}

// --- getPromptOrderEntry -----------------------------------------------------
{
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'main', enabled: false }] }];
    assert.deepEqual(getPromptOrderEntry(promptOrder, 100000, 'main'), { identifier: 'main', enabled: false });
    assert.equal(getPromptOrderEntry(promptOrder, 100000, 'missing'), null);
    assert.equal(getPromptOrderEntry(promptOrder, 'no-such-character', 'main'), null);
}

// --- isPromptDisabledForCharacter: three states ------------------------------
{
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'jailbreak', enabled: false }] }];
    // no order entry at all for this identifier.
    assert.equal(isPromptDisabledForCharacter(promptOrder, 100000, 'nsfw'), false);
    // entry with enabled: true.
    assert.equal(isPromptDisabledForCharacter(promptOrder, 100000, 'main'), false);
    // entry with enabled: false.
    assert.equal(isPromptDisabledForCharacter(promptOrder, 100000, 'jailbreak'), true);
}

// --- shouldTrigger: three states ---------------------------------------------
{
    // no injection_trigger array at all.
    assert.equal(shouldTrigger({ identifier: 'x' }, 'normal'), true);
    assert.equal(shouldTrigger(undefined, 'normal'), true);
    // empty array.
    assert.equal(shouldTrigger({ injection_trigger: [] }, 'normal'), true);
    // non-empty array, with match.
    assert.equal(shouldTrigger({ injection_trigger: ['continue', 'swipe'] }, 'continue'), true);
    // non-empty array, without match.
    assert.equal(shouldTrigger({ injection_trigger: ['continue', 'swipe'] }, 'normal'), false);
}

// --- preparePrompt: four original/groupMembers branches ----------------------
// {{original}} substitutes once then empties itself; {{group}}/{{charIfNotGroup}} read the `group`
// context override that this port's translation of the client's `groupOverride` maps onto (see the
// module doc comment's JUDGMENT CALL). Both are real macros read directly out of
// src/macro-substitution.js's buildEnvironment()/evaluateMacros().
{
    // branch 1: original is a string, groupMembers non-empty.
    const prompt = { content: 'before [{{original}}] after, group=[{{group}}]' };
    const prepared = preparePrompt(prompt, { original: 'ORIG', groupMemberNames: ['Alice', 'Bob'] });
    assert.equal(prepared.content, 'before [ORIG] after, group=[Alice, Bob]');
    assert.ok(prepared instanceof Prompt);
}
{
    // branch 2: original is a string, no group members.
    const prompt = { content: 'before [{{original}}] after, group=[{{group}}]' };
    const prepared = preparePrompt(prompt, { original: 'ORIG', groupMemberNames: [] });
    // {{group}} falls back to name2 ('' when unset), not the joined member list.
    assert.equal(prepared.content, 'before [ORIG] after, group=[]');
}
{
    // branch 3: no original, groupMembers non-empty.
    const prompt = { content: '[{{original}}] group=[{{group}}]' };
    const prepared = preparePrompt(prompt, { groupMemberNames: ['Alice', 'Bob'] });
    // {{original}} macro isn't even registered when `original` isn't a string, so it's left untouched.
    assert.equal(prepared.content, '[{{original}}] group=[Alice, Bob]');
}
{
    // branch 4: no original, no group members.
    const prompt = { content: '[{{original}}] group=[{{group}}]' };
    const prepared = preparePrompt(prompt, {});
    assert.equal(prepared.content, '[{{original}}] group=[]');
}
{
    // macroContext is merged through in every branch (e.g. name1/name2 for {{user}}/{{char}}).
    const prompt = { content: '{{user}} and {{char}}' };
    const prepared = preparePrompt(prompt, { macroContext: { name1: 'Ellie', name2: 'Bot' } });
    assert.equal(prepared.content, 'Ellie and Bot');
}
{
    // undefined content with no original/group falls back to substituteParams('') behavior.
    const prepared = preparePrompt({ content: undefined }, {});
    assert.equal(prepared.content, '');
}

// --- getPromptCollection: full flow ------------------------------------------
{
    const prompts = [
        { identifier: 'main', content: 'Main content' },
        { identifier: 'jailbreak', content: 'Jailbreak content' },
        { identifier: 'nsfw', content: 'NSFW content', injection_trigger: ['continue'] },
        // 'ghost' intentionally has no matching order entry issue is the reverse: order references
        // an identifier with no prompt definition (tested via 'missing-prompt' below).
    ];
    const promptOrder = [
        {
            character_id: 100000,
            order: [
                { identifier: 'main', enabled: false }, // disabled main -> content-blanked replacement.
                { identifier: 'jailbreak', enabled: true }, // triggered + enabled -> included.
                { identifier: 'nsfw', enabled: true }, // enabled but trigger-mismatched -> excluded.
                { identifier: 'missing-prompt', enabled: true }, // no matching prompt def -> skipped, no crash.
            ],
        },
    ];

    const collection = getPromptCollection({
        prompts,
        promptOrder,
        characterId: 100000,
        generationType: '  NoRmAl  ', // exercises the generationType normalization (mixed-case/whitespace).
    });

    assert.equal(collection.collection.length, 2);

    const mainEntry = collection.get('main');
    assert.ok(mainEntry, 'disabled main prompt should still be present as a content-blanked replacement');
    assert.equal(mainEntry.content, '');

    const jailbreakEntry = collection.get('jailbreak');
    assert.ok(jailbreakEntry, 'enabled + triggered prompt should be included');
    assert.equal(jailbreakEntry.content, 'Jailbreak content');

    assert.equal(collection.has('nsfw'), false, 'trigger-mismatched prompt should be excluded even though enabled');
    assert.equal(collection.has('missing-prompt'), false, 'order entry with no matching prompt definition should be skipped without crashing');
}
{
    // a disabled, non-'main' prompt is excluded outright (no fallback replacement for non-main identifiers).
    const prompts = [{ identifier: 'nsfw', content: 'NSFW content' }];
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'nsfw', enabled: false }] }];
    const collection = getPromptCollection({ prompts, promptOrder, characterId: 100000 });
    assert.equal(collection.collection.length, 0);
}
{
    // generationType defaults to 'normal' when omitted, matching a prompt with an injection_trigger
    // that includes 'normal'.
    const prompts = [{ identifier: 'main', content: 'x', injection_trigger: ['normal'] }];
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }];
    const collection = getPromptCollection({ prompts, promptOrder, characterId: 100000 });
    assert.equal(collection.get('main').content, 'x');
}

console.log('All chat-completion-prompt-collection tests passed.');
