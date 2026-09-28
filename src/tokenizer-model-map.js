import tiktoken from 'tiktoken';

import { CHAT_COMPLETION_SOURCES } from './constants.js';
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
 *   and every hosted API gets the estimate. `rest` is the result on every backend the other keys
 *   give none for.
 * @typedef {number | string | { source: string } | { byBackend: { vendorApis?: Record<string, MapResult>, hf?: MapResult, other?: MapResult, rest?: MapResult } }} MapResult
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
 * The result for a model its vendor's own API also serves under its name: the name says which weights
 * they are only on a self-hosted backend, and every hosted API gets the estimate.
 * @param {string} source
 * @returns {MapResult}
 */
const onSelfHostedOnly = source => ({ byBackend: { other: { source } } });

/**
 * A Mistral model's result. Mistral's own API reads the native file (`tokenizer.model.v*` or
 * `tekken.json`); the repo's HF `tokenizer.json` gives other ids. Every other backend gets none: which
 * of the two files it reads is unknowable.
 * @param {MapResult} native
 * @param {string} [hfSource] The registry entry of the repo's `tokenizer.json`, where it has one
 * @returns {MapResult}
 */
const onMistralApi = (native, hfSource) => ({
    byBackend: { vendorApis: { [CHAT_COMPLETION_SOURCES.MISTRALAI]: native }, ...(hfSource ? { hf: { source: hfSource } } : {}) },
});

/**
 * Mistral's models after Mistral 7B v0.1/v0.2 and Mixtral 8x7B. A name picks one model only with its
 * date or version: undated ids and `-latest` point at different models over time. Mistral's API ids
 * `mistral-small-2409`, `mistral-tiny-2312`, `mistral-small-2312`, `mistral-tiny-2407` and
 * `open-mixtral-8x22b-2404` are left out, because Mistral's own sources name different files for them.
 * @param {string[]} tokens
 * @returns {MapMatch[] | null} null when an unknown version vetoes the name
 */
function mistralFamilyMatches(tokens) {
    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });
    /** @param {string[]} list */
    const hasAny = (...list) => list.some(token => tokens.includes(token));
    /**
     * The one size of `sizes` the name has; null for none or several.
     * @param {string[]} sizes
     */
    const onlySize = sizes => {
        const found = sizes.filter(size => tokens.includes(size));
        return found.length === 1 ? found[0] : null;
    };

    const mathstral = guardedMatch(tokens, [['mathstral']], followedByAllDigits);
    if (mathstral === 'veto') return null;

    // The v0.3 file: Mistral 7B v0.3 and Mixtral 8x22B Instruct v0.1. mistral-common gives it (as its
    // v2 file) to the closed Small 2402 and Large 2402, and mistral.model to the closed Medium 2312.
    const v03 = { source: 'mistral-7b-v0.3' };
    if ((hasSequence(tokens, ['mistral', '7b']) && hasSequence(tokens, ['v0', '3']))
        || (hasSequence(tokens, ['mixtral', '8x22b']) && hasAny('instruct') && hasSequence(tokens, ['v0', '1']))) {
        add(onMistralApi(v03, 'mistral-7b-v0.3-hf'));
    }
    if (hasSequence(tokens, ['mistral', 'small', '2402']) || hasSequence(tokens, ['mistral', 'large', '2402'])) add(onMistralApi(v03));
    if (hasSequence(tokens, ['mistral', 'medium', '2312'])) add(onMistralApi(tokenizers.MISTRAL));

    // Mathstral's file, which Mamba-Codestral, Small 2409 and Large 2407 also ship; Codestral 22B ships a
    // file with the same content. Each has its own tokenizer.json. Only the Small 2409 repo name (with
    // `instruct`) maps, not Mistral's API id.
    const mathstralFile = { source: 'mathstral' };
    const isMamba = hasSequence(tokens, ['codestral', 'mamba']) || hasSequence(tokens, ['mamba', 'codestral']);
    if (mathstral === 'match') add(onMistralApi(mathstralFile, 'mathstral-hf'));
    if (hasAny('codestral') && !isMamba && hasAny('22b', '2405')) add(onMistralApi(mathstralFile, 'codestral-22b-hf'));
    if (isMamba && hasAny('7b', '2407')) add(onMistralApi(mathstralFile, 'codestral-mamba-hf'));
    if (hasSequence(tokens, ['mistral', 'small']) && hasAny('instruct') && hasAny('2409')) add(onMistralApi(mathstralFile, 'mathstral-hf'));
    if (hasSequence(tokens, ['mistral', 'large']) && hasAny('2407')) add(onMistralApi(mathstralFile, 'mathstral-hf'));

    // Large 2411's file, which Pixtral Large also ships.
    const large2411 = { source: 'mistral-large-2411' };
    if (hasSequence(tokens, ['mistral', 'large']) && hasAny('2411')) add(onMistralApi(large2411, 'mistral-large-2411-hf'));
    if (hasSequence(tokens, ['pixtral', 'large']) && hasAny('2411')) add(onMistralApi(large2411));

    // Every official tekken.json has the content of Nemo's. Where a repo ships a tokenizer.json, it is
    // the one named; the Ministral 3 Base and Reasoning repos, and its ONNX Instruct repo, ship another
    // than its Instruct repos. `labs-` ids are Labs models, which Mistral may update silently.
    const tekken = { source: 'nemo-tekken' };
    /** @param {string} [hfSource] */
    const addTekken = hfSource => add(onMistralApi(tekken, hfSource));
    if (hasSequence(tokens, ['ministral', '8b']) && hasAny('2410')) addTekken('ministral-8b-2410-hf');
    if (hasAny('ministral') && hasAny('2512') && onlySize(['3b', '8b', '14b'])) {
        const variants = ['instruct', 'base', 'reasoning'].filter(variant => tokens.includes(variant));
        if (variants.length === 0) {
            addTekken();
        } else if (variants.length === 1) {
            addTekken(variants[0] === 'instruct' && !hasAny('onnx') ? 'ministral-3-instruct-hf' : 'ministral-3-base-hf');
        }
    }
    if (hasSequence(tokens, ['mistral', 'small'])) {
        if (hasAny('2501', '2503')) addTekken('mistral-small-3-hf');
        if (hasAny('2506')) addTekken();
        if (hasAny('2603')) addTekken('mistral-small-4-hf');
    }
    if (hasSequence(tokens, ['mistral', 'medium', '3', '5']) && hasAny('128b')) addTekken('mistral-small-4-hf');
    if (hasSequence(tokens, ['mistral', 'large']) && hasAny('2512')) addTekken('ministral-3-base-hf');
    if (hasSequence(tokens, ['pixtral', '12b']) && hasAny('2409')) addTekken();
    if (hasSequence(tokens, ['magistral', 'small']) && hasAny('2506', '2507', '2509')) addTekken();
    if (hasAny('devstral') && !hasAny('labs', 'medium')) {
        if (hasAny('small') && hasAny('2505', '2507')) addTekken();
        if (hasAny('2512')) addTekken('ministral-3-instruct-hf');
    }
    if (hasAny('voxtral') && ((hasAny('small') && hasAny('2507')) || (hasSequence(tokens, ['mini', '3b']) && hasAny('2507'))
        || (hasAny('realtime') && hasAny('2602')) || (hasAny('tts') && hasAny('2603')))) {
        addTekken();
    }
    if (hasAny('leanstral') && !hasAny('labs') && (hasAny('2603') || (hasSequence(tokens, ['leanstral', '1', '5']) && hasAny('119b')))) addTekken();
    if (hasSequence(tokens, ['shieldstral', '1', '0'])) addTekken('shieldstral-hf');

    // Nemo: Mistral's API reads its tekken.json; nemo.json (its tokenizer.json's content) stays everywhere else.
    if (hasAny('nemo')) {
        add({ byBackend: { vendorApis: { [CHAT_COMPLETION_SOURCES.MISTRALAI]: tekken }, hf: tokenizers.NEMO, rest: tokenizers.NEMO } });
    }

    return matches;
}

/**
 * A Cohere model whose repo's HF `tokenizer.json` gives other ids than the file Cohere's API names for
 * it (its `tokenizer_url`). Cohere's API reads its own file; every other backend gets none, because
 * which of the two it reads is unknowable.
 * @param {MapResult} native
 * @param {string} hfSource The registry entry of the repo's `tokenizer.json`
 * @returns {MapResult}
 */
const onCohereApi = (native, hfSource) => ({
    byBackend: { vendorApis: { [CHAT_COMPLETION_SOURCES.COHERE]: native }, hf: { source: hfSource } },
});

/**
 * Cohere's models. Where Cohere's file and the repo's give the same ids, one file serves every backend.
 * A name picks one model only with its date, version or size: `command-r7b`, `c4ai-aya-23`, `tiny-aya`
 * and `north-mini-code` alone name none, and `command`, `command-light` and the `-nightly` ids point at
 * different models over time.
 * @param {string[]} tokens
 * @returns {MapMatch[] | null} null when an unknown version vetoes the name
 */
function cohereFamilyMatches(tokens) {
    for (const sequence of [['aya', 'vision'], ['aya', 'expanse'], ['tiny', 'aya']]) {
        if (guardedMatch(tokens, [sequence], followedByAllDigits) === 'veto') return null;
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

    // command-r.json's content: Command R and R+, Aya 23 and Aya Expanse. Command R 08-2024's own
    // tokenizer.json adds <|NEW_FILE|> and four FIM tokens, which Cohere's file for it lacks.
    const isCommandR0824 = hasSequence(tokens, ['command', 'r', '08', '2024']);
    if (hasSequence(tokens, ['command', 'r']) && !isCommandR0824) add(tokenizers.COMMAND_R);
    if (isCommandR0824) add(onCohereApi(tokenizers.COMMAND_R, 'command-r-08-2024-hf'));
    if (hasSequence(tokens, ['aya', '23']) && onlySize(['8b', '35b'])) add(tokenizers.COMMAND_R);
    if (hasSequence(tokens, ['aya', 'expanse']) && onlySize(['8b', '32b'])) add(tokenizers.COMMAND_R);

    // command-a.json's content: Command A (Reasoning, Translate) and Command R7B, not Command A Vision or A+.
    if (findSequence(tokens, ['command', 'a']).some(start => !['vision', 'plus'].includes(tokens[start + 2]))) {
        add(tokenizers.COMMAND_A);
    }
    if (hasSequence(tokens, ['command', 'r7b', '12', '2024']) || hasSequence(tokens, ['command', 'r7b', 'arabic', '02', '2025'])) {
        add(tokenizers.COMMAND_A);
    }

    // Command A Vision's file: command-a.json's content plus four image tokens. Aya Vision 8B's has its content.
    const ayaVisionSize = hasSequence(tokens, ['aya', 'vision']) ? onlySize(['8b', '32b']) : null;
    if (hasSequence(tokens, ['command', 'a', 'vision', '07', '2025']) || ayaVisionSize === '8b') add({ source: 'command-a-vision' });
    if (ayaVisionSize === '32b') add(onCohereApi({ source: 'aya-vision-32b' }, 'aya-vision-32b-hf'));

    // Command A+ and North Mini Code 1.0 ship one file.
    if (hasSequence(tokens, ['command', 'a', 'plus', '05', '2026']) || hasSequence(tokens, ['north', 'mini', 'code', '1', '0'])) {
        add({ source: 'command-a-plus' });
    }

    // Tiny Aya Global, Earth, Fire, Water, Base 32K and the L2 and EN Thinkers ship one file; Tiny Aya
    // Base's lacks its eight <|START_RESPONSE|> … <|END_THINKING|> tokens.
    for (const start of findSequence(tokens, ['tiny', 'aya'])) {
        const [variant, next] = tokens.slice(start + 2, start + 4);
        if (['global', 'earth', 'fire', 'water'].includes(variant) || (variant === 'base' && next === '32k')
            || (['l2', 'en'].includes(variant) && next === 'thinker')) {
            add({ source: 'tiny-aya' });
        } else if (variant === 'base') {
            add({ source: 'tiny-aya-base' });
        }
    }

    return matches;
}

/**
 * Z.ai's GLM models. Z.ai's API serves GLM-4.5 (Air, V), 4.6 (V, V-Flash), 4.7 (Flash), 5, 5.1, 5.2,
 * 5.3 (Flash) and GLM-4-32B-0414 under their names, so those names apply on self-hosted backends only;
 * the base models and the models it doesn't serve apply everywhere. Its API-only ids (`-x`, `-airx`,
 * `-flashx`, `-turbo`, `-plus`, `-long`, `glm-4.5-flash`) name no open weights. LongWriter, LongCite
 * and LongReward GLM-4-9B encode GLM-4's special-token text as ordinary text, and WebRL GLM-4-9B's code
 * fails to encode with the reference transformers, so none of them is mapped.
 * @param {string[]} tokens
 * @returns {MapMatch[] | null} null when an unknown version vetoes the name
 */
function glmFamilyMatches(tokens) {
    if (guardedMatch(tokens, [['glm', '4']], rest => followedByAllDigits(rest) && !['5', '6', '7'].includes(rest[0])) === 'veto') return null;
    if (guardedMatch(tokens, [['glm', '5']], rest => followedByAllDigits(rest) && !['1', '2', '3'].includes(rest[0])) === 'veto') return null;
    if (['x', 'airx', 'flashx', 'turbo', 'plus', 'long'].some(token => tokens.includes(token))) return [];

    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });
    /** @param {string} source */
    const servedByZai = source => add(tokens.includes('base') ? { source } : onSelfHostedOnly(source));
    const hasFlash = tokens.includes('flash');

    // GLM-4-0414's file: GLM-4-9B-0414, GLM-4-32B(-Base)-0414, GLM-Z1 and GLM-4.1V-9B. The GLM-4-9B repos
    // (2024, Ollama's `glm4:9b`), GLM-4V-9B and GLM-4-Voice-9B ship files with its content.
    if (tokens.includes('0414') && hasSequence(tokens, ['glm', '4', '32b'])) servedByZai('glm-4-0414');
    if (tokens.includes('0414') && hasSequence(tokens, ['glm', '4', '9b'])) add({ source: 'glm-4-0414' });
    if (tokens.includes('0414') && (hasSequence(tokens, ['glm', 'z1', '9b']) || hasSequence(tokens, ['glm', 'z1', '32b'])
        || hasSequence(tokens, ['glm', 'z1', 'rumination', '32b']))) {
        add({ source: 'glm-4-0414' });
    }
    if (hasSequence(tokens, ['glm', '4', '1v', '9b'])) add({ source: 'glm-4-0414' });
    const isGlm4Research = ['longwriter', 'longcite', 'longreward', 'webrl'].some(token => tokens.includes(token));
    if (!tokens.includes('0414') && !isGlm4Research && (hasSequence(tokens, ['glm', '4', '9b']) || hasSequence(tokens, ['glm4', '9b'])
        || hasSequence(tokens, ['glm', '4v', '9b']) || hasSequence(tokens, ['glm', '4', 'voice', '9b']))) {
        add({ source: 'glm-4-0414' });
    }

    // GLM-4.5's file: GLM-4.5 (Air, V, Base), 4.6 (V, V-Flash) and 4.7.
    if (hasSequence(tokens, ['glm', '4', '5']) && !hasFlash) servedByZai('glm-4.5');
    if (hasSequence(tokens, ['glm', '4', '5v']) || hasSequence(tokens, ['glm', '4', '6']) || hasSequence(tokens, ['glm', '4', '6v'])
        || (hasSequence(tokens, ['glm', '4', '7']) && !hasFlash)) {
        servedByZai('glm-4.5');
    }

    // GLM-5's file: GLM-4.7-Flash, GLM-5, 5.1, 5.2 and 5.3 (Flash).
    if (hasSequence(tokens, ['glm', '4', '7', 'flash']) || hasSequence(tokens, ['glm', '5'])) servedByZai('glm-5');

    // GLM-Edge 1.5B and 4B Chat and GLM-Edge-V 2B and 5B ship one file.
    if ([['glm', 'edge', '1', '5b'], ['glm', 'edge', '4b'], ['glm', 'edge', 'v', '2b'], ['glm', 'edge', 'v', '5b']].some(sequence => hasSequence(tokens, sequence))) {
        add({ source: 'glm-edge' });
    }

    // AutoGLM-Phone-9B and its Multilingual repo ship one file.
    if (hasSequence(tokens, ['autoglm', 'phone', '9b'])) add({ source: 'autoglm-phone' });

    return matches;
}

/**
 * Moonshot's Kimi and Moonlight models. Every repo ships one tiktoken.model; each model's code and
 * tokenizer_config.json make its tokenizer. Moonshot's API serves Kimi K2.6, K2.7 Code and K3 under
 * their names, so those names apply on self-hosted backends only. Bare `kimi-k2` and the `-turbo`
 * ids name no one model, and Kimi-Audio's code fails to load with the reference transformers.
 * @param {string[]} tokens
 * @returns {MapMatch[] | null} null when an unknown version vetoes the name
 */
function kimiFamilyMatches(tokens) {
    if (guardedMatch(tokens, [['kimi', 'k2']], rest => followedByAllDigits(rest) && !['5', '6', '7', '0905'].includes(rest[0])) === 'veto') return null;
    if (guardedMatch(tokens, [['kimi', 'k3']], followedByAllDigits) === 'veto') return null;
    if (tokens.includes('turbo')) return [];

    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });

    // Kimi K2 Instruct and Instruct 0905 and Kimi-Linear ship one tokenizer; K2 Base encodes special-token
    // text as text; K2 Thinking adds <think>; K2.5, K2.6 and K2.7 Code add the media tokens too.
    if (hasSequence(tokens, ['kimi', 'k2', 'instruct']) || hasSequence(tokens, ['kimi', 'k2', '0905'])) add({ source: 'kimi' });
    if (hasSequence(tokens, ['kimi', 'linear', '48b'])) add({ source: 'kimi' });
    if (hasSequence(tokens, ['kimi', 'k2', 'base'])) add({ source: 'kimi-k2-base' });
    if (hasSequence(tokens, ['kimi', 'k2', 'thinking'])) add({ source: 'kimi-k2-thinking' });
    if (hasSequence(tokens, ['kimi', 'k2', '5'])) add({ source: 'kimi-k2.5' });
    if (hasSequence(tokens, ['kimi', 'k2', '6']) || hasSequence(tokens, ['kimi', 'k2', '7', 'code'])) add(onSelfHostedOnly('kimi-k2.5'));
    if (hasSequence(tokens, ['kimi', 'k3'])) add(onSelfHostedOnly('kimi-k3'));

    // Kimi-VL-A3B (Instruct, Thinking) and Moonlight-16B-A3B read it with tokenization_moonshot.py.
    if (hasSequence(tokens, ['kimi', 'vl', 'a3b']) && ['instruct', 'thinking'].some(token => tokens.includes(token))) add({ source: 'kimi-vl' });
    if (hasSequence(tokens, ['moonlight', '16b', 'a3b'])) add({ source: 'moonlight' });

    // Kimi-Dev-72B ships the Qwen2.5 file.
    if (hasSequence(tokens, ['kimi', 'dev', '72b'])) add({ source: 'qwen2.5' });

    return matches;
}

/**
 * MiniMax's models. MiniMax's API serves M2, M2.1, M2.5, M2.7 and M3 under their names, so those names
 * apply on self-hosted backends only. M2-her is its own model.
 * @param {string[]} tokens
 * @returns {MapMatch[] | null} null when an unknown version vetoes the name
 */
function minimaxFamilyMatches(tokens) {
    if (guardedMatch(tokens, [['minimax', 'm1'], ['minimax', 'm3']], followedByAllDigits) === 'veto') return null;
    if (guardedMatch(tokens, [['minimax', 'm2']], rest => followedByAllDigits(rest) && !['1', '5', '7'].includes(rest[0])) === 'veto') return null;

    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });

    // MiniMax-Text-01 and MiniMax-VL-01 ship one file.
    if (hasSequence(tokens, ['minimax', 'text', '01']) || hasSequence(tokens, ['minimax', 'vl', '01'])) add({ source: 'minimax-text-01' });
    if (hasSequence(tokens, ['minimax', 'm1'])) add({ source: 'minimax-m1' });
    if (hasSequence(tokens, ['minimax', 'm2']) && !tokens.includes('her')) add(onSelfHostedOnly('minimax-m2'));
    if (hasSequence(tokens, ['minimax', 'm3'])) add(onSelfHostedOnly('minimax-m3'));

    return matches;
}

/**
 * gpt-oss 20B and 120B and gpt-oss-safeguard ship one tokenizer.json. OpenAI's API documents
 * `gpt-oss-20b` and `gpt-oss-120b` as its model ids, so those names apply on self-hosted backends only.
 * tiktoken 1.0.22 doesn't know them; the entry wins over the tiktoken lookup should it learn them.
 * @param {string[]} tokens
 * @returns {MapMatch[] | null} null when an unknown version vetoes the name
 */
function gptOssMatches(tokens) {
    if (guardedMatch(tokens, [['gpt', 'oss']], followedByAllDigits) === 'veto') return null;
    const sizes = ['20b', '120b'].filter(size => tokens.includes(size));
    if (!hasSequence(tokens, ['gpt', 'oss']) || sizes.length !== 1) return [];
    const result = tokens.includes('safeguard') ? { source: 'gpt-oss' } : onSelfHostedOnly('gpt-oss');
    return [{ result, supersedes: ['tiktoken'] }];
}

/**
 * Which Phi-4 model a name is, by the variant words it has; any other set of them names no one model.
 * Microsoft's API serves Phi-4, Phi-4-mini-instruct, Phi-4-mini-reasoning, Phi-4-multimodal-instruct and
 * Phi-4-reasoning under their names, so those names apply on self-hosted backends only.
 * @type {Record<string, { source: string, servedByMicrosoft: boolean }>}
 */
const PHI_4_VARIANTS = {
    '': { source: 'phi-4', servedByMicrosoft: true },
    'mini': { source: 'phi-4-mini', servedByMicrosoft: true },
    'mini reasoning': { source: 'phi-4-mini', servedByMicrosoft: true },
    'mini flash reasoning': { source: 'phi-4-mini', servedByMicrosoft: false },
    'multimodal': { source: 'phi-4-multimodal', servedByMicrosoft: true },
    'reasoning': { source: 'phi-4-reasoning', servedByMicrosoft: true },
    'reasoning plus': { source: 'phi-4-reasoning', servedByMicrosoft: false },
    'reasoning vision': { source: 'phi-4-reasoning-vision', servedByMicrosoft: false },
};

/**
 * Microsoft's Phi models. Phi-3 and Phi-3.5 mini, medium and MoE get the bundled llama.model, their
 * tokenizer.model, though their tokenizer.json gives other ids: it reads `<s>`, `<|user|>` and the like
 * as special tokens. `phi3` and `phi4` are Ollama's forms (`phi3:mini`, `phi3.5`, `phi4-mini`).
 * @param {string[]} tokens
 * @returns {MapMatch[] | null} null when an unknown version vetoes the name
 */
function phiFamilyMatches(tokens) {
    if (guardedMatch(tokens, [['phi', '1']], rest => followedByAllDigits(rest) && rest[0] !== '5') === 'veto') return null;
    if (guardedMatch(tokens, [['phi', '2']], followedByAllDigits) === 'veto') return null;
    const phi3 = guardedMatch(tokens, [['phi', '3'], ['phi3']], rest => followedByAllDigits(rest) && rest[0] !== '5');
    if (phi3 === 'veto') return null;
    const phi4 = guardedMatch(tokens, [['phi', '4'], ['phi4']], followedByAllDigits);
    if (phi4 === 'veto') return null;

    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });
    /** @param {string[]} list */
    const hasAny = (...list) => list.some(token => tokens.includes(token));

    // Phi-1, Phi-1.5 and Phi-2 ship one file; Dolphin's Phi-2 ships another.
    if ((hasSequence(tokens, ['phi', '1']) || hasSequence(tokens, ['phi', '2'])) && !hasAny('dolphin')) add({ source: 'phi-1' });

    if (phi3 === 'match') {
        const isPhi35 = hasSequence(tokens, ['phi', '3', '5']) || hasSequence(tokens, ['phi3', '5']);
        if (hasAny('small')) {
            // Phi-3-small 8k and 128k read one tiktoken file with their code; there is no Phi-3.5-small.
            if (!isPhi35) add({ source: 'phi-3-small' });
        } else if (hasAny('vision')) {
            // Phi-3-vision and Phi-3.5-vision ship files with one content; the Phi-3-vision ONNX CPU,
            // CUDA and DirectML repos ship another, with other added tokens.
            if (!(hasAny('onnx') && hasAny('cpu', 'cuda', 'directml'))) add({ source: 'phi-3-vision' });
        } else if (isPhi35 && hasAny('mini') && hasAny('onnx')) {
            // The Phi-3.5-mini ONNX repo ships no tokenizer.model, only files with Phi-3's tokenizer.json content.
            add({ source: 'phi-3-hf' });
        } else {
            add(tokenizers.LLAMA);
        }
    }
    // Phi-Ground ships a file with Phi-3-vision's content; Phi-mini-MoE and Phi-tiny-MoE ship Phi-3's tokenizer.json.
    if (hasSequence(tokens, ['phi', 'ground'])) add({ source: 'phi-3-vision' });
    if (hasSequence(tokens, ['phi', 'mini', 'moe']) || hasSequence(tokens, ['phi', 'tiny', 'moe'])) add({ source: 'phi-3-hf' });

    if (phi4 === 'match') {
        const variant = PHI_4_VARIANTS[['mini', 'flash', 'multimodal', 'reasoning', 'plus', 'vision'].filter(token => tokens.includes(token)).join(' ')];
        // paza-Phi-4-multimodal-instruct ships Phi-4-multimodal's file; Microsoft's API doesn't serve it.
        if (variant) add(variant.servedByMicrosoft && !hasAny('paza') ? onSelfHostedOnly(variant.source) : { source: variant.source });
    }

    return matches;
}

/**
 * NVIDIA's Nemotron models, and NVIDIA's models built on other families, which ship those families'
 * files. A Llama-based name gets the Llama 3.x file its repo ships, whatever version its name says.
 * NVIDIA's API serves Llama-3.1-Nemotron-51B-Instruct, -70B-Instruct, -Ultra-253B-v1 and
 * -Safety-Guard-8B-v3, Nemotron-4-340B-Instruct and -Reward, Nemotron 3 Nano 30B-A3B, Super and Ultra,
 * Nemotron 3.5 Lightning and Nemotron 3.5 Content Safety under their names, so those names apply on
 * self-hosted backends only.
 * @param {string[]} tokens
 * @returns {MapMatch[] | null} null when an unknown version vetoes the name
 */
function nemotronFamilyMatches(tokens) {
    if (!tokens.includes('nemotron') && !tokens.includes('minitron')) return [];
    if (guardedMatch(tokens, [['nemotron', '3']], rest => followedByAllDigits(rest) && rest[0] !== '5') === 'veto') return null;
    if (guardedMatch(tokens, [['nemotron', '4']], followedByAllDigits) === 'veto') return null;

    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });
    /** @param {string[]} list */
    const hasAny = (...list) => list.some(token => tokens.includes(token));
    /**
     * The one size of `sizes` the name has; null for none or several.
     * @param {string[]} sizes
     */
    const onlySize = sizes => {
        const found = sizes.filter(size => tokens.includes(size));
        return found.length === 1 ? found[0] : null;
    };
    /** @param {boolean} servedByNvidia @param {MapResult} result */
    const addServed = (servedByNvidia, result) => add(servedByNvidia ? { byBackend: { other: result } } : result);
    const isLlama31Nemotron = hasSequence(tokens, ['llama', '3', '1', 'nemotron']);

    // Llama 3.1 Instruct's file: every Llama-3.1- and Llama-3.3-Nemotron-70B (Ollama's `nemotron:70b` is
    // the 3.1 Instruct model), and Llama-3.1-Minitron-4B. The 70B Instruct's NeMo repo names Meta's
    // Llama-3.1-70B-Instruct tokenizer.
    if (hasSequence(tokens, ['nemotron', '70b'])) {
        const isInstruct = !hasSequence(tokens, ['llama', '3', '3']) && !hasAny('reward', 'edit', 'feedback', 'select');
        addServed(isInstruct, { source: 'llama3.1' });
    }
    if (hasSequence(tokens, ['llama', '3', '1', 'minitron', '4b'])) add({ source: 'llama3.1' });

    // Llama 3.3's file: Llama-3.1-Nemotron-Nano 4B and 8B, Ultra-253B, 8B-UltraLong and Safety-Guard-8B-v3,
    // and Llama-3.3-Nemotron-Super-49B. The Ultra-253B-v1 and Super-49B-v1 FP8 repos' files add only a
    // 512-token truncation.
    if (isLlama31Nemotron && hasAny('nano') && !hasAny('vl') && onlySize(['4b', '8b'])) add({ source: 'llama3.3' });
    if (hasSequence(tokens, ['llama', '3', '1', 'nemotron', 'ultra', '253b'])) addServed(!hasAny('cpt'), { source: 'llama3.3' });
    if (hasSequence(tokens, ['llama', '3', '1', 'nemotron', '8b', 'ultralong'])) add({ source: 'llama3.3' });
    if (hasSequence(tokens, ['llama', '3', '1', 'nemotron', 'safety', 'guard', '8b', 'v3'])) addServed(true, { source: 'llama3.3' });
    if (hasSequence(tokens, ['llama', '3', '3', 'nemotron', 'super', '49b'])) add({ source: 'llama3.3' });

    // Llama-3.1-Nemotron-51B and Nano-VL-8B ship their own; the Nano-VL mcore repo ships none.
    if (hasSequence(tokens, ['llama', '3', '1', 'nemotron', '51b'])) addServed(true, { source: 'llama-3.1-nemotron-51b' });
    if (hasSequence(tokens, ['llama', '3', '1', 'nemotron', 'nano', 'vl', '8b']) && !hasAny('mcore')) add({ source: 'llama-3.1-nemotron-nano-vl' });

    // Nemotron-4-340B's .nemo checkpoints read one sentencepiece file. Nemotron-Mini-4B, Minitron-4B and
    // -8B and Nemotron-4-Mini-Hindi-4B ship it with a tokenizer.json that gives other ids.
    if (hasSequence(tokens, ['nemotron', '4', '340b'])) addServed(!hasAny('base'), { source: 'nemotron-4' });

    // Nemotron-H and Nemotron Nano 9B and 12B v2 ship one file; Nano 12B v2 VL adds its image tokens.
    // Nemotron-Flash ships nemo.json's content.
    if (hasSequence(tokens, ['nemotron', 'h']) && onlySize(['4b', '8b', '47b', '56b'])) add({ source: 'nemotron-h' });
    if (hasSequence(tokens, ['nemotron', 'nano']) && hasAny('v2') && onlySize(['9b', '12b'])) {
        if (!hasAny('vl')) add({ source: 'nemotron-h' });
        else if (hasAny('12b')) add({ source: 'nemotron-nano-12b-v2-vl' });
    }
    if (hasSequence(tokens, ['nemotron', 'elastic', '12b'])) add({ source: 'nemotron-h' });
    if (hasSequence(tokens, ['nemotron', 'flash']) && onlySize(['1b', '3b'])) add(tokenizers.NEMO);

    // Nemotron 3 Nano, Super and Ultra, Nemotron 3.5 Lightning, Nemotron-Cascade-2 and the Nemotron Labs
    // models built on them ship files with one content. Nemotron 3 Nano Omni, Embed and Content Safety,
    // and the Labs Diffusion VLM, ship others; so do the 2023 Nemotron-3-8B models.
    if (!hasAny('omni', 'embed', 'content', 'vlm', 'audex', 'mtpv2', 'dflash', 'dspark')) {
        const isBase = hasAny('base', 'genrm');
        const nano = hasSequence(tokens, ['nemotron', '3', 'nano']) || hasSequence(tokens, ['nemotron', 'nano', '3']);
        if (nano && (onlySize(['4b', '30b']) || !hasAny('4b', '30b'))) addServed(!hasAny('4b') && !isBase, { source: 'nemotron-3' });
        if (hasSequence(tokens, ['nemotron', '3', 'super']) || hasSequence(tokens, ['nemotron', '3', 'ultra'])
            || hasSequence(tokens, ['nemotron', '3', '5', 'lightning'])) {
            addServed(!isBase, { source: 'nemotron-3' });
        }
        if (hasSequence(tokens, ['nemotron', 'cascade', '2'])
            || hasSequence(tokens, ['nemotron', 'labs', '3', 'elastic']) || hasSequence(tokens, ['nemotron', 'labs', '3', 'puzzle'])
            || hasSequence(tokens, ['nemotron', 'labs', 'teacher']) || hasSequence(tokens, ['nemotron', 'labs', 'diffusion'])
            || hasSequence(tokens, ['nemotron', 'labs', 'twotower']) || hasSequence(tokens, ['nemotron', '3', 'labs', 'ultra', 'math'])) {
            add({ source: 'nemotron-3' });
        }
    }

    // Nemotron Content Safety models ship Gemma 3 -it's files.
    if (hasSequence(tokens, ['nemotron', '3', 'content', 'safety']) || hasSequence(tokens, ['nemotron', 'content', 'safety', 'reasoning', '4b'])) {
        add({ source: 'gemma-3-it' });
    }
    if (hasSequence(tokens, ['nemotron', '3', '5', 'content', 'safety'])) addServed(true, { source: 'gemma-3-it' });

    // Qwen2.5's file: OpenCodeReasoning-, OpenMath- and OpenReasoning-Nemotron. DeepSeek-R1-Distill-Qwen's
    // content: AceReason-Nemotron, AceMath-RL-Nemotron and Nemotron-Research-Reasoning-Qwen; AceReason-Nemotron-1.1
    // ships its own. Qwen3's file: Nemotron-Cascade (not Cascade-2), Terminal, Orchestrator and GooseReason.
    if (['opencodereasoning', 'openmath', 'openreasoning'].some(family => hasSequence(tokens, [family, 'nemotron']))) add({ source: 'qwen2.5' });
    for (const start of findSequence(tokens, ['acereason', 'nemotron'])) {
        const [major, minor] = tokens.slice(start + 2, start + 4);
        if (major === '1' && minor === '1' && hasAny('7b')) add({ source: 'acereason-nemotron-1.1' });
        else if (!ALL_DIGITS.test(major ?? '') && onlySize(['7b', '14b'])) add({ source: 'deepseek-r1-distill-qwen' });
    }
    if (hasSequence(tokens, ['acemath', 'rl', 'nemotron', '7b']) || hasSequence(tokens, ['nemotron', 'research', 'reasoning', 'qwen', '1', '5b'])) {
        add({ source: 'deepseek-r1-distill-qwen' });
    }
    if ((findSequence(tokens, ['nemotron', 'cascade']).some(start => tokens[start + 2] !== '2') && onlySize(['8b', '14b']))
        || (hasSequence(tokens, ['nemotron', 'terminal']) && onlySize(['8b', '14b', '32b']))
        || hasSequence(tokens, ['nemotron', 'orchestrator', '8b'])
        || hasSequence(tokens, ['nemotron', 'research', 'goosereason', '4b'])) {
        add({ source: 'qwen3' });
    }

    return matches;
}

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

    // A Nemotron name gets the file its NVIDIA repo ships (nemotronFamilyMatches), whatever Llama version it names.
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

    const mistralMatches = mistralFamilyMatches(tokens);
    if (mistralMatches === null) return null;
    matches.push(...mistralMatches);

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

    const cohereMatches = cohereFamilyMatches(tokens);
    if (cohereMatches === null) return null;
    matches.push(...cohereMatches);

    for (const familyMatches of [glmFamilyMatches, kimiFamilyMatches, minimaxFamilyMatches, gptOssMatches, phiFamilyMatches, nemotronFamilyMatches]) {
        const found = familyMatches(tokens);
        if (found === null) return null;
        matches.push(...found);
    }

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
    const { vendorApis = {}, hf, other, rest } = result.byBackend;
    const parts = Object.keys(vendorApis).sort().map(source => `${source}=${mapResultKey(vendorApis[source])}`);
    if (hf !== undefined) {
        parts.push(`hf=${mapResultKey(hf)}`);
    }
    if (other !== undefined) {
        parts.push(`other=${mapResultKey(other)}`);
    }
    if (rest !== undefined) {
        parts.push(`rest=${mapResultKey(rest)}`);
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
