import { substituteParams } from './macro-substitution.js';

/** @enum {number} */
export const extension_prompt_types = {
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
};

/** @enum {number} */
export const extension_prompt_roles = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

export const MAX_INJECTION_DEPTH = 10000;

const system_message_types = {
    NARRATOR: 'narrator',
};

/**
 * @typedef {object} ExtensionPromptEntry
 * @property {string} value
 * @property {number} position
 * @property {number} depth
 * @property {boolean} scan
 * @property {number} role
 */

/** @typedef {Record<string, ExtensionPromptEntry>} ExtensionPromptTable */

/**
 * @returns {ExtensionPromptTable}
 */
export function createExtensionPromptTable() {
    return {};
}

/**
 * @param {ExtensionPromptTable} table
 * @param {string} key
 * @param {string} value
 * @param {number} position
 * @param {number} [depth]
 * @param {boolean} [scan]
 * @param {number} [role]
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
 * @param {ExtensionPromptTable} table
 * @param {object} [options]
 * @param {number} [options.position]
 * @param {number} [options.depth]
 * @param {string} [options.separator]
 * @param {number} [options.role]
 * @param {boolean} [options.wrap]
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
 * @property {ChatInjectMessageLike[]} coreChat
 * @property {number[]} injectedIndices
 */

/**
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
