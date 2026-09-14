import assert from 'node:assert';
import { preparePromptsForChatCompletion } from './chat-completion-prepare-prompts.js';
import { PromptCollection } from './chat-completion-prompt-collection.js';

function baseFixture() {
    /** @type {import('./chat-completion-prompt-collection.js').RawPrompt[]} */
    const prompts = [
        { identifier: 'worldInfoBefore', role: 'system', content: 'unused-raw-content', injection_depth: 7 },
        { identifier: 'main', role: 'system', content: 'Default main content', forbid_overrides: false },
        { identifier: 'jailbreak', role: 'system', content: 'Default jailbreak content', forbid_overrides: false },
    ];

    /** @type {import('./chat-completion-prompt-collection.js').PromptOrderList[]} */
    const promptOrder = [
        {
            character_id: 1,
            order: [
                { identifier: 'worldInfoBefore', enabled: true },
                { identifier: 'main', enabled: true },
                { identifier: 'jailbreak', enabled: true },
            ],
        },
    ];

    return { prompts, promptOrder };
}

// (a), (b), (c), (d): combined happy-path merge + both overrides applying.
{
    const { prompts, promptOrder } = baseFixture();

    const result = preparePromptsForChatCompletion({
        worldInfoBefore: 'before text',
        systemPromptOverride: 'OVERRIDE MAIN CONTENT',
        jailbreakPromptOverride: 'OVERRIDE JAILBREAK CONTENT',
        type: 'normal',
        prompts,
        promptOrder,
        characterId: 1,
        groupMemberNames: [],
    });

    assert.ok(result instanceof PromptCollection, 'result should be a real PromptCollection instance');

    // (a) worldInfoBefore is in the user's order with injection_depth: 7 - the merge loop must pick
    // that up as an override onto the systemPrompts-built entry (which has no injection_depth of its own).
    const wib = result.get('worldInfoBefore');
    assert.ok(wib, 'worldInfoBefore should be present');
    assert.strictEqual(wib.injection_depth, 7, 'worldInfoBefore should inherit injection_depth from the user-configured prompt-manager entry');
    assert.strictEqual(wib.content, 'before text', 'worldInfoBefore content should come from the system-prompts build (no wiFormat configured)');

    // (b) groupNudge is not present anywhere in promptOrder - should be added fresh with no override
    // (injection_depth stays undefined, matching the systemPrompts-array entry's own default).
    assert.ok(result.has('groupNudge'), 'groupNudge should be added fresh even though it is unordered');
    const groupNudge = result.get('groupNudge');
    assert.strictEqual(groupNudge.injection_depth, undefined, 'groupNudge should have no injection_depth override applied');

    // (c) main: enabled, not forbidden, override supplied -> content replaced, recorded in overriddenPrompts.
    const main = result.get('main');
    assert.ok(main, 'main should be present');
    assert.strictEqual(main.content, 'OVERRIDE MAIN CONTENT', 'main content should be replaced by systemPromptOverride');
    assert.ok(result.overriddenPrompts.includes('main'), 'overriddenPrompts should include main');

    // (d) jailbreak: same as (c) but for the jailbreak override.
    const jailbreak = result.get('jailbreak');
    assert.ok(jailbreak, 'jailbreak should be present');
    assert.strictEqual(jailbreak.content, 'OVERRIDE JAILBREAK CONTENT', 'jailbreak content should be replaced by jailbreakPromptOverride');
    assert.ok(result.overriddenPrompts.includes('jailbreak'), 'overriddenPrompts should include jailbreak');

    // (g) sanity: other expected identifiers from the systemPrompts build are present too.
    for (const identifier of ['worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'impersonate', 'quietPrompt', 'bias']) {
        assert.ok(result.has(identifier), `expected identifier "${identifier}" to be present in the final collection`);
    }

    console.log('PASS: merge + overrides happy path (a, b, c, d, g)');
}

// (e): forbid_overrides: true on main should skip the override entirely.
{
    const { prompts, promptOrder } = baseFixture();
    const mainDef = prompts.find(p => p.identifier === 'main');
    mainDef.forbid_overrides = true;

    const result = preparePromptsForChatCompletion({
        systemPromptOverride: 'SHOULD NOT APPEAR',
        type: 'normal',
        prompts,
        promptOrder,
        characterId: 1,
        groupMemberNames: [],
    });

    const main = result.get('main');
    assert.ok(main, 'main should still be present');
    assert.notStrictEqual(main.content, 'SHOULD NOT APPEAR', 'override should be skipped when forbid_overrides is true');
    assert.strictEqual(main.content, 'Default main content', 'main should keep its original prepared content');
    assert.ok(!result.overriddenPrompts.includes('main'), 'overriddenPrompts should NOT include main when the override was skipped');

    console.log('PASS: forbid_overrides skip (e)');
}

// (f): main disabled for this character (promptOrder enabled: false) should skip the override, even
// though getPromptCollection()'s own "main" special case still keeps a blank-content main in the
// collection (so this exercises the isPromptDisabledForCharacter() guard specifically, not mere absence).
{
    const { prompts, promptOrder } = baseFixture();
    const mainOrderEntry = promptOrder[0].order.find(e => e.identifier === 'main');
    mainOrderEntry.enabled = false;

    const result = preparePromptsForChatCompletion({
        systemPromptOverride: 'SHOULD NOT APPEAR EITHER',
        type: 'normal',
        prompts,
        promptOrder,
        characterId: 1,
        groupMemberNames: [],
    });

    const main = result.get('main');
    assert.ok(main, 'main should still be present via getPromptCollection\'s blank-fallback for a disabled "main" order entry');
    assert.notStrictEqual(main.content, 'SHOULD NOT APPEAR EITHER', 'override should be skipped when the prompt is disabled for the character');
    assert.strictEqual(main.content, '', 'disabled main should keep the blank-fallback content produced by getPromptCollection');
    assert.ok(!result.overriddenPrompts.includes('main'), 'overriddenPrompts should NOT include main when disabled');

    console.log('PASS: disabled-for-character skip (f)');
}

console.log('All chat-completion-prepare-prompts tests passed.');
