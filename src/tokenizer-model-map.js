import tiktoken from 'tiktoken';

import { tokenizers, TOKENIZER_TYPE_KEYS } from './tokenizer-ids.js';

// Exact-only: a name the rules below don't clearly place is unmapped (null), never given a
// possibly-wrong tokenizer. An id that points at different models over time (a moving alias such as
// `deepseek-chat` or `mistral-large-latest`) is never listed: a hand-kept alias table goes stale when
// the vendor moves the alias.

/**
 * What the map gives for a model:
 * - a `tokenizers` value;
 * - a tiktoken model name;
 * - `{ source }`, a src/tokenizer-sources.js entry id;
 * - `{ byBackend }`, for a model whose vendor's own files disagree: `vendorApis` maps a
 *   chat-completion source (the vendor's own API) to the result for it, and `hf` is the repo's HF
 *   `tokenizer.json`, for a backend documented to tokenize with it. Also for a name that says which
 *   weights it is only where the user loaded them: `other` is the result on a self-hosted backend,
 *   and every hosted API gets the estimate.
 * @typedef {number | string | { source: string } | { byBackend: { vendorApis?: Record<string, MapResult>, hf?: MapResult, other?: MapResult } }} MapResult
 */

/**
 * One entry that matched a name. `supersedes` names results this one wins over when both match, by
 * their mapResultKey().
 * @typedef {{ result: MapResult, supersedes?: string[] }} MapMatch
 */

const ALL_DIGITS = /^\d+$/;

/**
 * @param {string} name
 * @returns {string[]}
 */
function tokenize(name) {
    return name.toLowerCase().split(/[-_./: ]/).filter(token => token !== '');
}

/**
 * @param {string[]} tokens
 * @param {string[]} sequence
 * @returns {number[]}
 */
function findSequence(tokens, sequence) {
    const found = [];
    for (let i = 0; i + sequence.length <= tokens.length; i++) {
        if (sequence.every((part, j) => tokens[i + j] === part)) {
            found.push(i);
        }
    }
    return found;
}

/**
 * @param {string[]} tokens
 * @param {string[]} sequence
 * @returns {boolean}
 */
function hasSequence(tokens, sequence) {
    return findSequence(tokens, sequence).length > 0;
}

/**
 * Checks the occurrences of `sequences` against `isExcluded`, which receives the tokens that
 * follow an occurrence. Any excluded occurrence makes the whole name unmapped.
 * @param {string[]} tokens
 * @param {string[][]} sequences
 * @param {(rest: string[]) => boolean} isExcluded
 * @returns {'match' | 'none' | 'veto'}
 */
function guardedMatch(tokens, sequences, isExcluded) {
    let matched = false;
    for (const sequence of sequences) {
        for (const start of findSequence(tokens, sequence)) {
            if (isExcluded(tokens.slice(start + sequence.length))) {
                return 'veto';
            }
            matched = true;
        }
    }
    return matched ? 'match' : 'none';
}

/** @param {string[]} rest */
const followedByAllDigits = rest => rest.length > 0 && ALL_DIGITS.test(rest[0]);

/**
 * The result for a model Google's own API also serves under its name: the name says which weights
 * they are only on a self-hosted backend, and every hosted API gets the estimate.
 * @param {string} source
 * @returns {MapResult}
 */
const onSelfHostedOnly = source => ({ byBackend: { other: { source } } });

/**
 * Version numbers each Gemma name may have after it; any other is an unknown version.
 * @type {Array<[string[], (next: string) => boolean]>}
 */
const GEMMA_KNOWN_VERSIONS = [
    [['gemma'], next => ['1', '2', '3', '4'].includes(next)],
    [['gemma', '1'], next => next === '1'],
    [['gemma', '2'], () => false],
    [['gemma2'], () => false],
    [['gemma', '3'], () => false],
    [['gemma3'], () => false],
    [['gemma', '3n'], () => false],
    [['gemma3n'], () => false],
    [['gemma', '4'], () => false],
    [['gemma4'], () => false],
    [['codegemma'], next => next === '1'],
    [['codegemma', '1'], next => next === '1'],
    [['medgemma'], next => next === '1'],
    [['medgemma', '1'], next => next === '5'],
    [['translategemma'], () => false],
    [['shieldgemma'], next => next === '2'],
    [['shieldgemma', '2'], () => false],
];

/**
 * Gemma 1/2 (the bundled gemma.model), Gemma 2 JPN, Gemma 3, 3n, 4, CodeGemma, and the Gemma 3 based
 * MedGemma, TranslateGemma and ShieldGemma 2. A Gemma 3, 3n or 4, CodeGemma, MedGemma or
 * TranslateGemma name without a size picks no one model.
 * @param {string[]} tokens
 * @returns {MapMatch[] | null} null when an unknown version vetoes the name
 */
function gemmaFamilyMatches(tokens) {
    for (const [sequence, isKnown] of GEMMA_KNOWN_VERSIONS) {
        if (guardedMatch(tokens, [sequence], rest => followedByAllDigits(rest) && !isKnown(rest[0])) === 'veto') {
            return null;
        }
    }

    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });
    /**
     * The one size of `sizes` the name has; null for none or several.
     * @param {string[]} sizes
     */
    const onlySize = sizes => {
        const found = sizes.filter(size => tokens.includes(size));
        return found.length === 1 ? found[0] : null;
    };
    const hasIt = tokens.includes('it');
    const hasPt = tokens.includes('pt');
    const hasQat = tokens.includes('qat');

    // Gemma 1 (gemma-2b, gemma-7b, gemma-1.1-*, Ollama's gemma:v1.1) and Gemma 2 ship gemma.model.
    if (findSequence(tokens, ['gemma']).some(start => ['1', '2', '2b', '7b', 'v1'].includes(tokens[start + 1])) || tokens.includes('gemma2')) {
        add(tokenizers.GEMMA);
    }
    // Gemma-2-2B-JPN ships its own file.
    if (hasSequence(tokens, ['gemma', '2', '2b', 'jpn'])) {
        matches.push({ result: { source: 'gemma-2-jpn' }, supersedes: [TOKENIZER_TYPE_KEYS[tokenizers.GEMMA]] });
    }

    // Gemma 3: google/gemma-3-{1b,4b,12b,27b}-it ship the -it file. The -pt repos, 270m and 270m-it and
    // the -it QAT repos ship the -pt file. Ollama's `gemma3:<size>` tags are the -it models; a
    // `gemma-3-<size>` name with neither `it` nor `pt` picks neither file.
    if (hasSequence(tokens, ['gemma', '3']) || tokens.includes('gemma3')) {
        const size = onlySize(['270m', '1b', '4b', '12b', '27b']);
        const isIt = hasIt ? !hasPt : !hasPt && tokens.includes('gemma3');
        const isPt = hasPt && !hasIt;
        if (size === '270m' || (size && (isPt || (isIt && hasQat)))) {
            add({ source: 'gemma-3-pt' });
        } else if (size && isIt) {
            add(onSelfHostedOnly('gemma-3-it'));
        }
    }
    // MedGemma, TranslateGemma and ShieldGemma 2 ship the Gemma 3 -pt file.
    if ((tokens.includes('medgemma') && onlySize(['4b', '27b']))
        || (tokens.includes('translategemma') && onlySize(['4b', '12b', '27b']))
        || hasSequence(tokens, ['shieldgemma', '2', '4b'])) {
        add({ source: 'gemma-3-pt' });
    }

    // Gemma 3n: the E2B and E4B repos, base and -it, ship one file. Ollama's gemma3n tags are the -it models.
    if (hasSequence(tokens, ['gemma', '3n']) || tokens.includes('gemma3n')) {
        const isIt = hasIt ? !hasPt : !hasPt && tokens.includes('gemma3n');
        if (onlySize(['e2b', 'e4b'])) add(isIt ? onSelfHostedOnly('gemma-3n') : { source: 'gemma-3n' });
    }

    // Gemma 4: the -it and base repos ship files with the same content; the -assistant repos ship one
    // without `<|video|>`. Google's API serves the 31B and 26B-A4B -it models. Ollama's `gemma4:<size>`
    // tags are the -it models; its `gemma4:31b-coding` file is unknown.
    if ((hasSequence(tokens, ['gemma', '4']) || tokens.includes('gemma4')) && !tokens.includes('coding')) {
        const size = onlySize(['e2b', 'e4b', '12b', '26b', '31b']);
        const isIt = hasIt ? !hasPt : !hasPt && tokens.includes('gemma4');
        if (size && tokens.includes('assistant')) {
            add({ source: 'gemma-4-assistant' });
        } else if (size) {
            add(isIt && !hasQat && ['26b', '31b'].includes(size) ? onSelfHostedOnly('gemma-4') : { source: 'gemma-4' });
        }
    }

    // CodeGemma 1.0 and 1.1, 2b and 7b, base and -it, ship one file.
    if (tokens.includes('codegemma') && onlySize(['2b', '7b'])) add({ source: 'codegemma' });

    return matches;
}

/**
 * Llama 3.0 (the bundled llama3.json), 3.1, 3.2 text, 3.3, 4 and Llama Guard 2, 3 and 4. A name
 * without one of its version's sizes picks no one model.
 * @param {string[]} tokens
 * @returns {MapMatch[] | null} null when the name names an unknown version, or two versions
 */
function llamaFamilyMatches(tokens) {
    // Fireworks spells Llama 3.1 `llama-v3p1`.
    tokens = tokens.flatMap((token, i) => {
        const fireworks = /^v3p(\d+)$/.exec(token);
        return fireworks && tokens[i - 1] === 'llama' ? ['3', fireworks[1]] : [token];
    });

    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });
    /**
     * The one size of `sizes` the name has; null for none or several.
     * @param {string[]} sizes
     */
    const onlySize = sizes => {
        const found = sizes.filter(size => tokens.includes(size));
        return found.length === 1 ? found[0] : null;
    };

    // `llama`,`3` or `llama3` followed by nothing numeric is Llama 3.0; by 1, 2 or 3 it is 3.1, 3.2 or 3.3.
    const minors = new Set();
    let isLlama30 = false;
    for (const sequence of [['llama', '3'], ['llama3']]) {
        for (const start of findSequence(tokens, sequence)) {
            const next = tokens[start + sequence.length];
            if (next === undefined || !ALL_DIGITS.test(next)) {
                isLlama30 = true;
            } else if (['1', '2', '3'].includes(next)) {
                minors.add(next);
            } else {
                return null;
            }
        }
    }
    if ((isLlama30 && minors.size > 0) || minors.size > 1) return null;
    if (isLlama30) add(tokenizers.LLAMA3);

    // Nemotron models are NVIDIA's, with NVIDIA's own files.
    const minor = tokens.includes('nemotron') ? undefined : [...minors][0];
    if (minor === '1') {
        const size = onlySize(['8b', '70b', '405b']);
        // Ollama's `llama3.1:<size>` tags are the Instruct models, and so is Groq's `llama-3.1-8b-instant`.
        const isOllamaForm = findSequence(tokens, ['llama3', '1']).length > 0;
        const isInstruct = tokens.includes('instruct') || tokens.includes('instant')
            || (isOllamaForm && !tokens.includes('text') && !tokens.includes('base'));
        // Groq served its `llama-3.1-70b-versatile` and `-specdec` ids with Llama 3.3 before retiring them.
        const isMovedGroqId = size === '70b' && (tokens.includes('versatile') || tokens.includes('specdec'));
        // The 405B base repo also ships original/mp8/tokenizer.model, a 103,930-byte file of unknown content.
        const isUnknown405bBase = size === '405b' && !isInstruct && !tokens.includes('fp8');
        if (size && !isMovedGroqId && !isUnknown405bBase) {
            add({ source: isInstruct ? 'llama3.1' : 'llama3.1-base' });
        }
    }
    // Llama 3.2 1B and 3B, base and Instruct, ship the 3.1-Instruct file. The 3.2 Vision (11B, 90B)
    // tokenizer.json and original/tokenizer.model give different ids, so which one a backend reads is unknowable.
    if (minor === '2' && !tokens.includes('vision') && ['1b', '3b'].includes(onlySize(['1b', '3b', '11b', '90b']))) {
        add({ source: 'llama3.1' });
    }
    // Llama 3.3 is 70B Instruct only; Meta's API also served a closed Llama-3.3-8B-Instruct.
    if (minor === '3' && onlySize(['8b', '70b']) === '70b') {
        add({ source: 'llama3.3' });
    }

    // Llama 4 Scout and Maverick, base and Instruct, ship one file. Ollama's `llama4:16x17b` is
    // Scout, `llama4:128x17b` Maverick.
    const llama4 = guardedMatch(tokens, [['llama', '4'], ['llama4']], followedByAllDigits);
    if (llama4 === 'veto') return null;
    if (llama4 === 'match' && ['scout', 'maverick', '16x17b', '128x17b'].some(token => tokens.includes(token))) {
        add({ source: 'llama4' });
    }

    // Llama Guard 3 1B ships the 3.1-Instruct file. `llama-guard3` is Ollama's form, `LlamaGuard-2` Together's.
    /** @type {Record<string, Record<string, string>>} version -> size -> registry entry */
    const guardFiles = {
        '2': { '8b': 'llama-guard-2' },
        '3': { '1b': 'llama3.1', '8b': 'llama-guard-3-8b', '11b': 'llama-guard-3-11b-vision' },
        '4': { '12b': 'llama-guard-4' },
    };
    for (const [version, files] of Object.entries(guardFiles)) {
        const spellings = [['llama', 'guard', version], ['llama', `guard${version}`], ['llamaguard', version], [`llamaguard${version}`]];
        const size = onlySize(Object.keys(files));
        if (size && spellings.some(sequence => hasSequence(tokens, sequence))) add({ source: files[size] });
    }

    return matches;
}

/**
 * @param {string[]} tokens
 * @param {string} lowerName
 * @returns {MapMatch[] | null} null when a guard vetoes the name
 */
function generalMatches(tokens, lowerName) {
    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });

    if (hasSequence(tokens, ['llama', '2']) || hasSequence(tokens, ['llama2'])) {
        add(tokenizers.LLAMA);
    }

    // Phi-3 and Phi-3.5 ship llama.model; Phi-3-small is cl100k and Phi-3(.5)-vision has no
    // tokenizer.model, so neither is covered. `phi3` is Ollama's form (`phi3:mini`, `phi3.5`).
    const phi3 = guardedMatch(tokens, [['phi', '3'], ['phi3']], rest => followedByAllDigits(rest) && rest[0] !== '5');
    if (phi3 === 'veto') return null;
    if (phi3 === 'match' && !tokens.includes('small') && !tokens.includes('vision')) {
        add(tokenizers.LLAMA);
    }

    // CodeLlama 34b and 7b/13b Python ship llama.model; the 7b/13b base and Instruct and the 70b
    // files differ.
    const codellamaSequences = [
        ['codellama', '34b'],
        ['codellama', '7b', 'python'],
        ['codellama', '13b', 'python'],
    ];
    if (codellamaSequences.some(sequence => hasSequence(tokens, sequence))) add(tokenizers.LLAMA);

    // Gemma-derived models whose tokenizer.model is gemma.model; ShieldGemma 2 (Gemma 3) differs.
    const gemmaDerivedSequences = [
        ['recurrentgemma', '2b'],
        ['recurrentgemma', '9b'],
        ['shieldgemma', '2b'],
        ['shieldgemma', '9b'],
        ['shieldgemma', '27b'],
        ['datagemma', 'rag', '27b'],
        ['datagemma', 'rig', '27b'],
        ['txgemma', '2b', 'predict'],
        ['txgemma', '9b', 'chat'],
        ['txgemma', '9b', 'predict'],
        ['txgemma', '27b', 'chat'],
        ['txgemma', '27b', 'predict'],
    ];
    if (gemmaDerivedSequences.some(sequence => hasSequence(tokens, sequence))) add(tokenizers.GEMMA);

    if (guardedMatch(tokens, [['yi']], () => false) === 'match') add(tokenizers.YI);

    const llamaMatches = llamaFamilyMatches(tokens);
    if (llamaMatches === null) return null;
    matches.push(...llamaMatches);

    const gemmaMatches = gemmaFamilyMatches(tokens);
    if (gemmaMatches === null) return null;
    matches.push(...gemmaMatches);

    // Qwen1.5/Qwen2 ship qwen2.json. `qwen2`,`5` (Qwen2.5) and `qwen2`,`vl` (Qwen2-VL) have their own
    // entries below; `qwen2` followed by another number is an unknown version.
    let isQwen2 = false;
    for (const start of findSequence(tokens, ['qwen2'])) {
        const next = tokens[start + 1];
        if (next !== undefined && ALL_DIGITS.test(next) && next !== '5') return null;
        if (next !== '5' && next !== 'vl') isQwen2 = true;
    }
    if (isQwen2) add(tokenizers.QWEN2);

    // `qwen3` followed by a number other than 3.5, 3.6 and 3.8 is an unknown version.
    const qwen3Version = guardedMatch(tokens, [['qwen3']], rest => followedByAllDigits(rest) && !['5', '6', '8'].includes(rest[0]));
    if (qwen3Version === 'veto') return null;

    /** @param {string} token */
    const isSizeToken = token => /^a?\d+[bt]$/.test(token);
    // A Qwen name that doesn't pick one model is a moving alias (step 18): estimate. A size token
    // (`8b`, `a3b`, `4t`) picks one; so do Qwen3-Coder-Next, Qwen3.8-Flash-Next and QVQ (QVQ-72B-Preview
    // is the only open QVQ).
    const picksOneQwenModel = tokens.some(isSizeToken)
        || hasSequence(tokens, ['coder', 'next'])
        || hasSequence(tokens, ['flash', 'next'])
        || tokens.includes('qvq');
    // Closed DashScope ids (plus, max, omni, flash other than Flash-Next) count by estimate.
    const isClosedQwen = ['plus', 'max', 'omni'].some(token => tokens.includes(token))
        || tokens.some((token, i) => token === 'flash' && tokens[i + 1] !== 'next');
    // DeepSeek's Qwen-based models are DeepSeek's entries. The FuseO1-DeepSeekR1-* fusions ship varying
    // files (R1-Distill-Qwen's content, Qwen2.5's, others), so they are unmapped.
    const qwenGate = !tokens.includes('deepseek') && !tokens.includes('deepseekr1') && !isClosedQwen && picksOneQwenModel;

    const hasBase = tokens.includes('base');
    const isCoderNext = hasSequence(tokens, ['coder', 'next']);
    const hasUnversionedQwen3 = findSequence(tokens, ['qwen3']).some(start => !followedByAllDigits(tokens.slice(start + 1)));
    // Qwen3 Embedding, ASR, ForcedAligner, Omni, the closed rerank and Qwen3-235B-A22B-MLX (an extra
    // `<unk>`) ship files that differ; Qwen3-TTS has no tokenizer.json. Qwen3-Reranker ships the Qwen3 file.
    const isOtherQwen3File = ['embedding', 'asr', 'forcedaligner', 'tts', 'omni', 'rerank'].some(token => tokens.includes(token))
        || (tokens.includes('mlx') && hasSequence(tokens, ['qwen3', '235b']));

    // Qwen1.5 ships the same file as Qwen2.
    if (qwenGate && hasSequence(tokens, ['qwen1', '5'])) add(tokenizers.QWEN2);

    // Qwen2-VL ships its own file; the Qwen2-VL AWQ/GPTQ repos ship a file with two more added tokens.
    if (qwenGate && hasSequence(tokens, ['qwen2', 'vl']) && !tokens.includes('awq') && !tokens.includes('gptq')) {
        add({ source: 'qwen2-vl' });
    }

    // The Qwen2.5 file: Qwen2.5 (Coder, Math, VL, 1M; not Omni or the PRMs, whose files differ),
    // QwQ-32B-Preview, QVQ-72B-Preview, and the Qwen3-*-Base repos (Qwen3-Coder-Next-Base ships the Qwen3 file).
    const isQwen25File = (hasSequence(tokens, ['qwen2', '5']) && !['omni', 'prm', 'prm800k'].some(token => tokens.includes(token)))
        || hasSequence(tokens, ['qwq', '32b', 'preview'])
        || tokens.includes('qvq')
        || (hasUnversionedQwen3 && hasBase && !isCoderNext && !isOtherQwen3File);
    if (qwenGate && isQwen25File) add({ source: 'qwen2.5' });

    // The Qwen3 file: Qwen3 (incl. Next, Coder, VL, Reranker) other than the Base repos, and QwQ-32B.
    const isQwen3File = !isOtherQwen3File
        && ((hasUnversionedQwen3 && (!hasBase || isCoderNext)) || (tokens.includes('qwq') && !tokens.includes('preview')));
    if (qwenGate && isQwen3File) add({ source: 'qwen3' });

    // Qwen3.5 and Qwen3.6 ship the Qwen3.5 file; Qwen3.5-*-Base ships its own.
    const isQwen35 = hasSequence(tokens, ['qwen3', '5']);
    if (qwenGate && !hasBase && (isQwen35 || hasSequence(tokens, ['qwen3', '6']))) add({ source: 'qwen3.5' });
    if (qwenGate && hasBase && isQwen35) add({ source: 'qwen3.5-base' });

    // The open Qwen3.8 repos ship the Qwen3.8 file.
    if (qwenGate && hasSequence(tokens, ['qwen3', '8'])) add({ source: 'qwen3.8' });

    // CodeQwen1.5 ships its own file.
    if (qwenGate && hasSequence(tokens, ['codeqwen1', '5'])) add({ source: 'codeqwen1.5' });

    // `deepseek`,`v3` followed by a number other than 0324 (V3-0324), 1 (V3.1) and 2 (V3.2), and
    // `deepseek`,`v4` followed by a number other than 1 (V4.1), are unknown versions.
    const deepseekV3Version = guardedMatch(tokens, [['deepseek', 'v3']], rest => followedByAllDigits(rest) && !['0324', '1', '2'].includes(rest[0]));
    if (deepseekV3Version === 'veto') return null;
    const deepseekV4Version = guardedMatch(tokens, [['deepseek', 'v4']], rest => followedByAllDigits(rest) && rest[0] !== '1');
    if (deepseekV4Version === 'veto') return null;

    /**
     * Whether `deepseek`,`<version>` occurs followed by a token `isNext` accepts (undefined at the end).
     * @param {string} version
     * @param {(next: string|undefined) => boolean} isNext
     */
    const deepseekVersionFollowedBy = (version, isNext) => findSequence(tokens, ['deepseek', version]).some(start => isNext(tokens[start + 2]));
    /** @param {string|undefined} token */
    const isNumber = token => token !== undefined && ALL_DIGITS.test(token);
    // NousResearch's DeepSeek-V3.1-Alternate-Tokenizer ships a file that differs from V3.1's. `-latest`
    // ids and OpenRouter's `~deepseek/…` ids are moving aliases. Ollama's `:latest` tag is not:
    // it stays within the version its repo name pins.
    const deepseekGate = !hasSequence(tokens, ['alternate', 'tokenizer'])
        && !lowerName.includes('-latest') && !tokens.includes('~deepseek');

    // DeepSeek-V2 (Lite), not V2.5 or V2-Chat-0628, which ship the V2.5 file, and not Coder-V2.
    if (deepseekGate && deepseekVersionFollowedBy('v2', next => !isNumber(next))
        && !hasSequence(tokens, ['chat', '0628']) && !tokens.includes('coder')) {
        add({ source: 'deepseek-v2' });
    }
    if (deepseekGate && (hasSequence(tokens, ['deepseek', 'v2', '5']) || hasSequence(tokens, ['deepseek', 'v2', 'chat', '0628'])
        || hasSequence(tokens, ['deepseek', 'coder', 'v2']))) {
        add({ source: 'deepseek-v2.5' });
    }

    // DeepSeek-V3 and V3-0324 ship deepseek.json's content.
    if (deepseekGate && deepseekVersionFollowedBy('v3', next => !isNumber(next) || next === '0324')) add(tokenizers.DEEPSEEK);
    // V3.1 (Terminus, Base) and V3.2-Exp ship the V3.1 file.
    if (deepseekGate && (hasSequence(tokens, ['deepseek', 'v3', '1']) || hasSequence(tokens, ['deepseek', 'v3', '2', 'exp']))) {
        add({ source: 'deepseek-v3.1' });
    }
    // V3.2 (Speciale) ships its own; DevQuasar's V3.2-Speciale-Channel-INT8 repo ships the R1 file.
    if (deepseekGate && hasSequence(tokens, ['deepseek', 'v3', '2']) && !tokens.includes('exp')
        && !hasSequence(tokens, ['speciale', 'channel', 'int8'])) {
        add({ source: 'deepseek-v3.2' });
    }

    // DeepSeek-R1, R1-Zero and R1-0528 ship the R1 file. A bare `deepseek-r1`, or one with a size other
    // than 671b, is on Ollama one of the distills, so it names no one file.
    const isDeepSeekR1 = (deepseekVersionFollowedBy('r1', next => next === 'zero' || next === '0528')
        || (hasSequence(tokens, ['deepseek', 'r1']) && tokens.includes('671b')))
        && !['distill', 'qwen', 'qwen3', 'llama'].some(token => tokens.includes(token))
        && !tokens.some(token => isSizeToken(token) && token !== '671b');
    if (deepseekGate && isDeepSeekR1) add({ source: 'deepseek-r1' });

    // The distills ship their own files, which win over their base model's: an R1 name with `distill`
    // next to its base family (`DeepSeek-R1-Distill-Qwen-7B`, Ollama's `deepseek-r1:7b-qwen-distill-q4_K_M`).
    // Every Qwen size ships one file, and so does every Llama size. `distill` elsewhere in the name is
    // not enough: the merge `Llama-3-DeepSeek-R1-Distill-8B-LewdPlay-Uncensored` ships llama3.json's content.
    /** @param {string} family */
    const isR1DistillOf = family => hasSequence(tokens, ['deepseek', 'r1'])
        && (hasSequence(tokens, ['distill', family]) || hasSequence(tokens, [family, 'distill']));
    if (deepseekGate && isR1DistillOf('qwen')) {
        matches.push({ result: { source: 'deepseek-r1-distill-qwen' }, supersedes: ['qwen2.5'] });
    }
    if (deepseekGate && isR1DistillOf('llama')) {
        matches.push({ result: { source: 'deepseek-r1-distill-llama' }, supersedes: ['llama3', 'llama3.1', 'llama3.1-base', 'llama3.3'] });
    }
    if (deepseekGate && hasSequence(tokens, ['deepseek', 'r1', '0528', 'qwen3'])) {
        matches.push({ result: { source: 'deepseek-r1-0528-qwen3' }, supersedes: ['qwen3', 'deepseek-r1'] });
    }

    // DeepSeek-V4-Flash and V4-Pro (0731, 0813, DSpark, Base) ship the V4 file. The name says which
    // weights they are only where the user loaded them, so it applies on self-hosted backends only:
    // hosts serve these ids with other weights (DeepSeek's API serves `deepseek-v4-flash` with V4.1).
    // Not V4-Flash-Vision-Exp (the V4.1 file), and not mlx-community's DeepSeek-V4-Pro-Qwen3.5 repos,
    // which ship a Qwen3.5 file. `deepseek-v4` and `deepseek-v4-lite` name no one model.
    if (deepseekGate && deepseekVersionFollowedBy('v4', next => next === 'flash' || next === 'pro')
        && !hasSequence(tokens, ['vision', 'exp']) && !tokens.includes('qwen3')) {
        add({ byBackend: { other: { source: 'deepseek-v4' } } });
    }
    if (deepseekGate && (hasSequence(tokens, ['deepseek', 'v4', '1']) || hasSequence(tokens, ['deepseek', 'v4', 'flash', 'vision', 'exp']))) {
        add({ source: 'deepseek-v4.1' });
    }

    const isMistralV1 = (hasSequence(tokens, ['mistral', '7b'])
        && (hasSequence(tokens, ['v0', '1']) || hasSequence(tokens, ['v0', '2'])))
        || hasSequence(tokens, ['mixtral', '8x7b'])
        // Mixtral 8x22B base v0.1 ships mistral.model; the Instruct and v0.3 files differ.
        || (hasSequence(tokens, ['mixtral', '8x22b']) && hasSequence(tokens, ['v0', '1']) && !tokens.includes('instruct'));
    if (isMistralV1) add(tokenizers.MISTRAL);

    if (hasSequence(tokens, ['nemo'])) add(tokenizers.NEMO);
    // Jamba 1.5/1.6/1.7, Jamba-tiny-dev and Jamba-tiny-reward-dev ship jamba.model; Jamba v0.1, Jamba2 and Jamba
    // Reasoning don't.
    const jambaSequences = [
        ['jamba', '1', '5'],
        ['jamba', '1', '6'],
        ['jamba', '1', '7'],
        ['jamba', 'mini', '1', '6'],
        ['jamba', 'mini', '1', '7'],
        ['jamba', 'large', '1', '6'],
        ['jamba', 'large', '1', '7'],
        ['jamba', 'tiny', 'dev'],
        ['jamba', 'tiny', 'reward', 'dev'],
    ];
    if (jambaSequences.some(sequence => hasSequence(tokens, sequence))) add(tokenizers.JAMBA);
    if (hasSequence(tokens, ['command', 'r'])) add(tokenizers.COMMAND_R);
    if (hasSequence(tokens, ['command', 'a'])) add(tokenizers.COMMAND_A);

    // tiktoken's model list is the authority on the raw (lowercased, not separator-split) name,
    // so separators do matter here: 'gpt-4o' is known, 'gpt_4o' is not.
    try {
        tiktoken.get_encoding_name_for_model(/** @type {any} */ (lowerName));
        add(lowerName);
    } catch {
        // not an OpenAI model tiktoken knows
    }

    return matches;
}

/**
 * @param {string[]} tokens
 * @returns {MapMatch[]}
 */
function novelMatches(tokens) {
    const results = [];
    if (hasSequence(tokens, ['clio'])) results.push(tokenizers.NERD);
    if (hasSequence(tokens, ['kayra'])) results.push(tokenizers.NERD2);
    if (hasSequence(tokens, ['erato'])) results.push(tokenizers.LLAMA3);
    return results.map(result => ({ result }));
}

/**
 * The name a `supersedes` list uses for a result: a registry entry id, a `tokenizers` value's
 * TOKENIZER_TYPE_KEYS key, or `tiktoken` for the tiktoken lookup.
 * @param {MapResult} result
 * @returns {string}
 */
export function mapResultKey(result) {
    if (typeof result === 'number') {
        return TOKENIZER_TYPE_KEYS[result] ?? String(result);
    }
    if (typeof result === 'string') {
        return 'tiktoken';
    }
    if ('source' in result) {
        return result.source;
    }
    const { vendorApis = {}, hf, other } = result.byBackend;
    const parts = Object.keys(vendorApis).sort().map(source => `${source}=${mapResultKey(vendorApis[source])}`);
    if (hf !== undefined) {
        parts.push(`hf=${mapResultKey(hf)}`);
    }
    if (other !== undefined) {
        parts.push(`other=${mapResultKey(other)}`);
    }
    return `byBackend(${parts.join(',')})`;
}

/**
 * The one result the matches agree on, after dropping every result another match supersedes;
 * null when none or more than one is left.
 * @param {MapMatch[]} matches
 * @returns {MapResult|null}
 */
export function pickMapResult(matches) {
    const superseded = new Set(matches.flatMap(match => match.supersedes ?? []));
    /** @type {Map<string, MapResult>} */
    const distinct = new Map();
    for (const { result } of matches) {
        const key = mapResultKey(result);
        if (!superseded.has(key)) {
            distinct.set(key, result);
        }
    }
    return distinct.size === 1 ? [...distinct.values()][0] : null;
}

/**
 * @param {string} api
 * @param {string} modelName
 * @returns {MapResult|null} null when unmapped
 */
export function lookupModelTokenizer(api, modelName) {
    if (typeof modelName !== 'string' || modelName === '') {
        return null;
    }
    const tokens = tokenize(modelName);
    const matches = api === 'novel'
        ? novelMatches(tokens)
        : generalMatches(tokens, modelName.toLowerCase());
    return matches === null ? null : pickMapResult(matches);
}
