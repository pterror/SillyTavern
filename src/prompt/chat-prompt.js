import { Message } from './chat-message.js';
import { substituteParams } from '../macro-substitution.js';
import { character_names_behavior } from '../chat-completion-messages.js';
import {
    TOOL_REASONING_MODES,
    isToolCallingSupported,
    canPerformToolCalls,
    getEffectiveToolReasoningMode,
    isReasoningSignatureSupported,
    isInterleavedReasoningProvider,
} from '../chat-completion-tool-capabilities.js';
import { promptParts } from '../prompt-itemization.js';
import { persona_description_positions } from '../../public/scripts/constants.js';
import { collectSections, fitBudget, place, renderChat } from './model.js';
import { extension_prompt_types, roleName } from './injections.js';
import './providers.js';

/** @typedef {import('./model.js').Section} Section */
/** @typedef {import('./injections.js').PositionedEntry} PositionedEntry */

const DEFAULT_ORDER = 100;
const ABSOLUTE = 1;
const PRIMING_TOKENS = 3;

const ROLE_RANK = { assistant: 0, user: 1, system: 2 };

const KNOWN_EXTENSION_PROMPTS = ['1_memory', '2_floating_prompt', '3_vectors', '4_vectors_data_bank', 'chromadb', 'PERSONA_DESCRIPTION', 'QUIET_PROMPT', 'DEPTH_PROMPT'];

const KNOWN_INTO_MAIN = [
    { key: '1_memory', identifier: 'summary', part: 'summary' },
    { key: '2_floating_prompt', identifier: 'authorsNote', part: 'authors_note' },
    { key: '3_vectors', identifier: 'vectorsMemory', part: 'chat_vectors', role: 'system' },
    { key: '4_vectors_data_bank', identifier: 'vectorsDataBank', part: 'data_bank_vectors' },
    { key: 'chromadb', identifier: 'smartContext', part: 'smart_context', role: 'system' },
];

/** @type {Readonly<Record<string, import('../prompt-itemization.js').PromptPartName>>} */
const MARKER_PARTS = Object.freeze({
    main: 'main', worldInfoBefore: 'world_info', worldInfoAfter: 'world_info',
    charDescription: 'description', charPersonality: 'personality', scenario: 'scenario', personaDescription: 'persona',
    nsfw: 'auxiliary', jailbreak: 'post_history', bias: 'bias', impersonate: 'impersonate', groupNudge: 'nudge',
});

/**
 * @typedef {object} PromptRecord
 * @property {string} identifier
 * @property {string} [role]
 * @property {string} [content]
 * @property {boolean} [system_prompt]
 * @property {number} [injection_position]
 * @property {number} [injection_depth]
 * @property {number} injection_order
 * @property {boolean} [forbid_overrides]
 * @property {string[]} [injection_trigger]
 * @property {(inner: string) => string} [wrap]
 */

/**
 * @param {string} name
 * @returns {boolean}
 */
function isValidChatCompletionName(name) {
    return /^[a-zA-Z0-9_]{1,64}$/.test(name);
}

/**
 * @param {string} name
 * @returns {string}
 */
export function sanitizeChatCompletionName(name) {
    return name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64);
}

/**
 * @param {string} format
 * @param {...any} args
 * @returns {string}
 */
function stringFormat(format, ...args) {
    return format.replace(/{(\d+)}/g, (match, number) => typeof args[number] !== 'undefined' ? args[number] : match);
}

/**
 * @param {string} value
 * @param {string|null} wiFormat
 * @returns {string}
 */
export function formatWorldInfo(value, wiFormat) {
    if (!value) return '';
    const format = wiFormat ?? '';
    return format.trim() ? stringFormat(format, value) : value;
}

/**
 * @param {Record<string, any>} prompt
 * @returns {PromptRecord}
 */
function record(prompt) {
    return {
        identifier: prompt.identifier, role: prompt.role, content: prompt.content, system_prompt: prompt.system_prompt,
        injection_position: prompt.injection_position, injection_depth: prompt.injection_depth,
        injection_order: prompt.injection_order ?? DEFAULT_ORDER, forbid_overrides: prompt.forbid_overrides,
        injection_trigger: prompt.injection_trigger ?? [], wrap: prompt.wrap,
    };
}

/**
 * @param {any[]} promptOrder
 * @param {string|number} characterId
 * @returns {{ identifier: string, enabled: boolean }[]}
 */
function orderFor(promptOrder, characterId) {
    if (!characterId) return [];
    const entry = (promptOrder ?? []).find(list => String(list.character_id) === String(characterId));
    return entry ? (entry.order ?? []) : [];
}

/**
 * @param {Record<string, any>} prompt
 * @param {string} generationType
 * @returns {boolean}
 */
function shouldTrigger(prompt, generationType) {
    if (!Array.isArray(prompt?.injection_trigger) || !prompt.injection_trigger.length) return true;
    return prompt.injection_trigger.includes(generationType);
}

/**
 * @typedef {object} ChatCompletionPromptInput
 * @property {string} [charDescription]
 * @property {string} [charPersonality]
 * @property {string} [scenario]
 * @property {string[]} [worldInfoBeforeEntries]
 * @property {string[]} [worldInfoAfterEntries]
 * @property {Record<string, string[]>} [outletEntries]
 * @property {string} [bias]
 * @property {string} [type]
 * @property {string} [quietPrompt]
 * @property {string} [quietImage]
 * @property {PositionedEntry[]} [entries]
 * @property {string} [cyclePrompt]
 * @property {string} [systemPromptOverride]
 * @property {string} [jailbreakPromptOverride]
 * @property {object[]} messages Newest first, as `buildChatCompletionMessages()` makes them.
 * @property {object[][]} [messageExamples]
 * @property {import('./chat-message.js').TokenHandler} tokenHandler
 * @property {number} maxContext
 * @property {number} maxTokens
 * @property {boolean} [squashSystemMessages]
 * @property {string} [scenarioFormat]
 * @property {string} [personalityFormat]
 * @property {string} [groupNudgePrompt]
 * @property {string} [impersonationPrompt]
 * @property {string} [personaDescription]
 * @property {number} [personaDescriptionPosition]
 * @property {string} [wiFormat]
 * @property {any[]} [prompts]
 * @property {any[]} [promptOrder]
 * @property {string|number} [characterId]
 * @property {string[]} [groupMemberNames]
 * @property {import('../macro-substitution.js').SubstituteParamsContext} [macroContext]
 * @property {string} [mainApi]
 * @property {any} [settings]
 * @property {string} [model]
 * @property {any[]} [modelList]
 * @property {boolean} [canUseToolsOverride]
 * @property {boolean} [includeSignatureOverride]
 * @property {string} [toolReasoningModeOverride]
 * @property {boolean} [includeToolReasoningOverride]
 * @property {boolean} [imageInlining]
 * @property {boolean} [videoInlining]
 * @property {boolean} [audioInlining]
 * @property {string} [imageQuality]
 * @property {{userImages?: string}} [directories]
 * @property {number} [toolBudgetTokens]
 * @property {boolean} [continuePrefill]
 * @property {boolean} [supportsAssistantPrefill]
 * @property {boolean} [namesInCompletion]
 * @property {string} [assistantPrefill]
 * @property {boolean} [pinExamples]
 * @property {{ isGroup?: boolean, newChatPrompt?: string, newGroupChatPrompt?: string, continueNudgePrompt?: string, sendIfEmpty?: string, namesBehavior?: number }} [historyOptions]
 * @property {string} [newExampleChatPrompt]
 */

/**
 * @typedef {object} ChatPromptItemization
 * @property {number} messages_count
 * @property {number} examples_count
 * @property {number} total
 * @property {import('../prompt-itemization.js').PromptPart[]} parts
 */

/**
 * @param {ChatCompletionPromptInput} input
 * @returns {Promise<{ chat: object[]|null, itemize: (() => Promise<ChatPromptItemization>)|null, canUseTools: boolean, canPerformToolCalls: boolean }>}
 */
export async function buildChatCompletionPrompt({
    charDescription, charPersonality, scenario, worldInfoBeforeEntries = [], worldInfoAfterEntries = [], outletEntries = {}, bias, type,
    quietPrompt, quietImage, entries = [], cyclePrompt, systemPromptOverride, jailbreakPromptOverride,
    messages, messageExamples = [], tokenHandler, maxContext, maxTokens,
    squashSystemMessages = false, scenarioFormat, personalityFormat, groupNudgePrompt, impersonationPrompt,
    personaDescription, personaDescriptionPosition, wiFormat = null,
    prompts = [], promptOrder = [], characterId, groupMemberNames = [], macroContext = {},
    mainApi, settings = {}, model, modelList,
    canUseToolsOverride, includeSignatureOverride, toolReasoningModeOverride, includeToolReasoningOverride,
    imageInlining = false, videoInlining = false, audioInlining = false, imageQuality = 'auto', directories,
    toolBudgetTokens = 0, continuePrefill = false, supportsAssistantPrefill = false, namesInCompletion = false,
    assistantPrefill = '', pinExamples = false, historyOptions = {}, newExampleChatPrompt = '',
}) {
    if (!tokenHandler) throw new Error('buildChatCompletionPrompt: tokenHandler is required');

    const canUseTools = canUseToolsOverride ?? isToolCallingSupported({ mainApi, settings, model, modelList });
    const includeSignature = includeSignatureOverride ?? isReasoningSignatureSupported(settings);
    const toolReasoningMode = toolReasoningModeOverride ?? (isInterleavedReasoningProvider(settings?.chat_completion_source) ? getEffectiveToolReasoningMode(settings) : TOOL_REASONING_MODES.DISABLED);
    const includeToolReasoning = includeToolReasoningOverride ?? (toolReasoningMode !== TOOL_REASONING_MODES.DISABLED);
    const resolvedCanPerformToolCalls = canPerformToolCalls({ type, mainApi, settings, model, modelList });
    const chatCompletionSource = settings?.chat_completion_source;
    const generationType = String(type || 'normal').toLowerCase().trim();
    const isGroup = Boolean(historyOptions.isGroup);

    const groupContext = groupMemberNames.length > 0 ? { ...macroContext, group: groupMemberNames.join(', ') } : macroContext;
    const prepare = (/** @type {string|undefined} */ content, original) =>
        substituteParams(content ?? '', typeof original === 'string' ? { ...groupContext, original } : groupContext);

    /** @type {PromptRecord[]} */
    const collection = [];
    for (const entry of orderFor(promptOrder, characterId)) {
        const prompt = prompts.find(item => item && item.identifier === entry.identifier);
        if (!prompt) continue;
        if (entry.enabled && shouldTrigger(prompt, generationType)) collection.push({ ...record(prompt), content: prepare(prompt.content) });
        else if (entry.identifier === 'main') collection.push({ ...record(prompt), content: prepare('') });
    }
    const disabled = new Set(orderFor(promptOrder, characterId).filter(entry => !entry.enabled).map(entry => entry.identifier));

    const systemPrompts = [
        { identifier: 'worldInfoBefore', role: 'system', content: '', wrap: (/** @type {string} */ inner) => prepare(formatWorldInfo(inner, wiFormat)) },
        { identifier: 'worldInfoAfter', role: 'system', content: '', wrap: (/** @type {string} */ inner) => prepare(formatWorldInfo(inner, wiFormat)) },
        { identifier: 'charDescription', role: 'system', content: charDescription },
        { identifier: 'charPersonality', role: 'system', content: charPersonality && personalityFormat ? substituteParams(personalityFormat, macroContext) : (charPersonality || '') },
        { identifier: 'scenario', role: 'system', content: scenario && scenarioFormat ? substituteParams(scenarioFormat, macroContext) : (scenario || '') },
        { identifier: 'impersonate', role: 'system', content: impersonationPrompt ? substituteParams(impersonationPrompt, macroContext) : '' },
        { identifier: 'quietPrompt', role: 'system', content: quietPrompt },
        { identifier: 'groupNudge', role: 'system', content: substituteParams(groupNudgePrompt, macroContext) },
        { identifier: 'bias', role: 'assistant', content: bias },
        ...(personaDescription && personaDescriptionPosition === persona_description_positions.IN_PROMPT
            ? [{ identifier: 'personaDescription', role: 'system', content: personaDescription }] : []),
    ];
    for (const prompt of systemPrompts) {
        const index = collection.findIndex(p => p.identifier === prompt.identifier);
        const marker = index >= 0 ? collection[index] : null;
        const merged = {
            ...record(prompt),
            injection_position: marker?.injection_position, injection_depth: marker?.injection_depth,
            injection_order: marker?.injection_order ?? DEFAULT_ORDER, role: marker?.role ?? prompt.role,
            content: prompt.wrap ? '' : prepare(prompt.content),
        };
        if (index >= 0) collection[index] = merged;
        else collection.push(merged);
    }
    for (const [identifier, override] of [['main', systemPromptOverride], ['jailbreak', jailbreakPromptOverride]]) {
        const index = collection.findIndex(p => p.identifier === identifier);
        if (!override || index < 0 || collection[index].forbid_overrides === true || disabled.has(identifier)) continue;
        collection[index] = { ...collection[index], content: prepare(override, collection[index].content) };
    }

    const historyMessages = [...messages];

    /** @type {any} */
    let prefillMessage = null;
    if (type === 'continue' && continuePrefill && historyMessages.length) prefillMessage = historyMessages.shift();
    const oldestFirst = historyMessages.slice().reverse();

    /** @type {any} */
    let continuedMessage = null;
    const continuing = type === 'continue' && Boolean(cyclePrompt) && !continuePrefill;
    if (continuing && oldestFirst.length) continuedMessage = oldestFirst.pop();
    const depthShift = continuedMessage ? 1 : 0;

    /** @type {Section[]} */
    const sections = [];
    const hasHistory = collection.some(p => p.identifier === 'chatHistory');
    const absolute = collection.filter(p => p.injection_position === ABSOLUTE);
    const added = new Set(['worldInfoBefore', 'main', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'nsfw', 'jailbreak', 'enhanceDefinitions']);
    if (bias && bias.trim().length) added.add('bias');

    collection.forEach((prompt, index) => {
        const id = `pm:${prompt.identifier}`;
        if (prompt.injection_position === ABSOLUTE) return;
        if (prompt.identifier === 'chatHistory') {
            sections.push({ id: 'history', order: index, provider: 'history', budget: 'trim', trimFrom: 'start', priority: 0 });
            return;
        }
        if (prompt.identifier === 'dialogueExamples') {
            sections.push({ id: 'examples', order: index, provider: 'examples', budget: 'trim', trimFrom: 'end', priority: pinExamples ? -1 : 1 });
            return;
        }
        const isUserRelative = prompt.system_prompt === false;
        if (!added.has(prompt.identifier) && !isUserRelative) return;
        if (disabled.has(prompt.identifier) && prompt.identifier !== 'main') return;
        const part = MARKER_PARTS[prompt.identifier] ?? 'other_prompts';
        if (prompt.identifier === 'main') {
            sections.push({ id: 'main-slot', order: index });
            sections.push({ id, parent: 'main-slot', at: { first: true }, order: 0, role: /** @type {any} */ (prompt.role || 'system'), text: prompt.content ?? '', part, squash: true });
            return;
        }
        if (prompt.identifier === 'worldInfoBefore' || prompt.identifier === 'worldInfoAfter') {
            const lore = prompt.identifier === 'worldInfoBefore' ? worldInfoBeforeEntries : worldInfoAfterEntries;
            const wrap = (systemPrompts.find(p => p.identifier === prompt.identifier)?.wrap);
            sections.push({ id, order: index, role: /** @type {any} */ (prompt.role || 'system'), join: '\n', compose: ({ inner }) => wrap(inner), part, squash: true });
            lore.forEach((text, i) => sections.push({ id: `${id}:${i}`, parent: id, order: i, text, part: 'world_info' }));
            return;
        }
        sections.push({ id, order: index, role: /** @type {any} */ (prompt.role || 'system'), text: prompt.content ?? '', part, squash: true });
    });

    const besideMain = (/** @type {PositionedEntry} */ entry) => entry.position === extension_prompt_types.BEFORE_PROMPT || entry.position === extension_prompt_types.IN_PROMPT;
    const intoMain = [
        ...KNOWN_INTO_MAIN.flatMap(known => entries.filter(entry => entry.key === known.key && besideMain(entry)).map(entry => ({ entry, known }))),
        ...entries.filter(entry => besideMain(entry) && !KNOWN_EXTENSION_PROMPTS.includes(entry.key)).map(entry => ({ entry, known: null })),
    ];
    const mainRecord = collection.find(p => p.identifier === 'main');
    const mainInChat = Boolean(mainRecord) && mainRecord?.injection_position !== ABSOLUTE;

    /** @type {{ entry: PositionedEntry, role: string, part: string, start: boolean }[]} */
    const besideMainAbsolute = [];
    intoMain.forEach(({ entry, known }, seq) => {
        const start = entry.position === extension_prompt_types.BEFORE_PROMPT;
        const role = known?.role ?? roleName(entry.role);
        const part = known?.part ?? 'extensions';
        if (mainInChat) {
            const wrapperId = `into-main:${entry.key}`;
            sections.push({ id: wrapperId, parent: 'main-slot', at: start ? { first: true } : { last: true }, order: start ? -(seq + 1) : seq, role: (role), part, squash: true });
            sections.push({ ...entry.root, parent: wrapperId, part: entry.root.part === 'extensions' ? part : entry.root.part }, ...entry.children);
        } else if (mainRecord) {
            besideMainAbsolute.push({ entry, role: (mainRecord.role), part, start });
        }
    });

    const absoluteList = absolute.map(prompt => ({ prompt, entry: null }));
    for (const { entry, start } of besideMainAbsolute) {
        const mainIndex = absoluteList.findIndex(item => item.prompt?.identifier === 'main');
        if (mainIndex < 0) continue;
        const main = (absoluteList[mainIndex].prompt);
        absoluteList.splice(start ? mainIndex : mainIndex + 1, 0, { prompt: { ...main, identifier: `into-main:${entry.key}`, content: '' }, entry });
    }

    const inChat = entries.filter(entry => entry.position === extension_prompt_types.IN_CHAT && entry.root && Number.isFinite(entry.depth));
    const depths = new Set([
        ...inChat.map(entry => entry.depth),
        ...absoluteList.filter(item => (item.entry || item.prompt?.content) && Number.isFinite(item.prompt?.injection_depth)).map(item => (item.prompt?.injection_depth)),
    ]);

    /** @type {{ depth: number, role: string }[]} */
    const wrapperRoles = [];
    for (const depth of [...depths].sort((a, b) => a - b)) {
        const atDepth = absoluteList.filter(item => item.prompt?.injection_depth === depth && (item.entry || item.prompt?.content));
        const orders = new Set([DEFAULT_ORDER, ...atDepth.map(item => item.prompt?.injection_order ?? DEFAULT_ORDER)]);
        for (const order of orders) {
            for (const role of (['system', 'user', 'assistant'])) {
                const prompted = atDepth.filter(item => (item.prompt?.injection_order ?? DEFAULT_ORDER) === order && item.prompt?.role === role);
                const tabled = order === DEFAULT_ORDER ? inChat.filter(entry => entry.depth === depth && roleName(entry.role) === role) : [];
                if (!prompted.length && !tabled.length) continue;
                const id = `depth:${depth}:${order}:${role}`;
                const n = depthShift ? Math.max(depth - 1, 0) : depth;
                sections.push({
                    id, parent: 'history', at: { fromEnd: n }, order: -depth * 1e6 + order * 10 + ROLE_RANK[role],
                    role: /** @type {any} */ (role), join: '\n', skipEmpty: true, trimEach: true, part: 'injections', squash: true,
                });
                if (prompted.length) {
                    sections.push({ id: `${id}:prompts`, parent: id, order: 0, join: '\n' });
                    prompted.forEach((item, i) => {
                        if (item.entry) sections.push({ ...item.entry.root, parent: `${id}:prompts`, order: i }, ...item.entry.children);
                        else sections.push({ id: `${id}:prompts:${i}`, parent: `${id}:prompts`, order: i, text: item.prompt?.content ?? '' });
                    });
                }
                if (tabled.length) {
                    sections.push({ id: `${id}:table`, parent: id, order: 1, join: '\n', skipEmpty: true, trimEach: true });
                    for (const entry of tabled) sections.push({ ...entry.root, parent: `${id}:table` }, ...entry.children);
                }
                wrapperRoles.push({ depth: n, role });
            }
        }
    }

    const working = workingRoles(oldestFirst, sections.filter(s => s.parent === 'history' && s.at?.fromEnd !== undefined));
    const lastUserIdx = working.findLastIndex(x => x.role === 'user');
    const namesBehavior = historyOptions.namesBehavior ?? character_names_behavior.NONE;
    const historyState = {
        format: 'chat',
        messages: oldestFirst.map((message) => {
            const promptIdx = working.findIndex(x => x.message === message);
            if (canUseTools && Array.isArray(message.invocations)) {
                const invocations = toolInvocations(message, promptIdx, working, lastUserIdx, toolReasoningMode);
                return {
                    role: message.role, content: '',
                    parts: [
                        { role: message.role, data: { kind: 'toolCall', invocations, includeSignature, includeToolReasoning } },
                        ...invocations.map(invocation => ({ role: 'tool', data: { kind: 'toolResult', id: invocation.id, result: invocation.result || '[No content]' } })),
                    ],
                };
            }
            return {
                role: message.role,
                content: substituteParams(message.content ?? '', macroContext),
                data: {
                    kind: 'message',
                    name: namesBehavior === character_names_behavior.COMPLETION && message.name
                        ? (isValidChatCompletionName(message.name) ? message.name : sanitizeChatCompletionName(message.name)) : undefined,
                    media: message.media, mediaDisplay: message.mediaDisplay, mediaIndex: message.mediaIndex,
                    signature: includeSignature && message.signature ? message.signature : undefined,
                },
            };
        }),
    };

    if (hasHistory) {
        const newChat = isGroup ? historyOptions.newGroupChatPrompt : historyOptions.newChatPrompt;
        sections.push({ id: 'history:start', parent: 'history', at: { first: true }, role: 'system', text: substituteParams(newChat ?? '', macroContext), squash: false, part: 'chat_start' });
        const last = working[working.length - 1];
        if (last && last.role === 'assistant' && historyOptions.sendIfEmpty) {
            sections.push({ id: 'history:empty-reply', parent: 'history', order: 1, role: 'user', text: historyOptions.sendIfEmpty, budget: 'drop', priority: -2, part: 'chat_history', squash: true });
        }
        const nudge = collection.find(p => p.identifier === 'groupNudge');
        if (isGroup && nudge && type !== 'impersonate') {
            sections.push({ id: 'history:group-nudge', parent: 'history', order: 2, role: /** @type {any} */ (nudge.role || 'system'), text: nudge.content ?? '', squash: false, part: 'nudge' });
        }
    }

    const tail = collection.length + 1;
    if (continuing && hasHistory) {
        sections.push({ id: 'continued', order: tail });
        if (continuedMessage) sections.push({ id: 'continued:message', parent: 'continued', order: 0, role: continuedMessage.role, text: substituteParams(continuedMessage.content ?? '', macroContext), part: 'chat_history', squash: true });
        const nudgeText = substituteParams(historyOptions.continueNudgePrompt ?? '', {
            ...macroContext, dynamicMacros: { ...macroContext.dynamicMacros, lastChatMessage: String(cyclePrompt).trim() },
        });
        sections.push({ id: 'continued:nudge', parent: 'continued', order: 1, role: 'system', text: substituteParams(nudgeText, macroContext), part: 'nudge', squash: true });
    }

    const controls = 'controls';
    sections.push({ id: controls, order: tail + 1 });
    const impersonate = collection.find(p => p.identifier === 'impersonate');
    if (type === 'impersonate' && impersonate) {
        sections.push({ id: 'control:impersonate', parent: controls, order: 0, role: /** @type {any} */ (impersonate.role || 'system'), text: impersonate.content ?? '', part: 'impersonate', squash: true });
    }
    const quiet = collection.find(p => p.identifier === 'quietPrompt');
    if (quiet && quiet.content) {
        sections.push({
            id: 'control:quiet', parent: controls, order: 1, role: /** @type {any} */ (quiet.role || 'system'), text: quiet.content, part: 'other_prompts', squash: true,
            data: { kind: 'message', image: imageInlining && quietImage ? quietImage : undefined },
        });
    }
    if (prefillMessage) {
        const prefill = prefillMessage.role === 'assistant' && supportsAssistantPrefill ? substituteParams(assistantPrefill, macroContext) : '';
        sections.push({
            id: 'control:continue', parent: controls, order: 2, role: prefillMessage.role,
            text: [prefill, prefillMessage.content].filter(x => x).join('\n\n'), part: 'chat_history', squash: true,
            data: { kind: 'raw', name: prefillMessage.name && namesInCompletion ? sanitizeChatCompletionName(prefillMessage.name) : undefined },
        });
    }

    for (const [name, texts] of Object.entries(outletEntries)) {
        texts.forEach((text, i) => sections.push({ id: `lore:outlet:${name}:${i}`, parent: `outlet:${name}`, order: i, text, part: 'world_info' }));
    }

    const exampleSeparator = substituteParams(newExampleChatPrompt, macroContext);
    const examplesState = {
        format: 'chat', separator: exampleSeparator,
        blocks: Array.isArray(messageExamples) ? messageExamples.map(block => block.map(prompt => ({ role: 'system', content: prompt.content || '', name: prompt.name }))) : [],
    };

    const collected = await collectSections(sections, { type }, { history: historyState, examples: examplesState });
    const { root } = place(collected);

    /** @type {Map<string, Message>} */
    const built = new Map();
    const toMessage = async (/** @type {import('./model.js').ChatSpec} */ spec) => {
        const cached = built.get(spec.section.id);
        if (cached) return cached;
        const data = spec.section.data ?? {};
        let message;
        if (data.kind === 'toolCall') {
            message = await Message.createAsync(spec.role, undefined, `toolCall-${spec.section.id}`, tokenHandler);
            await message.setToolCalls(data.invocations, data.includeSignature, data.includeToolReasoning, tokenHandler);
        } else if (data.kind === 'toolResult') {
            message = await Message.createAsync('tool', data.result, data.id, tokenHandler);
        } else {
            message = await Message.createAsync(spec.role, spec.content, spec.section.id, tokenHandler);
            if (data.alwaysName || spec.section.name !== undefined) await message.setName(spec.section.name, tokenHandler);
            if (data.name) await message.setName(data.name, tokenHandler);
            if (data.signature) message.signature = data.signature;
            await inlineMedia(message, data, { imageInlining, videoInlining, audioInlining, imageQuality, chatCompletionSource, directories });
        }
        built.set(spec.section.id, message);
        return message;
    };
    const isSent = (/** @type {Message} */ message) => Boolean(message.content || message.tool_calls);

    const reserve = PRIMING_TOKENS + (toolBudgetTokens > 0 ? toolBudgetTokens : 0);
    const { rendered } = await fitBudget(root, {
        budget: maxContext - maxTokens,
        render: async (excluded, unitOf) => renderChat(root, { excluded, unitOf }),
        measure: async (full) => {
            let kept = reserve;

            /** @type {Map<string, number>} */
            const units = new Map();

            /** @type {Map<string, number>} */
            const keptBySection = new Map();
            for (const spec of full.specs) {
                const message = await toMessage(spec);
                if (spec.unit === null) {
                    kept += message.getTokens();
                    keptBySection.set(spec.section.id, (keptBySection.get(spec.section.id) ?? 0) + message.getTokens());
                } else {
                    units.set(spec.unit, (units.get(spec.unit) ?? 0) + message.getTokens());
                }
            }
            return { kept, units, describeKept: async () => [...keptBySection].map(([id, tokens]) => ({ id, tokens })) };
        },
    });

    /** @type {{ spec: import('./model.js').ChatSpec, message: Message }[]} */
    const sent = [];
    for (const spec of rendered.specs) {
        const message = await toMessage(spec);
        if (isSent(message)) sent.push({ spec, message });
    }

    const counted = itemizedParts(sent);
    const total = sent.reduce((sum, item) => sum + item.message.getTokens(), 0);
    const itemize = async () => ({ ...counted, total });

    const final = squashSystemMessages ? await squash(sent, tokenHandler) : sent.map(item => item.message);
    return { chat: final.map(message => message.toWire()), itemize, canUseTools, canPerformToolCalls: resolvedCanPerformToolCalls };
}

/**
 * @param {any[]} oldestFirst
 * @param {Section[]} placed
 * @returns {{ role: string, message?: any, content?: string, invocations?: any[], reasoning?: string }[]}
 */
function workingRoles(oldestFirst, placed) {
    const k = oldestFirst.length;

    const slots = Array.from({ length: k + 1 }, () => []);
    const sorted = placed.slice().sort((a, b) => (b.at?.fromEnd ?? 0) - (a.at?.fromEnd ?? 0) || (a.order ?? 0) - (b.order ?? 0));
    for (const section of sorted) slots[Math.min(Math.max(k - (section.at?.fromEnd ?? 0), 0), k)].push({ role: (section.role), content: 'x' });
    const out = [];
    for (let i = 0; i <= k; i++) {
        out.push(...slots[i]);
        if (i < k) out.push({ role: oldestFirst[i].role, message: oldestFirst[i], content: oldestFirst[i].content, invocations: oldestFirst[i].invocations, reasoning: oldestFirst[i].reasoning });
    }
    return out;
}

/**
 * @param {any} message
 * @param {number} promptIdx
 * @param {{ role: string, content?: string, invocations?: any[], reasoning?: string }[]} working
 * @param {number} lastUserIdx
 * @param {string} toolReasoningMode
 * @returns {any[]}
 */
function toolInvocations(message, promptIdx, working, lastUserIdx, toolReasoningMode) {
    const eligible = toolReasoningMode !== TOOL_REASONING_MODES.DISABLED && promptIdx > lastUserIdx;
    let previous = '';
    if (eligible) {
        const hasText = (/** @type {any} */ c) => c?.role === 'assistant' && !Array.isArray(c.invocations) && typeof c.content === 'string' && c.content.trim().length > 0;
        if (toolReasoningMode === TOOL_REASONING_MODES.ACTIVE_CHAIN) {
            for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                const candidate = working[idx];
                if (candidate?.role === 'tool') continue;
                if (candidate?.role === 'assistant' && Array.isArray(candidate.invocations)) continue;
                if (hasText(candidate)) previous = String(candidate.reasoning ?? '');
                break;
            }
        } else if (toolReasoningMode === TOOL_REASONING_MODES.SINCE_LAST_USER) {
            for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                const candidate = working[idx];
                if (!hasText(candidate)) continue;
                const reasoning = String(candidate.reasoning ?? '');
                if (reasoning) { previous = reasoning; break; }
            }
        }
    }
    return message.invocations.map((/** @type {any} */ invocation) => {
        const clone = structuredClone(invocation);
        if (!eligible) delete clone.reasoning;
        else if (previous && !clone.reasoning) clone.reasoning = previous;
        return clone;
    });
}

/**
 * @param {Message} message
 * @param {Record<string, any>} data
 * @param {object} options
 */
async function inlineMedia(message, data, { imageInlining, videoInlining, audioInlining, imageQuality, chatCompletionSource, directories }) {
    if (data.image) {
        await message.addImage(data.image, { quality: imageQuality, chatCompletionSource, directories });
        return;
    }
    if (!Array.isArray(data.media) || !data.media.length) return;
    const inline = async (/** @type {any} */ media) => {
        if (!media || !media.url) return;
        const mediaType = media.type || 'image';
        if (imageInlining && mediaType === 'image') await message.addImage(media.url, { quality: imageQuality, chatCompletionSource, directories });
        if (videoInlining && mediaType === 'video') await message.addVideo(media.url, { quality: imageQuality, directories });
        if (audioInlining && mediaType === 'audio') await message.addAudio(media.url, { directories });
    };
    if (data.mediaDisplay === 'list') for (const media of data.media) await inline(media);
    if (data.mediaDisplay === 'gallery') await inline(data.media[data.mediaIndex]);
}

/**
 * @param {{ spec: import('./model.js').ChatSpec, message: Message }[]} sent
 * @returns {Omit<ChatPromptItemization, 'total'>}
 */
function itemizedParts(sent) {
    /** @type {[import('../prompt-itemization.js').PromptPartName, number][]} */
    const counted = [];
    let messagesCount = 0;
    const blocks = new Set();
    for (const { spec, message } of sent) {
        const part = /** @type {import('../prompt-itemization.js').PromptPartName} */ (spec.section.part ?? 'other_prompts');
        counted.push([part, message.getTokens()]);
        if (part === 'chat_history' && message.role !== 'tool' && !message.tool_calls) messagesCount++;
        const block = /^example:(\d+):\d+$/.exec(spec.section.id);
        if (block) blocks.add(block[1]);
    }
    return { messages_count: messagesCount, examples_count: blocks.size, parts: promptParts(counted) };
}

/**
 * @param {{ spec: import('./model.js').ChatSpec, message: Message }[]} sent
 * @param {import('./chat-message.js').TokenHandler} tokenHandler
 * @returns {Promise<Message[]>}
 */
async function squash(sent, tokenHandler) {
    const out = [];

    /** @type {{ message: Message, squashes: boolean } | null} */
    let last = null;
    for (const { spec, message } of sent) {
        if (message.role === 'system' && !message.content) continue;
        const squashes = spec.section.squash !== false && message.role === 'system' && !message.name;
        if (squashes && last?.squashes) {
            last.message.content += '\n' + message.content;
            last.message.tokens = await tokenHandler.countAsync({ role: last.message.role, content: last.message.content });
            continue;
        }
        const copy = Object.assign(Object.create(Object.getPrototypeOf(message)), message);
        out.push(copy);
        last = { message: copy, squashes };
    }
    return out;
}
