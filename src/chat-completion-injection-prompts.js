import { extension_prompt_types, extension_prompt_roles, getExtensionPrompt, getOccupiedInChatDepths } from './extension-prompt-table.js';

/**
 * Server-side port of public/scripts/chat-completion-settings.js's `populationInjectionPrompts()`
 * (~lines 808-873) - "Candidate 3" of the Chat Completion (`main_api === 'openai'`) prompt-assembly
 * decomposition, the chat-completion analog of the text-completion path's depth-indexed injection
 * (`doChatInject()`, already ported in src/extension-prompt-table.js). Built directly on top of that
 * already-existing `getExtensionPrompt()`/table/enum exports - does NOT re-implement any of them.
 *
 * SORT-DIRECTION VERIFICATION - the client groups same-depth prompts by `injection_order` (default
 * `100`) and processes the resulting order-keys via `Object.keys(orderGroups).sort((a, b) => +b - +a)`.
 * The client's own inline comment above this call ("low to high ; a - b = high to low") is confusing
 * and, read literally as a description of what the ACTUAL comparator `(a, b) => +b - +a` does, is
 * backwards. Concretely: with orders `100` and `200`, comparing `a = '100', b = '200'`, the comparator
 * returns `+b - +a = 200 - 100 = 100`, which is positive, meaning (per `Array.prototype.sort`'s
 * contract) `a` ('100') must sort AFTER `b` ('200'). So the resulting order is `['200', '100']` -
 * HIGHEST order first, i.e. genuinely DESCENDING by numeric order value. This is what this port
 * implements (`orders.sort((a, b) => Number(b) - Number(a))`, i.e. plain descending numeric sort) -
 * confirmed by hand-tracing rather than trusting the client's own comment. See the test file for a
 * concrete case that would come out differently (and wrong) under an ascending sort.
 *
 * DEPTH-ENUMERATION EFFICIENCY - src/extension-prompt-table.js's module doc comment (JUDGMENT CALL
 * section) and its `getOccupiedInChatDepths()` export already establish, for the text-completion path,
 * that looping `0..MAX_INJECTION_DEPTH` (10000) to find occupied depths is wasteful and behaviorally
 * identical to only visiting depths that actually have something stored. That helper alone is NOT
 * sufficient here, though: this function has an extra source of "occupied" depths that
 * `doChatInject()` does not - the caller-supplied `prompts` array can itself contain entries at
 * depths that have NO corresponding table entry at all (e.g. injected directly by a caller with
 * `injection_order` other than `100`, which per the client's logic never even reads the table). So
 * this module does not reuse `getOccupiedInChatDepths()` directly; instead it computes its own
 * occupied-depths set as the UNION of (a) `getOccupiedInChatDepths(table)` (reused as-is, not
 * reimplemented) and (b) every distinct `injection_depth` present on `prompts` with non-empty
 * `content`. Looping only that union is behaviorally identical to looping the full
 * `0..getExtensionPromptMaxDepth()` range: every skipped depth has neither a table entry nor a
 * prompts-array entry, so it would produce zero `roleMessages` and therefore never affect
 * `totalInsertedMessages` or splice anything in, exactly like every depth skipped by
 * `getOccupiedInChatDepths()` alone in the text-completion port.
 *
 * ASYNC-VS-SYNC - the client's `populationInjectionPrompts()` is `async` only because the client's own
 * `getExtensionPrompt()` internally does a `Promise.all()` over per-entry `filter` predicate functions
 * (an arbitrary-async-extension-callback mechanism). Per the already-established precedent in this
 * porting effort (src/extension-prompt-table.js's `setExtensionPrompt()`/`getExtensionPrompt()` doc
 * comments, and src/chat-completion-system-prompts.js's equivalent judgment call), there is no
 * server-side "arbitrary filter function" concept, and the already-committed server-side
 * `getExtensionPrompt()` this module calls is synchronous. There is therefore no `await` anywhere in
 * this port's call graph, so the exported `populateInjectionPrompts()` is declared as a plain
 * synchronous function, not `async` - matching the same precedent `doChatInject()` already set.
 */

/**
 * @typedef {object} InjectionPromptLike
 * @property {number} injection_depth Depth this prompt should be injected at (0 = newest).
 * @property {number} [injection_order] Defaults to 100, mirroring the client's `?? 100`. Prompts at
 *  the literal default order `100` are the ONLY ones merged with the live extension-prompt `table`
 *  content at their depth+role; any other explicit order only ever uses this array's own `content`.
 * @property {string} content
 * @property {'system'|'user'|'assistant'} role
 */

/**
 * @typedef {object} InjectedMessageLike
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 * @property {true} injected
 */

const ROLES = /** @type {const} */ (['system', 'user', 'assistant']);

const ROLE_TYPES = {
    system: extension_prompt_roles.SYSTEM,
    user: extension_prompt_roles.USER,
    assistant: extension_prompt_roles.ASSISTANT,
};

/** The literal order-group key that gets merged with table content - see module doc comment. */
const TABLE_MERGE_ORDER = 100;

/**
 * Computes the set of depths that need to be visited - the union of every depth occupied in `table`
 * (reusing `getOccupiedInChatDepths()` as-is) and every distinct `injection_depth` present in
 * `prompts` with non-empty `content`. See the module doc comment's "DEPTH-ENUMERATION EFFICIENCY"
 * section for why this union is required (and sufficient) here.
 * @param {InjectionPromptLike[]} prompts
 * @param {import('./extension-prompt-table.js').ExtensionPromptTable} table
 * @returns {number[]} Sorted ascending, matching the client's `for (let i = 0; i <= maxDepth; i++)`
 *  iteration order.
 */
function getOccupiedInjectionDepths(prompts, table) {
    const depths = new Set(table ? getOccupiedInChatDepths(table) : []);
    for (const prompt of prompts) {
        if (prompt && prompt.content && Number.isFinite(prompt.injection_depth)) {
            depths.add(prompt.injection_depth);
        }
    }
    return Array.from(depths).sort((a, b) => a - b);
}

/**
 * Port of public/scripts/chat-completion-settings.js's `populationInjectionPrompts()`. See the module
 * doc comment for the sort-direction, depth-enumeration, and async-vs-sync judgment calls.
 *
 * Preserves the client's exact ordering convention: `messages` is expected already in NEWEST-FIRST
 * order (depth 0 = index 0). Injected role-messages for each occupied depth `i` are spliced in at
 * index `i + totalInsertedMessages` (counting from the front of that newest-first array), and the
 * WHOLE result is reversed to chronological order only once, at the very end.
 *
 * Never mutates the input `messages` array - operates on and returns a shallow copy.
 *
 * @param {InjectionPromptLike[]} prompts Already-resolved prompt-like objects (NOT necessarily `Prompt`
 *  class instances) - the chat-completion analog of `doChatInject()`'s table-only input, here mixed
 *  with these caller-supplied absolute prompts.
 * @param {object[]} messages Messages already in newest-first order. Not mutated.
 * @param {object} [options]
 * @param {import('./extension-prompt-table.js').ExtensionPromptTable} [options.table] Extension-prompt
 *  table forwarded to `getExtensionPrompt()`. Defaults to an empty table (no IN_CHAT table content).
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [options.macroContext] Forwarded
 *  to `getExtensionPrompt()`.
 * @returns {object[]} A NEW array, in chronological (oldest-first) order, with injected messages
 *  spliced in.
 */
export function populateInjectionPrompts(prompts, messages, { table = {}, macroContext = {} } = {}) {
    const workingMessages = messages.slice();

    let totalInsertedMessages = 0;
    const occupiedDepths = getOccupiedInjectionDepths(prompts, table);

    for (const i of occupiedDepths) {
        const depthPrompts = prompts.filter((prompt) => prompt.injection_depth === i && prompt.content);
        const roleMessages = [];
        const separator = '\n';
        const wrap = false;

        /** @type {Record<number, InjectionPromptLike[]>} */
        const orderGroups = { [TABLE_MERGE_ORDER]: [] };
        for (const prompt of depthPrompts) {
            const order = prompt.injection_order ?? TABLE_MERGE_ORDER;
            if (!orderGroups[order]) orderGroups[order] = [];
            orderGroups[order].push(prompt);
        }

        // Descending by numeric order value - see module doc comment's SORT-DIRECTION VERIFICATION.
        const orders = Object.keys(orderGroups).sort((a, b) => Number(b) - Number(a));

        for (const order of orders) {
            const orderPrompts = orderGroups[order];
            for (const role of ROLES) {
                const rolePrompts = orderPrompts
                    .filter((prompt) => prompt.role === role)
                    .map((x) => x.content)
                    .join(separator);
                const extensionPrompt = Number(order) === TABLE_MERGE_ORDER
                    ? getExtensionPrompt(table, {
                        position: extension_prompt_types.IN_CHAT,
                        depth: i,
                        separator,
                        role: ROLE_TYPES[role],
                        wrap,
                    }, macroContext)
                    : '';
                const jointPrompt = [rolePrompts, extensionPrompt]
                    .filter((x) => x)
                    .map((x) => x.trim())
                    .join(separator);
                if (jointPrompt && jointPrompt.length) {
                    roleMessages.push({ role, content: jointPrompt, injected: true });
                }
            }
        }

        if (roleMessages.length) {
            const injectIdx = i + totalInsertedMessages;
            workingMessages.splice(injectIdx, 0, ...roleMessages);
            totalInsertedMessages += roleMessages.length;
        }
    }

    workingMessages.reverse();
    return workingMessages;
}
