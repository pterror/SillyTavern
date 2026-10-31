import tiktoken from 'tiktoken';

import { CHAT_COMPLETION_SOURCES } from './constants.js';
import { tokenizers, TOKENIZER_TYPE_KEYS } from './tokenizer-ids.js';

/** @typedef {number | string | { source: string } | { byBackend: { vendorApis?: Record<string, MapResult>, hf?: MapResult, other?: MapResult, rest?: MapResult } }} MapResult */

/** @typedef {{ result: MapResult, supersedes?: string[] }} MapMatch */

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
 * @param {string} source
 * @returns {MapResult}
 */
const onSelfHostedOnly = source => ({ byBackend: { other: { source } } });

/**
 * @param {MapResult} native
 * @param {string} [hfSource]
 * @returns {MapResult}
 */
const onMistralApi = (native, hfSource) => ({
    byBackend: { vendorApis: { [CHAT_COMPLETION_SOURCES.MISTRALAI]: native }, ...(hfSource ? { hf: { source: hfSource } } : {}) },
});

/**
 * @param {string[]} tokens
 * @returns {MapMatch[] | null}
 */
function mistralFamilyMatches(tokens) {
    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });
    /** @param {string[]} list */
    const hasAny = (...list) => list.some(token => tokens.includes(token));
    /**
     * @param {string[]} sizes
     */
    const onlySize = sizes => {
        const found = sizes.filter(size => tokens.includes(size));
        return found.length === 1 ? found[0] : null;
    };

    const mathstral = guardedMatch(tokens, [['mathstral']], followedByAllDigits);
    if (mathstral === 'veto') return null;

    const v03 = { source: 'mistral-7b-v0.3' };
    if ((hasSequence(tokens, ['mistral', '7b']) && hasSequence(tokens, ['v0', '3']))
        || (hasSequence(tokens, ['mixtral', '8x22b']) && hasAny('instruct') && hasSequence(tokens, ['v0', '1']))) {
        add(onMistralApi(v03, 'mistral-7b-v0.3-hf'));
    }
    if (hasSequence(tokens, ['mistral', 'small', '2402']) || hasSequence(tokens, ['mistral', 'large', '2402'])) add(onMistralApi(v03));
    if (hasSequence(tokens, ['mistral', 'medium', '2312'])) add(onMistralApi(tokenizers.MISTRAL));

    const mathstralFile = { source: 'mathstral' };
    const isMamba = hasSequence(tokens, ['codestral', 'mamba']) || hasSequence(tokens, ['mamba', 'codestral']);
    if (mathstral === 'match') add(onMistralApi(mathstralFile, 'mathstral-hf'));
    if (hasAny('codestral') && !isMamba && hasAny('22b', '2405')) add(onMistralApi(mathstralFile, 'codestral-22b-hf'));
    if (isMamba && hasAny('7b', '2407')) add(onMistralApi(mathstralFile, 'codestral-mamba-hf'));
    if (hasSequence(tokens, ['mistral', 'small']) && hasAny('instruct') && hasAny('2409')) add(onMistralApi(mathstralFile, 'mathstral-hf'));
    if (hasSequence(tokens, ['mistral', 'large']) && hasAny('2407')) add(onMistralApi(mathstralFile, 'mathstral-hf'));

    const large2411 = { source: 'mistral-large-2411' };
    if (hasSequence(tokens, ['mistral', 'large']) && hasAny('2411')) add(onMistralApi(large2411, 'mistral-large-2411-hf'));
    if (hasSequence(tokens, ['pixtral', 'large']) && hasAny('2411')) add(onMistralApi(large2411));

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

    if (hasAny('nemo')) {
        add({ byBackend: { vendorApis: { [CHAT_COMPLETION_SOURCES.MISTRALAI]: tekken }, hf: tokenizers.NEMO, rest: tokenizers.NEMO } });
    }

    return matches;
}

/**
 * @param {MapResult} native
 * @param {string} hfSource
 * @returns {MapResult}
 */
const onCohereApi = (native, hfSource) => ({
    byBackend: { vendorApis: { [CHAT_COMPLETION_SOURCES.COHERE]: native }, hf: { source: hfSource } },
});

/**
 * @param {string[]} tokens
 * @returns {MapMatch[] | null}
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
     * @param {string[]} sizes
     */
    const onlySize = sizes => {
        const found = sizes.filter(size => tokens.includes(size));
        return found.length === 1 ? found[0] : null;
    };

    const isCommandR0824 = hasSequence(tokens, ['command', 'r', '08', '2024']);
    if (hasSequence(tokens, ['command', 'r']) && !isCommandR0824) add(tokenizers.COMMAND_R);
    if (isCommandR0824) add(onCohereApi(tokenizers.COMMAND_R, 'command-r-08-2024-hf'));
    if (hasSequence(tokens, ['aya', '23']) && onlySize(['8b', '35b'])) add(tokenizers.COMMAND_R);
    if (hasSequence(tokens, ['aya', 'expanse']) && onlySize(['8b', '32b'])) add(tokenizers.COMMAND_R);

    if (findSequence(tokens, ['command', 'a']).some(start => !['vision', 'plus'].includes(tokens[start + 2]))) {
        add(tokenizers.COMMAND_A);
    }
    if (hasSequence(tokens, ['command', 'r7b', '12', '2024']) || hasSequence(tokens, ['command', 'r7b', 'arabic', '02', '2025'])) {
        add(tokenizers.COMMAND_A);
    }

    const ayaVisionSize = hasSequence(tokens, ['aya', 'vision']) ? onlySize(['8b', '32b']) : null;
    if (hasSequence(tokens, ['command', 'a', 'vision', '07', '2025']) || ayaVisionSize === '8b') add({ source: 'command-a-vision' });
    if (ayaVisionSize === '32b') add(onCohereApi({ source: 'aya-vision-32b' }, 'aya-vision-32b-hf'));

    if (hasSequence(tokens, ['command', 'a', 'plus', '05', '2026']) || hasSequence(tokens, ['north', 'mini', 'code', '1', '0'])) {
        add({ source: 'command-a-plus' });
    }

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
 * @param {string[]} tokens
 * @returns {MapMatch[] | null}
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

    if (hasSequence(tokens, ['glm', '4', '5']) && !hasFlash) servedByZai('glm-4.5');
    if (hasSequence(tokens, ['glm', '4', '5v']) || hasSequence(tokens, ['glm', '4', '6']) || hasSequence(tokens, ['glm', '4', '6v'])
        || (hasSequence(tokens, ['glm', '4', '7']) && !hasFlash)) {
        servedByZai('glm-4.5');
    }

    if (hasSequence(tokens, ['glm', '4', '7', 'flash']) || hasSequence(tokens, ['glm', '5'])) servedByZai('glm-5');

    if ([['glm', 'edge', '1', '5b'], ['glm', 'edge', '4b'], ['glm', 'edge', 'v', '2b'], ['glm', 'edge', 'v', '5b']].some(sequence => hasSequence(tokens, sequence))) {
        add({ source: 'glm-edge' });
    }

    if (hasSequence(tokens, ['autoglm', 'phone', '9b'])) add({ source: 'autoglm-phone' });

    return matches;
}

/**
 * @param {string[]} tokens
 * @returns {MapMatch[] | null}
 */
function kimiFamilyMatches(tokens) {
    if (guardedMatch(tokens, [['kimi', 'k2']], rest => followedByAllDigits(rest) && !['5', '6', '7', '0905'].includes(rest[0])) === 'veto') return null;
    if (guardedMatch(tokens, [['kimi', 'k3']], followedByAllDigits) === 'veto') return null;
    if (tokens.includes('turbo')) return [];

    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });

    if (hasSequence(tokens, ['kimi', 'k2', 'instruct']) || hasSequence(tokens, ['kimi', 'k2', '0905'])) add({ source: 'kimi' });
    if (hasSequence(tokens, ['kimi', 'linear', '48b'])) add({ source: 'kimi' });
    if (hasSequence(tokens, ['kimi', 'k2', 'base'])) add({ source: 'kimi-k2-base' });
    if (hasSequence(tokens, ['kimi', 'k2', 'thinking'])) add({ source: 'kimi-k2-thinking' });
    if (hasSequence(tokens, ['kimi', 'k2', '5'])) add({ source: 'kimi-k2.5' });
    if (hasSequence(tokens, ['kimi', 'k2', '6']) || hasSequence(tokens, ['kimi', 'k2', '7', 'code'])) add(onSelfHostedOnly('kimi-k2.5'));
    if (hasSequence(tokens, ['kimi', 'k3'])) add(onSelfHostedOnly('kimi-k3'));

    if (hasSequence(tokens, ['kimi', 'vl', 'a3b']) && ['instruct', 'thinking'].some(token => tokens.includes(token))) add({ source: 'kimi-vl' });
    if (hasSequence(tokens, ['moonlight', '16b', 'a3b'])) add({ source: 'moonlight' });

    if (hasSequence(tokens, ['kimi', 'dev', '72b'])) add({ source: 'qwen2.5' });

    return matches;
}

/**
 * @param {string[]} tokens
 * @returns {MapMatch[] | null}
 */
function minimaxFamilyMatches(tokens) {
    if (guardedMatch(tokens, [['minimax', 'm1'], ['minimax', 'm3']], followedByAllDigits) === 'veto') return null;
    if (guardedMatch(tokens, [['minimax', 'm2']], rest => followedByAllDigits(rest) && !['1', '5', '7'].includes(rest[0])) === 'veto') return null;

    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });

    if (hasSequence(tokens, ['minimax', 'text', '01']) || hasSequence(tokens, ['minimax', 'vl', '01'])) add({ source: 'minimax-text-01' });
    if (hasSequence(tokens, ['minimax', 'm1'])) add({ source: 'minimax-m1' });
    if (hasSequence(tokens, ['minimax', 'm2']) && !tokens.includes('her')) add(onSelfHostedOnly('minimax-m2'));
    if (hasSequence(tokens, ['minimax', 'm3'])) add(onSelfHostedOnly('minimax-m3'));

    return matches;
}

/**
 * @param {string[]} tokens
 * @returns {MapMatch[] | null}
 */
function gptOssMatches(tokens) {
    if (guardedMatch(tokens, [['gpt', 'oss']], followedByAllDigits) === 'veto') return null;
    const sizes = ['20b', '120b'].filter(size => tokens.includes(size));
    if (!hasSequence(tokens, ['gpt', 'oss']) || sizes.length !== 1) return [];
    const result = tokens.includes('safeguard') ? { source: 'gpt-oss' } : onSelfHostedOnly('gpt-oss');
    return [{ result, supersedes: ['tiktoken'] }];
}

/** @type {Record<string, { source: string, servedByMicrosoft: boolean }>} */
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
 * @param {string[]} tokens
 * @returns {MapMatch[] | null}
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

    if ((hasSequence(tokens, ['phi', '1']) || hasSequence(tokens, ['phi', '2'])) && !hasAny('dolphin')) add({ source: 'phi-1' });

    if (phi3 === 'match') {
        const isPhi35 = hasSequence(tokens, ['phi', '3', '5']) || hasSequence(tokens, ['phi3', '5']);
        if (hasAny('small')) {
            if (!isPhi35) add({ source: 'phi-3-small' });
        } else if (hasAny('vision')) {
            if (!(hasAny('onnx') && hasAny('cpu', 'cuda', 'directml'))) add({ source: 'phi-3-vision' });
        } else if (isPhi35 && hasAny('mini') && hasAny('onnx')) {
            add({ source: 'phi-3-hf' });
        } else {
            add(tokenizers.LLAMA);
        }
    }
    if (hasSequence(tokens, ['phi', 'ground'])) add({ source: 'phi-3-vision' });
    if (hasSequence(tokens, ['phi', 'mini', 'moe']) || hasSequence(tokens, ['phi', 'tiny', 'moe'])) add({ source: 'phi-3-hf' });

    if (phi4 === 'match') {
        const variant = PHI_4_VARIANTS[['mini', 'flash', 'multimodal', 'reasoning', 'plus', 'vision'].filter(token => tokens.includes(token)).join(' ')];
        if (variant) add(variant.servedByMicrosoft && !hasAny('paza') ? onSelfHostedOnly(variant.source) : { source: variant.source });
    }

    return matches;
}

/**
 * @param {string[]} tokens
 * @returns {MapMatch[] | null}
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
     * @param {string[]} sizes
     */
    const onlySize = sizes => {
        const found = sizes.filter(size => tokens.includes(size));
        return found.length === 1 ? found[0] : null;
    };
    /**
     * @param {boolean} servedByNvidia
     * @param {MapResult} result
     */
    const addServed = (servedByNvidia, result) => add(servedByNvidia ? { byBackend: { other: result } } : result);
    const isLlama31Nemotron = hasSequence(tokens, ['llama', '3', '1', 'nemotron']);

    if (hasSequence(tokens, ['nemotron', '70b'])) {
        const isInstruct = !hasSequence(tokens, ['llama', '3', '3']) && !hasAny('reward', 'edit', 'feedback', 'select');
        addServed(isInstruct, { source: 'llama3.1' });
    }
    if (hasSequence(tokens, ['llama', '3', '1', 'minitron', '4b'])) add({ source: 'llama3.1' });

    if (isLlama31Nemotron && hasAny('nano') && !hasAny('vl') && onlySize(['4b', '8b'])) add({ source: 'llama3.3' });
    if (hasSequence(tokens, ['llama', '3', '1', 'nemotron', 'ultra', '253b'])) addServed(!hasAny('cpt'), { source: 'llama3.3' });
    if (hasSequence(tokens, ['llama', '3', '1', 'nemotron', '8b', 'ultralong'])) add({ source: 'llama3.3' });
    if (hasSequence(tokens, ['llama', '3', '1', 'nemotron', 'safety', 'guard', '8b', 'v3'])) addServed(true, { source: 'llama3.3' });
    if (hasSequence(tokens, ['llama', '3', '3', 'nemotron', 'super', '49b'])) add({ source: 'llama3.3' });

    if (hasSequence(tokens, ['llama', '3', '1', 'nemotron', '51b'])) addServed(true, { source: 'llama-3.1-nemotron-51b' });
    if (hasSequence(tokens, ['llama', '3', '1', 'nemotron', 'nano', 'vl', '8b']) && !hasAny('mcore')) add({ source: 'llama-3.1-nemotron-nano-vl' });

    if (hasSequence(tokens, ['nemotron', '4', '340b'])) addServed(!hasAny('base'), { source: 'nemotron-4' });

    if (hasSequence(tokens, ['nemotron', 'h']) && onlySize(['4b', '8b', '47b', '56b'])) add({ source: 'nemotron-h' });
    if (hasSequence(tokens, ['nemotron', 'nano']) && hasAny('v2') && onlySize(['9b', '12b'])) {
        if (!hasAny('vl')) add({ source: 'nemotron-h' });
        else if (hasAny('12b')) add({ source: 'nemotron-nano-12b-v2-vl' });
    }
    if (hasSequence(tokens, ['nemotron', 'elastic', '12b'])) add({ source: 'nemotron-h' });
    if (hasSequence(tokens, ['nemotron', 'flash']) && onlySize(['1b', '3b'])) add(tokenizers.NEMO);

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

    if (hasSequence(tokens, ['nemotron', '3', 'content', 'safety']) || hasSequence(tokens, ['nemotron', 'content', 'safety', 'reasoning', '4b'])) {
        add({ source: 'gemma-3-it' });
    }
    if (hasSequence(tokens, ['nemotron', '3', '5', 'content', 'safety'])) addServed(true, { source: 'gemma-3-it' });

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

/** @type {Array<[string[], (next: string) => boolean]>} */
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
 * @param {string[]} tokens
 * @returns {MapMatch[] | null}
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
     * @param {string[]} sizes
     */
    const onlySize = sizes => {
        const found = sizes.filter(size => tokens.includes(size));
        return found.length === 1 ? found[0] : null;
    };
    const hasIt = tokens.includes('it');
    const hasPt = tokens.includes('pt');
    const hasQat = tokens.includes('qat');

    if (findSequence(tokens, ['gemma']).some(start => ['1', '2', '2b', '7b', 'v1'].includes(tokens[start + 1])) || tokens.includes('gemma2')) {
        add(tokenizers.GEMMA);
    }
    if (hasSequence(tokens, ['gemma', '2', '2b', 'jpn'])) {
        matches.push({ result: { source: 'gemma-2-jpn' }, supersedes: [TOKENIZER_TYPE_KEYS[tokenizers.GEMMA]] });
    }

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
    if ((tokens.includes('medgemma') && onlySize(['4b', '27b']))
        || (tokens.includes('translategemma') && onlySize(['4b', '12b', '27b']))
        || hasSequence(tokens, ['shieldgemma', '2', '4b'])) {
        add({ source: 'gemma-3-pt' });
    }

    if (hasSequence(tokens, ['gemma', '3n']) || tokens.includes('gemma3n')) {
        const isIt = hasIt ? !hasPt : !hasPt && tokens.includes('gemma3n');
        if (onlySize(['e2b', 'e4b'])) add(isIt ? onSelfHostedOnly('gemma-3n') : { source: 'gemma-3n' });
    }

    if ((hasSequence(tokens, ['gemma', '4']) || tokens.includes('gemma4')) && !tokens.includes('coding')) {
        const size = onlySize(['e2b', 'e4b', '12b', '26b', '31b']);
        const isIt = hasIt ? !hasPt : !hasPt && tokens.includes('gemma4');
        if (size && tokens.includes('assistant')) {
            add({ source: 'gemma-4-assistant' });
        } else if (size) {
            add(isIt && !hasQat && ['26b', '31b'].includes(size) ? onSelfHostedOnly('gemma-4') : { source: 'gemma-4' });
        }
    }

    if (tokens.includes('codegemma') && onlySize(['2b', '7b'])) add({ source: 'codegemma' });

    return matches;
}

/**
 * @param {string[]} tokens
 * @returns {MapMatch[] | null}
 */
function llamaFamilyMatches(tokens) {
    tokens = tokens.flatMap((token, i) => {
        const fireworks = /^v3p(\d+)$/.exec(token);
        return fireworks && tokens[i - 1] === 'llama' ? ['3', fireworks[1]] : [token];
    });

    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });
    /**
     * @param {string[]} sizes
     */
    const onlySize = sizes => {
        const found = sizes.filter(size => tokens.includes(size));
        return found.length === 1 ? found[0] : null;
    };

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

    const minor = tokens.includes('nemotron') ? undefined : [...minors][0];
    if (minor === '1') {
        const size = onlySize(['8b', '70b', '405b']);
        const isOllamaForm = findSequence(tokens, ['llama3', '1']).length > 0;
        const isInstruct = tokens.includes('instruct') || tokens.includes('instant')
            || (isOllamaForm && !tokens.includes('text') && !tokens.includes('base'));
        const isMovedGroqId = size === '70b' && (tokens.includes('versatile') || tokens.includes('specdec'));
        const isUnknown405bBase = size === '405b' && !isInstruct && !tokens.includes('fp8');
        if (size && !isMovedGroqId && !isUnknown405bBase) {
            add({ source: isInstruct ? 'llama3.1' : 'llama3.1-base' });
        }
    }
    if (minor === '2' && !tokens.includes('vision') && ['1b', '3b'].includes(onlySize(['1b', '3b', '11b', '90b']))) {
        add({ source: 'llama3.1' });
    }
    if (minor === '3' && onlySize(['8b', '70b']) === '70b') {
        add({ source: 'llama3.3' });
    }

    const llama4 = guardedMatch(tokens, [['llama', '4'], ['llama4']], followedByAllDigits);
    if (llama4 === 'veto') return null;
    if (llama4 === 'match' && ['scout', 'maverick', '16x17b', '128x17b'].some(token => tokens.includes(token))) {
        add({ source: 'llama4' });
    }

    /** @type {Record<string, Record<string, string>>} */
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
 * @returns {MapMatch[] | null}
 */
function generalMatches(tokens, lowerName) {
    /** @type {MapMatch[]} */
    const matches = [];
    /** @param {MapResult} result */
    const add = result => matches.push({ result });

    if (hasSequence(tokens, ['llama', '2']) || hasSequence(tokens, ['llama2'])) {
        add(tokenizers.LLAMA);
    }

    const codellamaSequences = [
        ['codellama', '34b'],
        ['codellama', '7b', 'python'],
        ['codellama', '13b', 'python'],
    ];
    if (codellamaSequences.some(sequence => hasSequence(tokens, sequence))) add(tokenizers.LLAMA);

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

    let isQwen2 = false;
    for (const start of findSequence(tokens, ['qwen2'])) {
        const next = tokens[start + 1];
        if (next !== undefined && ALL_DIGITS.test(next) && next !== '5') return null;
        if (next !== '5' && next !== 'vl') isQwen2 = true;
    }
    if (isQwen2) add(tokenizers.QWEN2);

    const qwen3Version = guardedMatch(tokens, [['qwen3']], rest => followedByAllDigits(rest) && !['5', '6', '8'].includes(rest[0]));
    if (qwen3Version === 'veto') return null;

    /** @param {string} token */
    const isSizeToken = token => /^a?\d+[bt]$/.test(token);
    const picksOneQwenModel = tokens.some(isSizeToken)
        || hasSequence(tokens, ['coder', 'next'])
        || hasSequence(tokens, ['flash', 'next'])
        || tokens.includes('qvq');
    const isClosedQwen = ['plus', 'max', 'omni'].some(token => tokens.includes(token))
        || tokens.some((token, i) => token === 'flash' && tokens[i + 1] !== 'next');
    const qwenGate = !tokens.includes('deepseek') && !tokens.includes('deepseekr1') && !isClosedQwen && picksOneQwenModel;

    const hasBase = tokens.includes('base');
    const isCoderNext = hasSequence(tokens, ['coder', 'next']);
    const hasUnversionedQwen3 = findSequence(tokens, ['qwen3']).some(start => !followedByAllDigits(tokens.slice(start + 1)));
    const isOtherQwen3File = ['embedding', 'asr', 'forcedaligner', 'tts', 'omni', 'rerank'].some(token => tokens.includes(token))
        || (tokens.includes('mlx') && hasSequence(tokens, ['qwen3', '235b']));

    if (qwenGate && hasSequence(tokens, ['qwen1', '5'])) add(tokenizers.QWEN2);

    if (qwenGate && hasSequence(tokens, ['qwen2', 'vl']) && !tokens.includes('awq') && !tokens.includes('gptq')) {
        add({ source: 'qwen2-vl' });
    }

    const isQwen25File = (hasSequence(tokens, ['qwen2', '5']) && !['omni', 'prm', 'prm800k'].some(token => tokens.includes(token)))
        || hasSequence(tokens, ['qwq', '32b', 'preview'])
        || tokens.includes('qvq')
        || (hasUnversionedQwen3 && hasBase && !isCoderNext && !isOtherQwen3File);
    if (qwenGate && isQwen25File) add({ source: 'qwen2.5' });

    const isQwen3File = !isOtherQwen3File
        && ((hasUnversionedQwen3 && (!hasBase || isCoderNext)) || (tokens.includes('qwq') && !tokens.includes('preview')));
    if (qwenGate && isQwen3File) add({ source: 'qwen3' });

    const isQwen35 = hasSequence(tokens, ['qwen3', '5']);
    if (qwenGate && !hasBase && (isQwen35 || hasSequence(tokens, ['qwen3', '6']))) add({ source: 'qwen3.5' });
    if (qwenGate && hasBase && isQwen35) add({ source: 'qwen3.5-base' });

    if (qwenGate && hasSequence(tokens, ['qwen3', '8'])) add({ source: 'qwen3.8' });

    if (qwenGate && hasSequence(tokens, ['codeqwen1', '5'])) add({ source: 'codeqwen1.5' });

    const deepseekV3Version = guardedMatch(tokens, [['deepseek', 'v3']], rest => followedByAllDigits(rest) && !['0324', '1', '2'].includes(rest[0]));
    if (deepseekV3Version === 'veto') return null;
    const deepseekV4Version = guardedMatch(tokens, [['deepseek', 'v4']], rest => followedByAllDigits(rest) && rest[0] !== '1');
    if (deepseekV4Version === 'veto') return null;

    /**
     * @param {string} version
     * @param {(next: string|undefined) => boolean} isNext
     */
    const deepseekVersionFollowedBy = (version, isNext) => findSequence(tokens, ['deepseek', version]).some(start => isNext(tokens[start + 2]));
    /** @param {string|undefined} token */
    const isNumber = token => token !== undefined && ALL_DIGITS.test(token);
    const deepseekGate = !hasSequence(tokens, ['alternate', 'tokenizer'])
        && !lowerName.includes('-latest') && !tokens.includes('~deepseek');

    if (deepseekGate && deepseekVersionFollowedBy('v2', next => !isNumber(next))
        && !hasSequence(tokens, ['chat', '0628']) && !tokens.includes('coder')) {
        add({ source: 'deepseek-v2' });
    }
    if (deepseekGate && (hasSequence(tokens, ['deepseek', 'v2', '5']) || hasSequence(tokens, ['deepseek', 'v2', 'chat', '0628'])
        || hasSequence(tokens, ['deepseek', 'coder', 'v2']))) {
        add({ source: 'deepseek-v2.5' });
    }

    if (deepseekGate && deepseekVersionFollowedBy('v3', next => !isNumber(next) || next === '0324')) add(tokenizers.DEEPSEEK);
    if (deepseekGate && (hasSequence(tokens, ['deepseek', 'v3', '1']) || hasSequence(tokens, ['deepseek', 'v3', '2', 'exp']))) {
        add({ source: 'deepseek-v3.1' });
    }
    if (deepseekGate && hasSequence(tokens, ['deepseek', 'v3', '2']) && !tokens.includes('exp')
        && !hasSequence(tokens, ['speciale', 'channel', 'int8'])) {
        add({ source: 'deepseek-v3.2' });
    }

    const isDeepSeekR1 = (deepseekVersionFollowedBy('r1', next => next === 'zero' || next === '0528')
        || (hasSequence(tokens, ['deepseek', 'r1']) && tokens.includes('671b')))
        && !['distill', 'qwen', 'qwen3', 'llama'].some(token => tokens.includes(token))
        && !tokens.some(token => isSizeToken(token) && token !== '671b');
    if (deepseekGate && isDeepSeekR1) add({ source: 'deepseek-r1' });

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
        || (hasSequence(tokens, ['mixtral', '8x22b']) && hasSequence(tokens, ['v0', '1']) && !tokens.includes('instruct'));
    if (isMistralV1) add(tokenizers.MISTRAL);

    const mistralMatches = mistralFamilyMatches(tokens);
    if (mistralMatches === null) return null;
    matches.push(...mistralMatches);

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
 * @returns {MapResult|null}
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
