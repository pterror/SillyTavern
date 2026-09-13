import { substituteParams } from './macro-substitution.js';

/**
 * Server-side port of public/scripts/textgen-settings.js's getCustomTokenBans() and
 * calculateLogitBias() (the latter via public/scripts/logit-bias.js's getLogitBiasListResult()).
 *
 * Both client functions resolve a tokenizer via getTokenizerForTokenIds() (which picks a
 * tokenizer based on power_user.tokenizer/backend type/model, including remote-backend and
 * OpenRouter-model-specific cases) before turning text into token ids. That resolution step is
 * explicitly OUT OF SCOPE here - a separate future piece. Instead, both functions below take an
 * already-resolved `encode` function as a plain dependency-injected parameter, so they're pure
 * and testable without any tokenizer resolution logic. In production this would be something
 * like `(text) => encodeTextByLocalTokenizerType(resolvedType, text)` from
 * src/endpoints/tokenizers.js, but this module must NOT import that file directly - keeping
 * `encode` injected also makes it reusable for a future remote-backend tokenizer.
 *
 * @typedef {(text: string) => number[]} EncodeFn Turns text into token ids for one already-resolved tokenizer.
 *
 * @typedef {object} CustomTokenBansParams
 * @property {string} [bannedTokensRaw] Raw value of settings.banned_tokens (newline-separated lines).
 * @property {string} [globalBannedTokensRaw] Raw value of settings.global_banned_tokens (newline-separated lines).
 * @property {boolean} sendBannedTokens Raw value of settings.send_banned_tokens; when falsy, bans are disabled entirely.
 * @property {string[]} [bannedWordsFromMacros] Words collected by the `{{banned "..."}}` macro side effect for this
 * generation turn - the client's textgenerationwebui_banned_in_macros. The macro itself is ported elsewhere
 * (src/macro-substitution.js's bannedWordsSink); this just takes its output as a plain array.
 * @property {EncodeFn} encode Already-resolved tokenizer encode function, used for plain-text lines.
 * @property {object} [macroContext] Forwarded to substituteParams() for each ban line; optional, defaults to {}.
 *
 * @typedef {object} CustomTokenBansResult
 * @property {string} banned_tokens Comma-separated, deduped token ids.
 * @property {string[]} banned_strings Literal strings (from `"quoted"` lines) to ban verbatim, untokenized.
 *
 * @typedef {object} LogitBiasEntry
 * @property {string} text One of: `{verbatim text}` (braces stripped, tokenized as-is), `[1,2,3]` (raw token ids),
 * or plain text (tokenized with a leading space prepended).
 * @property {number} value Bias value to apply to every token id the entry resolves to.
 *
 * @typedef {object} LogitBiasParams
 * @property {LogitBiasEntry[]} [logitBiasEntries] Raw value of settings.logit_bias.
 * @property {EncodeFn} encode Already-resolved tokenizer encode function.
 */

/** Trivial reimplementation of public/scripts/utils.js's onlyUnique array filter. */
function onlyUnique(value, index, array) {
    return array.indexOf(value) === index;
}

/**
 * Mirrors public/scripts/textgen-settings.js's getCustomTokenBans(). Turns the three ban sources
 * (banned_tokens, global_banned_tokens, and macro-sourced banned words) into token ids and literal
 * ban strings. Three line formats, checked in order:
 * - `[1,2,3]` - JSON-serialized array of integers -> pushed as raw token ids.
 * - `"literal string"` - quoted string -> pushed to banned_strings verbatim (NOT tokenized).
 * - anything else - tokenized via `encode` and the resulting ids are pushed as token ids.
 * Each line has substituteParams() applied before parsing. Malformed `[...]` JSON is caught,
 * logged, and skipped (matches the client's try/catch), rather than throwing.
 * @param {CustomTokenBansParams} params
 * @returns {CustomTokenBansResult}
 */
export function getCustomTokenBans({
    bannedTokensRaw = '',
    globalBannedTokensRaw = '',
    sendBannedTokens,
    bannedWordsFromMacros = [],
    encode,
    macroContext = {},
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
        // Raw token ids, JSON serialized
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
            // Remove the enclosing quotes
            banned_strings.push(line.slice(1, -1));
        } else {
            try {
                const tokens = encode(line);
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

/**
 * Mirrors public/scripts/logit-bias.js's getLogitBiasListResult(), inlined into
 * calculateLogitBias() below rather than kept as a separate export, since its only caller in this
 * module is calculateLogitBias() and it needs no reuse beyond that (the client keeps them separate
 * because getLogitBiasListResult() is also used by a UI preview).
 */
function resolveLogitBiasEntries(entries, encode) {
    /** @type {{value: number, tokens: number[]}[]} */
    const resolved = [];

    for (const entry of entries) {
        if (!(entry.text?.length > 0)) continue;
        const text = entry.text.trim();

        // Skip empty lines
        if (text.length === 0) continue;

        if (text.startsWith('{') && text.endsWith('}')) {
            // Verbatim text
            const tokens = encode(text.slice(1, -1));
            resolved.push({ value: entry.value, tokens });
        } else if (text.startsWith('[') && text.endsWith(']')) {
            // Raw token ids, JSON serialized
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
            // Text with a leading space
            const tokens = encode(` ${text}`);
            resolved.push({ value: entry.value, tokens });
        }
    }

    return resolved;
}

/**
 * Mirrors public/scripts/textgen-settings.js's calculateLogitBias(). Turns settings.logit_bias
 * into a token-id-keyed bias object; later entries for the same token id overwrite earlier ones,
 * same as the client's addBias().
 * @param {LogitBiasParams} params
 * @returns {object} Object keyed by string token id -> bias number.
 */
export function calculateLogitBias({ logitBiasEntries, encode }) {
    if (!Array.isArray(logitBiasEntries) || logitBiasEntries.length === 0) {
        return {};
    }

    const result = {};
    for (const { value, tokens } of resolveLogitBiasEntries(logitBiasEntries, encode)) {
        if (tokens.length === 0) continue;
        for (const token of tokens) {
            result[String(token)] = value;
        }
    }

    return result;
}
