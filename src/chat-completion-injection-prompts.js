import { extension_prompt_types, extension_prompt_roles, getExtensionPrompt, getOccupiedInChatDepths } from './extension-prompt-table.js';

/**
 * @typedef {object} InjectionPromptLike
 * @property {number} injection_depth
 * @property {number} [injection_order]
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

const TABLE_MERGE_ORDER = 100;

/**
 * @param {InjectionPromptLike[]} prompts
 * @param {import('./extension-prompt-table.js').ExtensionPromptTable} table
 * @returns {number[]}
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
 * @param {InjectionPromptLike[]} prompts
 * @param {object[]} messages
 * @param {object} [options]
 * @param {import('./extension-prompt-table.js').ExtensionPromptTable} [options.table]
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [options.macroContext]
 * @returns {object[]}
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
