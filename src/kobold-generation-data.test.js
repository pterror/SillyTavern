import assert from 'node:assert/strict';
import { createKoboldGenerationData } from './kobold-generation-data.js';

function baseArgs(overrides = {}) {
    return {
        finalPrompt: 'Hello world',
        settings: { sampler_order: [1, 2, 3] },
        maxLength: 100,
        maxContextLength: 2048,
        isHorde: false,
        type: 'normal',
        koboldSettings: {
            rep_pen: 1.1,
            rep_pen_range: 320,
            rep_pen_slope: 0.9,
            temp: 0.8,
            tfs: 1,
            top_a: 0,
            top_k: 0,
            top_p: 0.9,
            min_p: 0.05,
            typical: 1,
            mirostat: 2,
            mirostat_tau: 5,
            mirostat_eta: 0.1,
            use_default_badwordsids: true,
            grammar: '',
            seed: -1,
            streaming_kobold: false,
        },
        koboldFlags: {
            can_use_min_p: true,
            can_use_stop_sequence: true,
            can_use_streaming: true,
            can_use_mirostat: true,
            can_use_default_badwordsids: true,
            can_use_grammar: true,
        },
        apiServer: 'http://localhost:5000/api',
        stoppingStringsParams: { instructPreset: {} },
        macroContext: {},
        ...overrides,
    };
}

// --- basic shape ---
{
    const data = createKoboldGenerationData(baseArgs());
    assert.equal(data.prompt, 'Hello world');
    assert.equal(data.gui_settings, false);
    assert.equal(data.max_context_length, 2048);
    assert.equal(data.max_length, 100);
    assert.equal(data.api_server, 'http://localhost:5000/api');
    assert.equal(data.use_world_info, false);
    assert.equal(data.singleline, false);
    console.log('ok - basic shape');
}

// --- sampler_order fallback ---
{
    const withOwn = createKoboldGenerationData(baseArgs({
        koboldSettings: { ...baseArgs().koboldSettings, sampler_order: [6, 0, 1, 3, 4, 2, 5] },
    }));
    assert.deepEqual(withOwn.sampler_order, [6, 0, 1, 3, 4, 2, 5]);

    const withoutOwn = createKoboldGenerationData(baseArgs({
        koboldSettings: { ...baseArgs().koboldSettings, sampler_order: undefined },
        settings: { sampler_order: [1, 2, 3] },
    }));
    assert.deepEqual(withoutOwn.sampler_order, [1, 2, 3]);
    console.log('ok - sampler_order fallback');
}

// --- sampler_seed ---
{
    const negSeed = createKoboldGenerationData(baseArgs({
        koboldSettings: { ...baseArgs().koboldSettings, seed: -1 },
    }));
    assert.equal(negSeed.sampler_seed, undefined);

    const posSeed = createKoboldGenerationData(baseArgs({
        koboldSettings: { ...baseArgs().koboldSettings, seed: 42 },
    }));
    assert.equal(posSeed.sampler_seed, 42);

    const zeroSeed = createKoboldGenerationData(baseArgs({
        koboldSettings: { ...baseArgs().koboldSettings, seed: 0 },
    }));
    assert.equal(zeroSeed.sampler_seed, 0);
    console.log('ok - sampler_seed');
}

// --- min_p capability gate ---
{
    const on = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_min_p: true },
    }));
    assert.equal(on.min_p, 0.05);

    const off = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_min_p: false },
        isHorde: false,
    }));
    assert.equal(off.min_p, undefined);

    const offButHorde = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_min_p: false },
        isHorde: true,
    }));
    assert.equal(offButHorde.min_p, 0.05);
    console.log('ok - min_p gate');
}

// --- stop_sequence capability gate + real getStoppingStrings invocation ---
{
    const on = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_stop_sequence: true },
        stoppingStringsParams: {
            instructPreset: {},
            namesAsStopStrings: true,
            name1: 'User',
            name2: 'Char',
        },
    }));
    assert.ok(Array.isArray(on.stop_sequence));
    assert.ok(on.stop_sequence.includes('\nUser:'));

    const off = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_stop_sequence: false },
        isHorde: false,
    }));
    assert.equal(off.stop_sequence, undefined);

    const offButHorde = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_stop_sequence: false },
        isHorde: true,
        stoppingStringsParams: {
            instructPreset: {},
            namesAsStopStrings: true,
            name1: 'User',
            name2: 'Char',
        },
    }));
    assert.ok(Array.isArray(offButHorde.stop_sequence));
    assert.ok(offButHorde.stop_sequence.includes('\nUser:'));
    console.log('ok - stop_sequence gate + real getStoppingStrings');
}

// --- stop_sequence isImpersonate/isContinue derivation from type ---
{
    const impersonate = createKoboldGenerationData(baseArgs({
        type: 'impersonate',
        stoppingStringsParams: { instructPreset: {}, namesAsStopStrings: true, name1: 'User', name2: 'Char' },
    }));
    // When impersonating, the char-string is pushed first instead of the user-string.
    assert.ok(impersonate.stop_sequence.includes('\nChar:'));
    console.log('ok - stop_sequence derives isImpersonate from type');
}

// --- streaming: requires all three gates independently ---
{
    const allOn = createKoboldGenerationData(baseArgs({
        koboldSettings: { ...baseArgs().koboldSettings, streaming_kobold: true },
        koboldFlags: { ...baseArgs().koboldFlags, can_use_streaming: true },
        type: 'normal',
    }));
    assert.equal(allOn.streaming, true);

    const streamingKoboldOff = createKoboldGenerationData(baseArgs({
        koboldSettings: { ...baseArgs().koboldSettings, streaming_kobold: false },
        koboldFlags: { ...baseArgs().koboldFlags, can_use_streaming: true },
        type: 'normal',
    }));
    assert.ok(!streamingKoboldOff.streaming);

    const canUseStreamingOff = createKoboldGenerationData(baseArgs({
        koboldSettings: { ...baseArgs().koboldSettings, streaming_kobold: true },
        koboldFlags: { ...baseArgs().koboldFlags, can_use_streaming: false },
        type: 'normal',
    }));
    assert.ok(!canUseStreamingOff.streaming);

    const quietType = createKoboldGenerationData(baseArgs({
        koboldSettings: { ...baseArgs().koboldSettings, streaming_kobold: true },
        koboldFlags: { ...baseArgs().koboldFlags, can_use_streaming: true },
        type: 'quiet',
    }));
    assert.ok(!quietType.streaming);
    console.log('ok - streaming requires all three gates');
}

// --- can_abort mirrors can_use_streaming ---
{
    const on = createKoboldGenerationData(baseArgs({ koboldFlags: { ...baseArgs().koboldFlags, can_use_streaming: true } }));
    assert.equal(on.can_abort, true);
    const off = createKoboldGenerationData(baseArgs({ koboldFlags: { ...baseArgs().koboldFlags, can_use_streaming: false } }));
    assert.equal(off.can_abort, false);
    console.log('ok - can_abort');
}

// --- mirostat capability gate ---
{
    const on = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_mirostat: true },
    }));
    assert.equal(on.mirostat, 2);
    assert.equal(on.mirostat_tau, 5);
    assert.equal(on.mirostat_eta, 0.1);

    const off = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_mirostat: false },
        isHorde: false,
    }));
    assert.equal(off.mirostat, undefined);
    assert.equal(off.mirostat_tau, undefined);
    assert.equal(off.mirostat_eta, undefined);

    const offButHorde = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_mirostat: false },
        isHorde: true,
    }));
    assert.equal(offButHorde.mirostat, 2);
    assert.equal(offButHorde.mirostat_tau, 5);
    assert.equal(offButHorde.mirostat_eta, 0.1);
    console.log('ok - mirostat gate');
}

// --- use_default_badwordsids capability gate ---
{
    const on = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_default_badwordsids: true },
    }));
    assert.equal(on.use_default_badwordsids, true);

    const off = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_default_badwordsids: false },
        isHorde: false,
    }));
    assert.equal(off.use_default_badwordsids, undefined);

    const offButHorde = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_default_badwordsids: false },
        isHorde: true,
    }));
    assert.equal(offButHorde.use_default_badwordsids, true);
    console.log('ok - use_default_badwordsids gate');
}

// --- grammar capability gate + real substituteParams invocation ---
{
    const on = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_grammar: true },
        koboldSettings: { ...baseArgs().koboldSettings, grammar: 'root ::= "{{char}}"' },
        macroContext: { name2: 'Assistant' },
    }));
    assert.equal(on.grammar, 'root ::= "Assistant"');

    const off = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_grammar: false },
        koboldSettings: { ...baseArgs().koboldSettings, grammar: 'root ::= "{{char}}"' },
        isHorde: false,
    }));
    assert.equal(off.grammar, undefined);

    const offButHorde = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_grammar: false },
        koboldSettings: { ...baseArgs().koboldSettings, grammar: 'root ::= "{{char}}"' },
        isHorde: true,
        macroContext: { name2: 'Assistant' },
    }));
    assert.equal(offButHorde.grammar, 'root ::= "Assistant"');
    console.log('ok - grammar gate + real substituteParams');
}

// --- grammar_retain_state: AND of can_use_grammar and isContinue, not either alone ---
{
    const bothTrue = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_grammar: true },
        type: 'continue',
    }));
    assert.equal(bothTrue.grammar_retain_state, true);

    const onlyGrammar = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_grammar: true },
        type: 'normal',
    }));
    assert.equal(onlyGrammar.grammar_retain_state, undefined);

    const onlyContinue = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_grammar: false },
        type: 'continue',
    }));
    assert.equal(onlyContinue.grammar_retain_state, undefined);

    // isHorde does NOT force-enable grammar_retain_state (client never checks isHorde here).
    const hordeOnlyContinue = createKoboldGenerationData(baseArgs({
        koboldFlags: { ...baseArgs().koboldFlags, can_use_grammar: false },
        type: 'continue',
        isHorde: true,
    }));
    assert.equal(hordeOnlyContinue.grammar_retain_state, undefined);
    console.log('ok - grammar_retain_state AND gate');
}

console.log('All kobold-generation-data tests passed.');
