import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// novel-generation-data.js imports src/tokenizer-resolve.js, which statically imports
// src/endpoints/tokenizers.js - that module pulls in code (e.g. src/endpoints/secrets.js) that
// reads process-wide config at MODULE IMPORT time. The config path must be set before that import
// chain runs, so both modules are imported dynamically here, after setConfigFilePath() - same
// approach as src/tokenizer-resolve.test.js.
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

const { tokenizers } = await import('./tokenizer-resolve.js');
const {
    getTokenizerTypeForModel,
    selectPrefix,
    getBadWordPermutations,
    getBadWordIds,
    calculateNovelLogitBias,
    getNovelMaxResponseTokens,
    createNovelGenerationData,
} = await import('./novel-generation-data.js');

/** Simple fake encoder: maps each character to its char code. Synchronous, on purpose - see the
 * module doc comment's note that encodeTokens tolerates either sync or async encoders. */
function fakeEncodeTokens(tokenizerType, text) {
    return Array.from(text).map(c => c.charCodeAt(0));
}

function run(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            return result.then(() => console.log(`ok - ${name}`)).catch(err => {
                console.error(`not ok - ${name}`);
                throw err;
            });
        }
        console.log(`ok - ${name}`);
    } catch (err) {
        console.error(`not ok - ${name}`);
        throw err;
    }
}

const tests = [];
function test(name, fn) {
    tests.push(() => run(name, fn));
}

// --- getTokenizerTypeForModel ---

test('getTokenizerTypeForModel: clio -> NERD', () => {
    assert.strictEqual(getTokenizerTypeForModel('clio-v1'), tokenizers.NERD);
});

test('getTokenizerTypeForModel: kayra -> NERD2', () => {
    assert.strictEqual(getTokenizerTypeForModel('kayra-v1'), tokenizers.NERD2);
});

test('getTokenizerTypeForModel: erato -> LLAMA3', () => {
    assert.strictEqual(getTokenizerTypeForModel('llama-3-erato-v1'), tokenizers.LLAMA3);
});

test('getTokenizerTypeForModel: unknown model -> NONE', () => {
    assert.strictEqual(getTokenizerTypeForModel('some-other-model'), tokenizers.NONE);
});

// --- selectPrefix ---

test('selectPrefix: new model (clio) without } in tail -> selectedPrefix', () => {
    const finalPrompt = 'Just a normal prompt with no brackets at all.';
    assert.strictEqual(selectPrefix('my_prefix', finalPrompt, 'clio-v1'), 'my_prefix');
});

test('selectPrefix: new model (kayra) with } in tail 1500 chars -> special_instruct', () => {
    const finalPrompt = 'padding'.repeat(50) + ' { instruction } more text';
    assert.strictEqual(selectPrefix('my_prefix', finalPrompt, 'kayra-v1'), 'special_instruct');
});

test('selectPrefix: new model (erato) with } far outside tail 1500 chars -> selectedPrefix', () => {
    const finalPrompt = '{ instruction }' + 'x'.repeat(2000);
    assert.strictEqual(selectPrefix('my_prefix', finalPrompt, 'llama-3-erato-v1'), 'my_prefix');
});

test('selectPrefix: older/non-new model always -> vanilla, regardless of } or prefix', () => {
    const finalPromptWithBrace = 'padding'.repeat(50) + ' { instruction } more text';
    const finalPromptWithoutBrace = 'no brackets here';
    assert.strictEqual(selectPrefix('my_prefix', finalPromptWithBrace, 'sigurd-v1'), 'vanilla');
    assert.strictEqual(selectPrefix('my_prefix', finalPromptWithoutBrace, 'sigurd-v1'), 'vanilla');
});

// --- getBadWordPermutations ---

test('getBadWordPermutations: generates case/leading-space variants', () => {
    const result = getBadWordPermutations('foo');
    const expected = ['foo', ' foo', 'Foo', ' Foo', 'foo', ' foo', 'FOO', ' FOO', 'foo', ' foo'].filter((v, i, a) => a.indexOf(v) === i);
    assert.deepStrictEqual(result, expected);
});

// --- getBadWordIds ---

test('getBadWordIds: {verbatim} format tokenizes the inner text as-is', async () => {
    const result = await getBadWordIds('{abc}', tokenizers.NERD, fakeEncodeTokens);
    assert.deepStrictEqual(result, [[97, 98, 99]]);
});

test('getBadWordIds: [1,2,3] format passes raw token ids through', async () => {
    const result = await getBadWordIds('[1,2,3]', tokenizers.NERD, fakeEncodeTokens);
    assert.deepStrictEqual(result, [[1, 2, 3]]);
});

test('getBadWordIds: plain text expands into permutations, each tokenized', async () => {
    const result = await getBadWordIds('ab', tokenizers.NERD, fakeEncodeTokens);
    const permutations = getBadWordPermutations('ab');
    const expected = permutations.map(p => Array.from(p).map(c => c.charCodeAt(0)));
    assert.deepStrictEqual(result, expected);
});

test('getBadWordIds: tokenizerType === NONE short-circuits to []', async () => {
    const result = await getBadWordIds('{abc}\n[1,2,3]\nab', tokenizers.NONE, fakeEncodeTokens);
    assert.deepStrictEqual(result, []);
});

// --- calculateNovelLogitBias ---

test('calculateNovelLogitBias: empty/missing entries -> []', async () => {
    assert.deepStrictEqual(await calculateNovelLogitBias([], tokenizers.NERD, fakeEncodeTokens), []);
    assert.deepStrictEqual(await calculateNovelLogitBias(undefined, tokenizers.NERD, fakeEncodeTokens), []);
});

test('calculateNovelLogitBias: verbatim/list/plain-text entry formats', async () => {
    const entries = [
        { text: '{ab}', value: 5 },
        { text: '[1,2]', value: -5 },
        { text: 'ab', value: 2 },
    ];
    const result = await calculateNovelLogitBias(entries, tokenizers.NERD, fakeEncodeTokens);
    assert.deepStrictEqual(result, [
        { bias: 5, ensure_sequence_finish: false, generate_once: false, sequence: [97, 98] },
        { bias: -5, ensure_sequence_finish: false, generate_once: false, sequence: [1, 2] },
        { bias: 2, ensure_sequence_finish: false, generate_once: false, sequence: [32, 97, 98] },
    ]);
});

// --- getNovelMaxResponseTokens ---

test('getNovelMaxResponseTokens: tier 1 -> 150', () => {
    assert.strictEqual(getNovelMaxResponseTokens(1), 150);
});

test('getNovelMaxResponseTokens: tier 2 -> 150', () => {
    assert.strictEqual(getNovelMaxResponseTokens(2), 150);
});

test('getNovelMaxResponseTokens: tier 3 -> 250', () => {
    assert.strictEqual(getNovelMaxResponseTokens(3), 250);
});

test('getNovelMaxResponseTokens: unset/unrecognized tier -> maximum_output_length fallback (150)', () => {
    assert.strictEqual(getNovelMaxResponseTokens(undefined), 150);
    assert.strictEqual(getNovelMaxResponseTokens(99), 150);
});

// --- createNovelGenerationData: Erato stop-string expansion ---

test('createNovelGenerationData: erato expands \\n-prefixed stop strings into 12 variants', async () => {
    const data = await create({
        finalPrompt: 'hello',
        settings: baseSettings({ model_novel: 'llama-3-erato-v1' }),
        maxLength: 50,
        stoppingStringsParams: { instructPreset: {}, customStoppingStringsRaw: JSON.stringify(['\nBob:']) },
        encodeTokens: fakeEncodeTokens,
    });

    const expectedVariants = [
        '\nBob:', // original, kept
        '.\nBob:', '!\nBob:', '?\nBob:', '*\nBob:', '"\nBob:', '_\nBob:',
        '...\nBob:', '."\nBob:', '?"\nBob:', '!"\nBob:', '.*\nBob:', ')\nBob:',
    ];
    const decodedStopSequences = data.stop_sequences.map(ids => String.fromCharCode(...ids));
    for (const variant of expectedVariants) {
        assert.ok(decodedStopSequences.includes(variant), `missing variant: ${JSON.stringify(variant)}`);
    }
    assert.strictEqual(decodedStopSequences.length, expectedVariants.length);
});

test('createNovelGenerationData: erato does not expand non-\\n-prefixed stop strings', async () => {
    const data = await create({
        finalPrompt: 'hello',
        settings: baseSettings({ model_novel: 'llama-3-erato-v1' }),
        maxLength: 50,
        stoppingStringsParams: { customStoppingStringsRaw: JSON.stringify(['Bob:']) },
        encodeTokens: fakeEncodeTokens,
    });
    const decodedStopSequences = data.stop_sequences.map(ids => String.fromCharCode(...ids));
    assert.deepStrictEqual(decodedStopSequences, ['Bob:']);
});

// --- createNovelGenerationData: Erato prompt-prefix hack ---

test('createNovelGenerationData: erato prepends the startoftext/reserved-token prefix to the prompt', async () => {
    const data = await create({
        finalPrompt: 'hello world',
        settings: baseSettings({ model_novel: 'llama-3-erato-v1' }),
        maxLength: 50,
        encodeTokens: fakeEncodeTokens,
    });
    assert.strictEqual(data.input, '<|startoftext|><|reserved_special_token81|>hello world');
});

test('createNovelGenerationData: non-erato model does not get the prefix hack', async () => {
    const data = await create({
        finalPrompt: 'hello world',
        settings: baseSettings({ model_novel: 'kayra-v1' }),
        maxLength: 50,
        encodeTokens: fakeEncodeTokens,
    });
    assert.strictEqual(data.input, 'hello world');
});

// --- createNovelGenerationData: max_length clamping ---

test('createNovelGenerationData: kayra/erato clamp using getNovelMaxResponseTokens (tier-based)', async () => {
    const dataUnderCap = await create({
        finalPrompt: 'hello',
        settings: baseSettings({ model_novel: 'kayra-v1' }),
        maxLength: 100,
        novelDataTier: 3, // adjustedMaxLength = 250
        encodeTokens: fakeEncodeTokens,
    });
    assert.strictEqual(dataUnderCap.max_length, 100);

    const dataOverCap = await create({
        finalPrompt: 'hello',
        settings: baseSettings({ model_novel: 'kayra-v1' }),
        maxLength: 300,
        novelDataTier: 3, // adjustedMaxLength = 250
        encodeTokens: fakeEncodeTokens,
    });
    assert.strictEqual(dataOverCap.max_length, 250);

    const dataErato = await create({
        finalPrompt: 'hello',
        settings: baseSettings({ model_novel: 'llama-3-erato-v1' }),
        maxLength: 300,
        novelDataTier: 1, // adjustedMaxLength = 150
        encodeTokens: fakeEncodeTokens,
    });
    assert.strictEqual(dataErato.max_length, 150);
});

test('createNovelGenerationData: clio/other clamp using the static maximum_output_length (150)', async () => {
    const dataUnderCap = await create({
        finalPrompt: 'hello',
        settings: baseSettings({ model_novel: 'clio-v1' }),
        maxLength: 100,
        novelDataTier: 3, // irrelevant for clio - static cap applies
        encodeTokens: fakeEncodeTokens,
    });
    assert.strictEqual(dataUnderCap.max_length, 100);

    const dataOverCap = await create({
        finalPrompt: 'hello',
        settings: baseSettings({ model_novel: 'clio-v1' }),
        maxLength: 300,
        novelDataTier: 3,
        encodeTokens: fakeEncodeTokens,
    });
    assert.strictEqual(dataOverCap.max_length, 150);
});

// --- createNovelGenerationData: tokenizerType === NONE -> undefined, not [] ---

test('createNovelGenerationData: stop_sequences/bad_words_ids/logit_bias_exp are undefined for tokenizerType NONE', async () => {
    const data = await create({
        finalPrompt: 'hello',
        settings: baseSettings({ model_novel: 'some-unknown-model', banned_tokens: 'foo', logit_bias: [{ text: 'foo', value: 1 }] }),
        maxLength: 50,
        encodeTokens: fakeEncodeTokens,
    });
    assert.strictEqual(data.stop_sequences, undefined);
    assert.strictEqual(data.bad_words_ids, undefined);
    assert.strictEqual(data.logit_bias_exp, undefined);
});

test('createNovelGenerationData: stop_sequences/bad_words_ids/logit_bias_exp are arrays for a known tokenizerType', async () => {
    const data = await create({
        finalPrompt: 'hello',
        settings: baseSettings({ model_novel: 'kayra-v1', banned_tokens: '', logit_bias: [] }),
        maxLength: 50,
        encodeTokens: fakeEncodeTokens,
    });
    assert.ok(Array.isArray(data.stop_sequences));
    assert.ok(Array.isArray(data.bad_words_ids));
    assert.ok(Array.isArray(data.logit_bias_exp));
});

/**
 * createNovelGenerationData() always calls getStoppingStrings(), whose instruct-mode branch
 * (src/instruct-template-format.js's getInstructStoppingSequences()) unconditionally reads
 * `instructPreset.enabled` - so every real caller must supply a resolved instructPreset object
 * (same requirement src/kobold-generation-data.js's identical getStoppingStrings() call site has).
 * This helper supplies an empty-but-defined one by default so tests that aren't specifically about
 * stopping strings don't have to repeat that boilerplate.
 */
function create(params) {
    return createNovelGenerationData({
        ...params,
        stoppingStringsParams: { instructPreset: {}, ...params.stoppingStringsParams },
    });
}

function baseSettings(overrides = {}) {
    return {
        model_novel: 'clio-v1',
        temperature: 1.5,
        min_length: 1,
        tail_free_sampling: 0.975,
        repetition_penalty: 2.25,
        repetition_penalty_range: 2048,
        repetition_penalty_slope: 0.09,
        repetition_penalty_frequency: 0,
        repetition_penalty_presence: 0.005,
        top_a: 0.08,
        top_p: 0.75,
        top_k: 10,
        min_p: 0,
        math1_temp: 1,
        math1_quad: 0,
        math1_quad_entropy_scale: 0,
        typical_p: 0.975,
        mirostat_lr: 1,
        mirostat_tau: 0,
        phrase_rep_pen: 'aggressive',
        banned_tokens: '',
        logit_bias: [],
        prefix: 'vanilla',
        order: undefined,
        ...overrides,
    };
}

async function main() {
    for (const t of tests) {
        await t();
    }
    console.log(`\nAll ${tests.length} tests passed.`);
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
