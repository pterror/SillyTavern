import tiktoken from 'tiktoken';

import { tokenizers } from './tokenizer-ids.js';

// Exact-only: a name the rules below don't clearly place is unmapped (null), never given a
// possibly-wrong tokenizer.

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
 * @param {string[]} tokens
 * @param {string} lowerName
 * @returns {Array<number|string> | null} null when a guard vetoes the name
 */
function generalMatches(tokens, lowerName) {
    const results = [];

    if (hasSequence(tokens, ['llama', '2']) || hasSequence(tokens, ['llama2'])) {
        results.push(tokenizers.LLAMA);
    }

    // Phi-3 and Phi-3.5 ship llama.model; Phi-3-small is cl100k and Phi-3(.5)-vision has no
    // tokenizer.model, so neither is covered.
    const phi3 = guardedMatch(tokens, [['phi', '3']], rest => followedByAllDigits(rest) && rest[0] !== '5');
    if (phi3 === 'veto') return null;
    if (phi3 === 'match' && !tokens.includes('small') && !tokens.includes('vision')) {
        results.push(tokenizers.LLAMA);
    }

    // CodeLlama 34b ships llama.model; the 7b/13b base and Instruct and the 70b files differ.
    if (hasSequence(tokens, ['codellama', '34b'])) results.push(tokenizers.LLAMA);

    const guarded = [
        [tokenizers.LLAMA3, [['llama', '3'], ['llama3']], followedByAllDigits],
        [tokenizers.GEMMA, [['gemma']], rest => rest[0] === '3' || rest[0] === '3n'],
        [tokenizers.GEMMA, [['gemma2']], () => false],
        [tokenizers.YI, [['yi']], () => false],
        [tokenizers.QWEN2, [['qwen2']], followedByAllDigits],
        [tokenizers.DEEPSEEK, [['deepseek', 'v3']], followedByAllDigits],
    ];
    for (const [result, sequences, isExcluded] of /** @type {Array<[number, string[][], (rest: string[]) => boolean]>} */ (guarded)) {
        const outcome = guardedMatch(tokens, sequences, isExcluded);
        if (outcome === 'veto') return null;
        if (outcome === 'match') results.push(result);
    }

    const isMistralV1 = (hasSequence(tokens, ['mistral', '7b'])
        && (hasSequence(tokens, ['v0', '1']) || hasSequence(tokens, ['v0', '2'])))
        || hasSequence(tokens, ['mixtral', '8x7b'])
        // Mixtral 8x22B base v0.1 ships mistral.model; the Instruct and v0.3 files differ.
        || (hasSequence(tokens, ['mixtral', '8x22b']) && hasSequence(tokens, ['v0', '1']) && !tokens.includes('instruct'));
    if (isMistralV1) results.push(tokenizers.MISTRAL);

    if (hasSequence(tokens, ['nemo'])) results.push(tokenizers.NEMO);
    // Jamba 1.5/1.6/1.7 and Jamba-tiny-dev ship jamba.model; Jamba v0.1, Jamba2 and Jamba
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
    ];
    if (jambaSequences.some(sequence => hasSequence(tokens, sequence))) results.push(tokenizers.JAMBA);
    if (hasSequence(tokens, ['command', 'r'])) results.push(tokenizers.COMMAND_R);
    if (hasSequence(tokens, ['command', 'a'])) results.push(tokenizers.COMMAND_A);

    // tiktoken's model list is the authority on the raw (lowercased, not separator-split) name,
    // so separators do matter here: 'gpt-4o' is known, 'gpt_4o' is not.
    try {
        tiktoken.get_encoding_name_for_model(/** @type {any} */ (lowerName));
        results.push(lowerName);
    } catch {
        // not an OpenAI model tiktoken knows
    }

    return results;
}

/**
 * @param {string[]} tokens
 * @returns {number[]}
 */
function novelMatches(tokens) {
    const results = [];
    if (hasSequence(tokens, ['clio'])) results.push(tokenizers.NERD);
    if (hasSequence(tokens, ['kayra'])) results.push(tokenizers.NERD2);
    if (hasSequence(tokens, ['erato'])) results.push(tokenizers.LLAMA3);
    return results;
}

/**
 * @param {string} api
 * @param {string} modelName
 * @returns {number|string|null} a `tokenizers` id, a tiktoken model name, or null when unmapped
 */
export function lookupModelTokenizer(api, modelName) {
    if (typeof modelName !== 'string' || modelName === '') {
        return null;
    }
    const tokens = tokenize(modelName);
    const results = api === 'novel'
        ? novelMatches(tokens)
        : generalMatches(tokens, modelName.toLowerCase());
    if (results === null) {
        return null;
    }
    const distinct = new Set(results);
    return distinct.size === 1 ? [...distinct][0] : null;
}
