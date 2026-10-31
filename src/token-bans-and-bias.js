import { substituteParams } from './macro-substitution.js';

/**
 * @typedef {(text: string) => number[] | null | Promise<number[] | null>} EncodeFn
 * @typedef {object} CustomTokenBansParams
 * @property {string} [bannedTokensRaw]
 * @property {string} [globalBannedTokensRaw]
 * @property {boolean} sendBannedTokens
 * @property {string[]} [bannedWordsFromMacros]
 * @property {EncodeFn} encode
 * @property {object} [macroContext]
 * @property {string[]} [dropped]
 * @typedef {object} CustomTokenBansResult
 * @property {string} banned_tokens
 * @property {string[]} banned_strings
 * @typedef {object} LogitBiasEntry
 * @property {string} text
 * @property {number} value
 * @typedef {object} LogitBiasParams
 * @property {LogitBiasEntry[]} [logitBiasEntries]
 * @property {EncodeFn} encode
 * @property {string[]} [dropped]
 */

function onlyUnique(value, index, array) {
    return array.indexOf(value) === index;
}

/**
 * @param {CustomTokenBansParams} params
 * @returns {Promise<CustomTokenBansResult>}
 */
export async function getCustomTokenBans({
    bannedTokensRaw = '',
    globalBannedTokensRaw = '',
    sendBannedTokens,
    bannedWordsFromMacros = [],
    encode,
    macroContext = {},
    dropped,
}) {
    if (!sendBannedTokens || (!bannedTokensRaw && !globalBannedTokensRaw && !bannedWordsFromMacros.length)) {
        return {
            banned_tokens: '',
            banned_strings: [],
        };
    }

    const banned_tokens = [];
    const banned_strings = [];
    const sequences = []
        .concat(bannedTokensRaw.split('\n'))
        .concat(globalBannedTokensRaw.split('\n'))
        .concat(bannedWordsFromMacros)
        .filter(x => x.length > 0)
        .filter(onlyUnique)
        .map(x => substituteParams(x, macroContext));

    for (const line of sequences) {
        if (line.startsWith('[') && line.endsWith(']')) {
            try {
                const tokens = JSON.parse(line);

                if (Array.isArray(tokens) && tokens.every(t => Number.isInteger(t))) {
                    banned_tokens.push(...tokens);
                } else {
                    throw new Error('Not an array of integers');
                }
            } catch (err) {
                console.log(`Failed to parse bad word token list: ${line}`, err);
            }
        } else if (line.startsWith('"') && line.endsWith('"')) {
            banned_strings.push(line.slice(1, -1));
        } else {
            try {
                const tokens = await encode(line);
                if (tokens === null) {
                    dropped?.push(line);
                    continue;
                }
                banned_tokens.push(...tokens);
            } catch {
                console.log(`Could not tokenize raw text: ${line}`);
            }
        }
    }

    return {
        banned_tokens: banned_tokens.filter(onlyUnique).map(x => String(x)).join(','),
        banned_strings: banned_strings,
    };
}

async function resolveLogitBiasEntries(entries, encode, dropped) {
    /** @type {{value: number, tokens: number[]}[]} */
    const resolved = [];

    for (const entry of entries) {
        if (!(entry.text?.length > 0)) continue;
        const text = entry.text.trim();

        if (text.length === 0) continue;

        if (text.startsWith('{') && text.endsWith('}')) {
            const tokens = await encode(text.slice(1, -1));
            if (tokens === null) {
                dropped?.push(text);
                continue;
            }
            resolved.push({ value: entry.value, tokens });
        } else if (text.startsWith('[') && text.endsWith(']')) {
            try {
                const tokens = JSON.parse(text);

                if (Array.isArray(tokens) && tokens.every(t => Number.isInteger(t))) {
                    resolved.push({ value: entry.value, tokens });
                } else {
                    throw new Error('Not an array of integers');
                }
            } catch (err) {
                console.log(`Failed to parse logit bias token list: ${text}`, err);
            }
        } else {
            const tokens = await encode(` ${text}`);
            if (tokens === null) {
                dropped?.push(text);
                continue;
            }
            resolved.push({ value: entry.value, tokens });
        }
    }

    return resolved;
}

/**
 * @param {LogitBiasParams} params
 * @returns {Promise<object>}
 */
export async function calculateLogitBias({ logitBiasEntries, encode, dropped }) {
    if (!Array.isArray(logitBiasEntries) || logitBiasEntries.length === 0) {
        return {};
    }

    const result = {};
    for (const { value, tokens } of await resolveLogitBiasEntries(logitBiasEntries, encode, dropped)) {
        if (tokens.length === 0) continue;
        for (const token of tokens) {
            result[String(token)] = value;
        }
    }

    return result;
}
