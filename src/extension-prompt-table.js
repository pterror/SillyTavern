import { substituteParams } from './macro-substitution.js';

/**
 * Server-side port of public/script.js's `extension_prompts` side-table plus the two functions that
 * read/write it for depth-indexed chat injection: `setExtensionPrompt()`/`getExtensionPrompt()`
 * (~lines 11163/4357) and `doChatInject()` (~line 6760). This is the piece that
 * src/text-completion-prompt-orchestrator.js's module doc comment gap (1) calls out as the single
 * most significant remaining gap before this task.
 *
 * DIFFERENCE FROM THE CLIENT, BY DESIGN: on the client, `extension_prompts` is one persistent,
 * module-level object that many independent features write into over the lifetime of the page, and
 * `flushWIInjections()` (~line 6810) exists purely to scrub stale per-generation entries (WI @Depth /
 * outlet entries) out of that persistent object before the next generation reuses it. A server
 * request has no such persistent lifetime - `createExtensionPromptTable()` below returns a brand
 * new, empty table meant to be built up once per orchestrator call and discarded afterward. Since
 * nothing is ever carried over between requests in the first place, `flushWIInjections()` has no
 * server-side equivalent here - it would be a no-op (there is nothing stale to flush).
 *
 * JUDGMENT CALL - `getExtensionPromptMaxDepth()` (~line 4337) returns the constant
 * `MAX_INJECTION_DEPTH` (10000) in the currently-shipped client code (the commented-out
 * occupied-depths-only block right below it is dead code). Looping a server-side `doChatInject` port
 * from 0 to 10000 on every request to find the (usually handful of) occupied depths would be pure
 * waste. `getExtensionPrompt()` already returns `''` for any position/depth combination with nothing
 * stored at it, and `doChatInject`'s per-depth splice loop only does anything when at least one role
 * at that depth resolves to non-empty text - so restricting the traversal to depths that actually
 * have a stored IN_CHAT entry (`getOccupiedInChatDepths()` below) is behaviorally IDENTICAL to
 * looping the full 0..10000 range: every skipped depth would have contributed nothing anyway. This
 * is implemented as the efficient version, not the literal 10000-iteration loop.
 */

/** @enum {number} Mirrors public/script.js's extension_prompt_types. */
export const extension_prompt_types = {
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
};

/** @enum {number} Mirrors public/script.js's extension_prompt_roles. */
export const extension_prompt_roles = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

/**
 * Mirrors public/script.js's MAX_INJECTION_DEPTH. Kept for documentation/parity purposes only -
 * see the module doc comment above for why this port does NOT loop up to this value.
 */
export const MAX_INJECTION_DEPTH = 10000;

// Mirrored from public/scripts/system-messages.js's system_message_types - only the one value
// doChatInject() needs. Same local-mirror pattern as src/prompt-line-formatting.js.
const system_message_types = {
    NARRATOR: 'narrator',
};

/**
 * @typedef {object} ExtensionPromptEntry
 * @property {string} value
 * @property {number} position One of extension_prompt_types.
 * @property {number} depth
 * @property {boolean} scan
 * @property {number} role One of extension_prompt_roles.
 */

/**
 * @typedef {Record<string, ExtensionPromptEntry>} ExtensionPromptTable
 */

/**
 * Creates a fresh, empty extension-prompt table. Meant to be built up once per orchestrator call
 * (see the module doc comment's "difference from the client" note) rather than reused/persisted.
 * @returns {ExtensionPromptTable}
 */
export function createExtensionPromptTable() {
    return {};
}

/**
 * Port of public/script.js's setExtensionPrompt() (~line 11163). NOTE: the client has a `filter`
 * (7th) parameter (an arbitrary predicate function, evaluated at read time by getExtensionPrompt()).
 * There is no server-side "arbitrary filter function" concept, so it is intentionally NOT part of
 * this port's signature - every stored entry is always treated as passing, exactly as instructed by
 * the task that produced this file (equivalent to every entry always having no filter).
 * @param {ExtensionPromptTable} table
 * @param {string} key
 * @param {string} value
 * @param {number} position One of extension_prompt_types.
 * @param {number} [depth]
 * @param {boolean} [scan]
 * @param {number} [role] One of extension_prompt_roles. Defaults to SYSTEM, mirroring the client.
 */
export function setExtensionPrompt(table, key, value, position, depth, scan = false, role = extension_prompt_roles.SYSTEM) {
    table[key] = {
        value: String(value),
        position: Number(position),
        depth: Number(depth),
        scan: Boolean(scan),
        role: Number(role ?? extension_prompt_roles.SYSTEM),
    };
}

/**
 * Port of public/script.js's getExtensionPrompt() (~line 4357), MINUS the filter-function step (see
 * setExtensionPrompt's doc comment above - every entry is treated as passing). Sorts keys
 * alphabetically (matching the client's `Object.keys(extension_prompts).sort()`, which only matters
 * for the join ORDER of same-position/depth/role entries), filters by position/depth/role using the
 * client's exact "undefined matches any" semantics, joins with `separator`, optionally wraps, then
 * runs the joined result through the real `substituteParams()`.
 * @param {ExtensionPromptTable} table
 * @param {object} [options]
 * @param {number} [options.position] Defaults to IN_PROMPT, mirroring the client's default param.
 * @param {number} [options.depth]
 * @param {string} [options.separator] Defaults to '\n', mirroring the client's default param.
 * @param {number} [options.role]
 * @param {boolean} [options.wrap] Defaults to true, mirroring the client's default param.
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 * @returns {string}
 */
export function getExtensionPrompt(table, {
    position = extension_prompt_types.IN_PROMPT,
    depth = undefined,
    separator = '\n',
    role = undefined,
    wrap = true,
} = {}, macroContext = {}) {
    const entries = Object.keys(table)
        .sort()
        .map((key) => table[key])
        .filter((x) => x.position == position && x.value)
        .filter((x) => depth === undefined || x.depth === undefined || x.depth === depth)
        .filter((x) => role === undefined || x.role === undefined || x.role === role);

    let values = entries.map((x) => x.value.trim()).join(separator);
    if (wrap && values.length && !values.startsWith(separator)) {
        values = separator + values;
    }
    if (wrap && values.length && !values.endsWith(separator)) {
        values = values + separator;
    }
    if (values.length) {
        values = substituteParams(values, macroContext);
    }
    return values;
}

/**
 * Port of public/script.js's getExtensionPromptByName() (~line 4313) - looks up ONE specific key
 * (rather than joining every entry at a position/depth/role), applies (skipped, see above) its
 * filter, and returns the macro-substituted value.
 * @param {ExtensionPromptTable} table
 * @param {string} moduleName
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 * @returns {string}
 */
export function getExtensionPromptByName(table, moduleName, macroContext = {}) {
    if (!moduleName) {
        return '';
    }
    const prompt = table[moduleName];
    if (!prompt) {
        return '';
    }
    return substituteParams(prompt.value, macroContext);
}

/**
 * Efficient replacement for public/script.js's getExtensionPromptMaxDepth() + doChatInject()'s
 * `for (let i = 0; i <= maxDepth; i++)` loop - see the module doc comment's JUDGMENT CALL note for
 * why returning only the depths that actually have an IN_CHAT entry (sorted ascending, matching the
 * original loop's iteration order) is behaviorally identical to looping the full 0..MAX_INJECTION_DEPTH
 * range.
 * @param {ExtensionPromptTable} table
 * @returns {number[]}
 */
export function getOccupiedInChatDepths(table) {
    const depths = new Set();
    for (const key of Object.keys(table)) {
        const entry = table[key];
        if (entry.position === extension_prompt_types.IN_CHAT && entry.value && Number.isFinite(entry.depth)) {
            depths.add(entry.depth);
        }
    }
    return Array.from(depths).sort((a, b) => a - b);
}

/**
 * @typedef {object} ChatInjectMessageLike
 * @property {string} [name]
 * @property {string} [mes]
 * @property {boolean} [is_user]
 * @property {{type?: string|null, [key: string]: any}} [extra]
 */

/**
 * @typedef {object} DoChatInjectResult
 * @property {ChatInjectMessageLike[]} coreChat A NEW array (the input is never mutated) - a copy of
 *  the input `coreChat` with synthetic depth-injection messages spliced in, in NORMAL (oldest-first)
 *  order - the same order convention as the input.
 * @property {number[]} injectedIndices IMPORTANT: these are indices in the REVERSED (newest-first)
 *  convention, i.e. valid indices into `[...coreChat].reverse()` - NOT direct indices into the
 *  returned `coreChat` array itself. This exactly mirrors the client: `getExtensionPromptMaxDepth`-
 *  bounded depth 0 means "newest", so the client computes `injectedIndices` by `indexOf`-searching
 *  its `messages` array WHILE IT IS STILL REVERSED (before reversing it back to normal order at the
 *  very end of `doChatInject()`) - see public/script.js's `injectedIndices = injectedMessages.map(msg
 *  => messages.indexOf(msg)); messages.reverse();` (in that order). Downstream client code relies on
 *  exactly this convention: `buildChat2()`'s `chat2` array uses the same newest-first indexing
 *  (`chat2[0]` is the newest message), and `fillContextBudget()` indexes into `chat2` directly with
 *  `injectedIndices` (`chat2[index]`) - so preserving the "reversed-space" index convention here,
 *  rather than "fixing" it to index into the returned (normal-order) `coreChat`, is required for
 *  correctness with the already-ported `chat-history-budget.js` modules this feeds into.
 */

/**
 * Port of public/script.js's doChatInject() (~line 6760).
 *
 * Difference from the client: the client mutates its `messages` argument in place (reverses it,
 * splices into it, reverses it back) and relies on that same array reference flowing on into
 * injectJailbreak()/buildChat2(). This port never mutates the `coreChat` argument - it operates on a
 * shallow copy and returns that copy as `coreChat`, which the caller (the orchestrator) then feeds
 * into injectJailbreak() exactly as the client feeds its mutated `coreChat` into the jailbreak-splice
 * block. `injectedIndices` is computed the same way the client computes it (locating each injected
 * message object, by identity, in the STILL-REVERSED working array, before reversing back to normal
 * order - see DoChatInjectResult's doc comment above for why that index space is the correct one to
 * return) - since this port keeps the very same message object references throughout its own single
 * working copy, `indexOf`-by-identity lands on the same positions the client's version would. This
 * was verified with a real test (see extension-prompt-table.test.js's multi-depth splicing case,
 * which asserts against `[...coreChat].reverse()[injectedIndices[k]]` rather than against `coreChat`
 * directly) rather than assumed.
 *
 * @param {ChatInjectMessageLike[]} coreChat
 * @param {boolean} isContinue
 * @param {object} params
 * @param {string} [params.name1]
 * @param {string} [params.name2]
 * @param {ExtensionPromptTable} params.table
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [params.macroContext]
 * @returns {DoChatInjectResult}
 */
export function doChatInject(coreChat, isContinue, { name1 = '', name2 = '', table, macroContext = {} }) {
    const messages = coreChat.slice();
    messages.reverse();

    const injectedMessages = [];
    let totalInsertedMessages = 0;

    const occupiedDepths = getOccupiedInChatDepths(table);
    for (const i of occupiedDepths) {
        // Order of priority (most important go lower).
        const roles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
        const names = {
            [extension_prompt_roles.SYSTEM]: '',
            [extension_prompt_roles.USER]: name1,
            [extension_prompt_roles.ASSISTANT]: name2,
        };
        const roleMessages = [];
        const separator = '\n';
        const wrap = false;

        for (const role of roles) {
            const extensionPrompt = String(
                getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, depth: i, separator, role, wrap }, macroContext),
            ).trimStart();
            const isNarrator = role === extension_prompt_roles.SYSTEM;
            const isUser = role === extension_prompt_roles.USER;
            const name = names[role];

            if (extensionPrompt) {
                roleMessages.push({
                    name,
                    is_user: isUser,
                    mes: extensionPrompt,
                    extra: {
                        type: isNarrator ? system_message_types.NARRATOR : null,
                    },
                });
            }
        }

        if (roleMessages.length) {
            const depth = isContinue && i === 0 ? 1 : i;
            const injectIdx = Math.min(depth + totalInsertedMessages, messages.length);
            messages.splice(injectIdx, 0, ...roleMessages);
            totalInsertedMessages += roleMessages.length;
            injectedMessages.push(...roleMessages);
        }
    }

    const injectedIndices = injectedMessages.map((msg) => messages.indexOf(msg));
    messages.reverse();

    return { coreChat: messages, injectedIndices };
}
