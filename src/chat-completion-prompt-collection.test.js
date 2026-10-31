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

{
    assert.deepEqual(INJECTION_POSITION, { RELATIVE: 0, ABSOLUTE: 1 });
}

{
    const prompt = new Prompt({ identifier: 'main', role: 'system', content: 'hi', marker: true });
    assert.equal(prompt.identifier, 'main');
    assert.equal(prompt.content, 'hi');
    assert.equal(prompt.extension, false);
    assert.equal(prompt.injection_order, 100);
    assert.deepEqual(prompt.injection_trigger, []);
    assert.equal('marker' in prompt, false);
}
{
    const prompt = new Prompt({ identifier: 'x', extension: true, injection_order: 5, injection_trigger: ['continue'] });
    assert.equal(prompt.extension, true);
    assert.equal(prompt.injection_order, 5);
    assert.deepEqual(prompt.injection_trigger, ['continue']);
}

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

{
    const collection = new PromptCollection();
    assert.throws(
        () => collection.add({ identifier: 'not-a-prompt-instance' }),
        (err) => err instanceof Error && err.message === 'Only Prompt instances can be added to PromptCollection',
    );
}

{
    const p1 = new Prompt({ identifier: 'a' });
    const p2 = new Prompt({ identifier: 'b' });
    const collection = new PromptCollection(p1);
    collection.set(p2, 0);
    assert.equal(collection.collection[0], p2);
    assert.equal(collection.collection.length, 1);

    assert.throws(() => collection.set({ identifier: 'nope' }, 0));
}

{
    const p1 = new Prompt({ identifier: 'a', content: 'orig' });
    const p2 = new Prompt({ identifier: 'a', content: 'override' });
    const collection = new PromptCollection(p1);
    collection.override(p2, 0);

    assert.equal(collection.collection[0], p2);
    assert.deepEqual(collection.overriddenPrompts, ['a']);
}

{
    const promptOrder = [{ character_id: '100000', order: [{ identifier: 'main', enabled: true }] }];
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, 100000), [{ identifier: 'main', enabled: true }]);
}
{
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }];
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, '100000'), [{ identifier: 'main', enabled: true }]);
}
{
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }];
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, null), []);
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, undefined), []);
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, 0), []);
}
{
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }];
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, 999), []);
}
{
    const promptOrder = [{ character_id: 100000 }];
    assert.deepEqual(getPromptOrderForCharacter(promptOrder, 100000), []);
}

{
    const prompts = [{ identifier: 'main', content: 'a' }, { identifier: 'nsfw', content: 'b' }];
    assert.deepEqual(getPromptById(prompts, 'nsfw'), { identifier: 'nsfw', content: 'b' });
    assert.equal(getPromptById(prompts, 'missing'), null);
}

{
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'main', enabled: false }] }];
    assert.deepEqual(getPromptOrderEntry(promptOrder, 100000, 'main'), { identifier: 'main', enabled: false });
    assert.equal(getPromptOrderEntry(promptOrder, 100000, 'missing'), null);
    assert.equal(getPromptOrderEntry(promptOrder, 'no-such-character', 'main'), null);
}

{
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'jailbreak', enabled: false }] }];
    assert.equal(isPromptDisabledForCharacter(promptOrder, 100000, 'nsfw'), false);
    assert.equal(isPromptDisabledForCharacter(promptOrder, 100000, 'main'), false);
    assert.equal(isPromptDisabledForCharacter(promptOrder, 100000, 'jailbreak'), true);
}

{
    assert.equal(shouldTrigger({ identifier: 'x' }, 'normal'), true);
    assert.equal(shouldTrigger(undefined, 'normal'), true);
    assert.equal(shouldTrigger({ injection_trigger: [] }, 'normal'), true);
    assert.equal(shouldTrigger({ injection_trigger: ['continue', 'swipe'] }, 'continue'), true);
    assert.equal(shouldTrigger({ injection_trigger: ['continue', 'swipe'] }, 'normal'), false);
}

{
    const prompt = { content: 'before [{{original}}] after, group=[{{group}}]' };
    const prepared = preparePrompt(prompt, { original: 'ORIG', groupMemberNames: ['Alice', 'Bob'] });
    assert.equal(prepared.content, 'before [ORIG] after, group=[Alice, Bob]');
    assert.ok(prepared instanceof Prompt);
}
{
    const prompt = { content: 'before [{{original}}] after, group=[{{group}}]' };
    const prepared = preparePrompt(prompt, { original: 'ORIG', groupMemberNames: [] });
    assert.equal(prepared.content, 'before [ORIG] after, group=[]');
}
{
    const prompt = { content: '[{{original}}] group=[{{group}}]' };
    const prepared = preparePrompt(prompt, { groupMemberNames: ['Alice', 'Bob'] });
    assert.equal(prepared.content, '[] group=[Alice, Bob]');
}
{
    const prompt = { content: '[{{original}}] group=[{{group}}]' };
    const prepared = preparePrompt(prompt, {});
    assert.equal(prepared.content, '[] group=[]');
}
{
    const prompt = { content: '{{user}} and {{char}}' };
    const prepared = preparePrompt(prompt, { macroContext: { name1: 'Ellie', name2: 'Bot' } });
    assert.equal(prepared.content, 'Ellie and Bot');
}
{
    const prepared = preparePrompt({ content: undefined }, {});
    assert.equal(prepared.content, '');
}

{
    const prompts = [
        { identifier: 'main', content: 'Main content' },
        { identifier: 'jailbreak', content: 'Jailbreak content' },
        { identifier: 'nsfw', content: 'NSFW content', injection_trigger: ['continue'] },
    ];
    const promptOrder = [
        {
            character_id: 100000,
            order: [
                { identifier: 'main', enabled: false },
                { identifier: 'jailbreak', enabled: true },
                { identifier: 'nsfw', enabled: true },
                { identifier: 'missing-prompt', enabled: true },
            ],
        },
    ];

    const collection = getPromptCollection({
        prompts,
        promptOrder,
        characterId: 100000,
        generationType: '  NoRmAl  ',
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
    const prompts = [{ identifier: 'nsfw', content: 'NSFW content' }];
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'nsfw', enabled: false }] }];
    const collection = getPromptCollection({ prompts, promptOrder, characterId: 100000 });
    assert.equal(collection.collection.length, 0);
}
{
    const prompts = [{ identifier: 'main', content: 'x', injection_trigger: ['normal'] }];
    const promptOrder = [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }];
    const collection = getPromptCollection({ prompts, promptOrder, characterId: 100000 });
    assert.equal(collection.get('main').content, 'x');
}

console.log('All chat-completion-prompt-collection tests passed.');
