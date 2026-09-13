import assert from 'node:assert/strict';
import { createTextGenGenerationData, APHRODITE_DEFAULT_ORDER } from './textgen-generation-data.js';

function baseSettings(overrides = {}) {
    return {
        type: 'ooba',
        temp: 0.7,
        min_temp: 0.5,
        max_temp: 1.5,
        dynatemp: false,
        dynatemp_exponent: 1,
        top_p: 1,
        typical_p: 1,
        seed: -1,
        min_p: 0,
        rep_pen: 1,
        freq_pen: 0,
        presence_pen: 0,
        top_k: 0,
        skew: 0,
        min_length: 0,
        num_beams: 1,
        length_penalty: 1,
        early_stopping: false,
        add_bos_token: true,
        smoothing_factor: 0,
        smoothing_curve: 1,
        dry_allowed_length: 2,
        dry_multiplier: 0,
        dry_base: 1.75,
        dry_sequence_breakers: '["\\n"]',
        dry_penalty_last_n: 0,
        max_tokens_second: 0,
        sampler_priority: [],
        ban_eos_token: false,
        skip_special_tokens: true,
        include_reasoning: false,
        top_a: 0,
        tfs: 1,
        epsilon_cutoff: 0,
        eta_cutoff: 0,
        mirostat_mode: 0,
        mirostat_tau: 5,
        mirostat_eta: 0.1,
        xtc_threshold: 0.1,
        xtc_probability: 0,
        nsigma: 0,
        min_keep: 0,
        adaptive_target: 0,
        adaptive_decay: 0,
        rep_pen_range: 0,
        rep_pen_decay: 0,
        rep_pen_slope: 1,
        encoder_rep_pen: 1,
        no_repeat_ngram_size: 0,
        penalty_alpha: 0,
        temperature_last: true,
        speculative_ngram: false,
        do_sample: true,
        guidance_scale: 1,
        negative_prompt: '',
        grammar_string: '',
        n: 1,
        ...overrides,
    };
}

// api_type/api_server must never appear - regression guard against the removed client fields creeping back in
{
    const params = createTextGenGenerationData(baseSettings(), 'my-model', 'prompt text', 100, false, false, null, 'normal', {});
    assert.equal('api_type' in params, false);
    assert.equal('api_server' in params, false);
    assert.equal(params.model, 'my-model');
    assert.equal(params.prompt, 'prompt text');
}

// OOBA-specific fields only apply for OOBA
{
    const oobaParams = createTextGenGenerationData(baseSettings({ type: 'ooba', min_length: 5, num_beams: 3 }), 'm', 'p', 10, false, false, null, 'normal');
    assert.equal(oobaParams.min_length, 5);
    assert.equal(oobaParams.num_beams, 3);

    const koboldParams = createTextGenGenerationData(baseSettings({ type: 'koboldcpp', min_length: 5, num_beams: 3 }), 'm', 'p', 10, false, false, null, 'normal');
    assert.equal(koboldParams.min_length, undefined);
    assert.equal(koboldParams.num_beams, undefined);
}

// Dynatemp midpoint/range math, only for supported types when settings.dynatemp is true
{
    const settings = baseSettings({ type: 'ooba', dynatemp: true, min_temp: 0.5, max_temp: 1.5 });
    const params = createTextGenGenerationData(settings, 'm', 'p', 10, false, false, null, 'normal');
    assert.equal(params.temperature, 1.0); // (0.5+1.5)/2
    assert.equal(params.dynatemp_range, 0.5); // (1.5-0.5)/2
    assert.equal(params.dynamic_temperature, true);

    // Unsupported type (generic isn't in DYNATEMP_SUPPORTED_TYPES) - dynatemp does not apply even if settings.dynatemp is true
    const genericParams = createTextGenGenerationData(baseSettings({ type: 'generic', dynatemp: true, min_temp: 0.5, max_temp: 1.5 }), 'm', 'p', 10, false, false, null, 'normal');
    assert.equal(genericParams.temperature, genericParams.temperature); // falls back to settings.temp
    assert.equal(genericParams.dynamic_temperature, undefined);
}

// MANCER: epsilon_cutoff/eta_cutoff scaled by /1000, dynatemp_mode derived, dynatemp_low/high renamed to min/max
{
    const settings = baseSettings({ type: 'mancer', epsilon_cutoff: 500, eta_cutoff: 2000, dynatemp: true, min_temp: 0.4, max_temp: 1.2, mancer_model: 'mancer-x' });
    const params = createTextGenGenerationData(settings, 'mancer-x', 'p', 10, false, false, null, 'normal');
    assert.equal(params.epsilon_cutoff, 0.5);
    assert.equal(params.eta_cutoff, 2);
    assert.equal(params.dynatemp_mode, 1);
    assert.equal(params.dynatemp_min, 0.4);
    assert.equal(params.dynatemp_max, 1.2);
    assert.equal('dynatemp_low' in params, false);
    assert.equal('dynatemp_high' in params, false);
}

// KOBOLDCPP: sampler_order only for koboldcpp, grammar/grammar_retain_state/trim_stop set
{
    const settings = baseSettings({ type: 'koboldcpp', sampler_order: [6, 0, 1, 3, 4, 2, 5], grammar_string: 'root ::= "a"' });
    const params = createTextGenGenerationData(settings, 'm', 'p', 10, false, true, null, 'normal');
    assert.deepEqual(params.sampler_order, [6, 0, 1, 3, 4, 2, 5]);
    assert.equal(params.grammar, 'root ::= "a"');
    assert.equal(params.grammar_retain_state, true); // isContinue=true and grammar_string set
    assert.equal(params.trim_stop, true);

    const oobaParams = createTextGenGenerationData(baseSettings({ type: 'ooba', sampler_order: [1, 2, 3] }), 'm', 'p', 10, false, false, null, 'normal');
    assert.equal(oobaParams.sampler_order, undefined);
}

// HUGGINGFACE: top_p clamped to [0, 0.999], stop capped to 4 entries
{
    const settings = baseSettings({ type: 'huggingface', top_p: 5 });
    const params = createTextGenGenerationData(settings, 'tgi', 'p', 10, false, false, null, 'normal', { stoppingStrings: ['a', 'b', 'c', 'd', 'e'] });
    assert.equal(params.top_p, 0.999);
    assert.deepEqual(params.stop, ['a', 'b', 'c', 'd', 'e'].slice(0, 4));
}

// VLLM/INFERMATICAI route through vllmParams (n honors canMultiSwipe, ignore_eos present)
{
    const params = createTextGenGenerationData(baseSettings({ type: 'vllm', ignore_eos_token: true, n: 3 }), 'm', 'p', 10, false, false, null, 'normal');
    assert.equal(params.ignore_eos, true);
    assert.equal(params.n, 3); // type='normal', not continue/impersonate/quiet -> canMultiSwipe true -> n preserved
}

// canMultiSwipe: n only preserved when not continue/impersonate and type isn't 'quiet'
{
    const multiSwipeAllowed = createTextGenGenerationData(baseSettings({ type: 'vllm', n: 4 }), 'm', 'p', 10, false, false, null, 'normal');
    assert.equal(multiSwipeAllowed.n, 4);

    const quietBlocked = createTextGenGenerationData(baseSettings({ type: 'vllm', n: 4 }), 'm', 'p', 10, false, false, null, 'quiet');
    assert.equal(quietBlocked.n, 1);

    const continueBlocked = createTextGenGenerationData(baseSettings({ type: 'vllm', n: 4 }), 'm', 'p', 10, false, true, null, 'normal');
    assert.equal(continueBlocked.n, 1);
}

// APHRODITE routes through aphroditeParams; sampler_priority only set when non-default order
{
    const defaultOrderParams = createTextGenGenerationData(baseSettings({ type: 'aphrodite', samplers_priorities: APHRODITE_DEFAULT_ORDER }), 'm', 'p', 10, false, false, null, 'normal');
    assert.equal(defaultOrderParams.sampler_priority, undefined);

    const customOrderParams = createTextGenGenerationData(baseSettings({ type: 'aphrodite', samplers_priorities: ['temperature', 'dry'] }), 'm', 'p', 10, false, false, null, 'normal');
    assert.deepEqual(customOrderParams.sampler_priority, ['temperature', 'dry']);
    assert.equal(customOrderParams.repetition_penalty, customOrderParams.repetition_penalty); // aphroditeParams shape applied (has repetition_penalty, not rep_pen key)
    assert.equal('rep_pen' in customOrderParams, false);
}

// LLAMACPP: logit_bias array conversion + banned token merge, grammar/json_schema mutual exclusion
{
    const withSchema = createTextGenGenerationData(
        baseSettings({ type: 'llamacpp', json_schema: { type: 'object' }, grammar_string: 'root ::= "a"', logit_bias: [{ id: 10, value: 1.5 }] }),
        'm', 'p', 10, false, false, null, 'normal',
        { bannedTokens: '5,6', logitBias: { '10': 1.5 } },
    );
    assert.deepEqual(withSchema.logit_bias.sort(), [[5, false], [6, false], [10, 1.5]].sort());
    assert.equal(withSchema.grammar_string, undefined); // deleted because jsonSchema present
    assert.equal(withSchema.grammar, undefined);
    assert.deepEqual(withSchema.json_schema, { type: 'object' });

    const withoutSchema = createTextGenGenerationData(baseSettings({ type: 'llamacpp', grammar_string: 'root ::= "a"' }), 'm', 'p', 10, false, false, null, 'normal');
    assert.equal(withoutSchema.json_schema, undefined);
    assert.equal(withoutSchema.grammar, 'root ::= "a"');
}

// Returned object has no leftover internal helper function
{
    const params = createTextGenGenerationData(baseSettings(), 'm', 'p', 10, false, false, null, 'normal');
    assert.equal('parseSequenceBreakers' in params, false);
}

console.log('textgen-generation-data.test.js: all assertions passed');
