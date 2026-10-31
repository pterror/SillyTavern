import { Message, MessageCollection } from './chat-completion-budget.js';
import { Prompt, preparePrompt } from './chat-completion-prompt-collection.js';
import { substituteParams } from './macro-substitution.js';
import { character_names_behavior } from './chat-completion-messages.js';

/** @enum {string} */
const MEDIA_DISPLAY = {
    LIST: 'list',
    GALLERY: 'gallery',
};

/**
 * @enum {string}
 */
const MEDIA_TYPE = {
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
};

/**
 * @typedef {import('./chat-completion-budget.js').TokenHandler} TokenHandler
 * @typedef {import('./chat-completion-budget.js').ChatCompletion} ChatCompletion
 * @typedef {import('./chat-completion-prompt-collection.js').PromptCollection} PromptCollection
 * @typedef {import('./macro-substitution.js').SubstituteParamsContext} SubstituteParamsContext
 * @typedef {object} ToolInvocation
 * @property {string} id
 * @property {string} name
 * @property {any} [parameters]
 * @property {string} [result]
 * @property {string} [signature]
 * @property {string} [reasoning]
 * @typedef {object} ChatHistoryMessage
 * @property {string} role
 * @property {string} [content]
 * @property {string} [name]
 * @property {boolean} [injected]
 * @property {string} [identifier]
 * @property {string} [signature]
 * @property {string} [reasoning]
 * @property {ToolInvocation[]} [invocations]
 * @typedef {object} PopulateChatHistoryOptions
 * @property {string} [type]
 * @property {string} [cyclePrompt]
 * @property {boolean} [isGroup]
 * @property {string} [newChatPrompt]
 * @property {string} [newGroupChatPrompt]
 * @property {boolean} [continuePrefill]
 * @property {string} [continueNudgePrompt]
 * @property {string} [sendIfEmpty]
 * @property {number} [namesBehavior]
 * @property {boolean} [imageInlining]
 * @property {boolean} [videoInlining]
 * @property {boolean} [audioInlining]
 * @property {string} [imageQuality]
 * @property {string} [chatCompletionSource]
 * @property {{userImages?: string}} [directories]
 * @property {boolean} [canUseTools]
 * @property {boolean} [includeSignature]
 * @property {string} [toolReasoningMode]
 * @property {boolean} [includeToolReasoning]
 * @property {TokenHandler} [tokenHandler]
 * @property {SubstituteParamsContext} [macroContext]
 */

/** @enum {string} */
export const TOOL_REASONING_MODES = {
    DISABLED: 'disabled',
    SINCE_LAST_USER: 'since_last_user',
    ACTIVE_CHAIN: 'active_chain',
};

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isValidChatCompletionName(name) {
    const regex = /^[a-zA-Z0-9_]{1,64}$/;
    return regex.test(name);
}

/**
 * @param {string} name
 * @returns {string}
 */
export function sanitizeChatCompletionName(name) {
    return name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64);
}

/**
 * @param {ChatHistoryMessage[]} messages
 * @param {PromptCollection} prompts
 * @param {ChatCompletion} chatCompletion
 * @param {PopulateChatHistoryOptions} [options]
 * @returns {Promise<void>}
 */
export async function populateChatHistory(messages, prompts, chatCompletion, {
    type = null,
    cyclePrompt = null,
    isGroup = false,
    newChatPrompt = '',
    newGroupChatPrompt = '',
    continuePrefill = false,
    continueNudgePrompt = '',
    sendIfEmpty = '',
    namesBehavior = character_names_behavior.NONE,
    imageInlining = false,
    videoInlining = false,
    audioInlining = false,
    imageQuality = 'auto',
    chatCompletionSource,
    directories,
    canUseTools = false,
    includeSignature = false,
    toolReasoningMode = TOOL_REASONING_MODES.DISABLED,
    includeToolReasoning = false,
    tokenHandler,
    macroContext = {},
} = {}) {
    if (!prompts.has('chatHistory')) {
        return;
    }

    chatCompletion.add(new MessageCollection('chatHistory'), prompts.index('chatHistory'));

    const newChat = isGroup ? newGroupChatPrompt : newChatPrompt;
    const newChatMessage = await Message.createAsync('system', substituteParams(newChat, macroContext), 'newMainChat', tokenHandler);
    chatCompletion.reserveBudget(newChatMessage);

    let groupNudgeMessage = null;
    const noGroupNudgeTypes = ['impersonate'];
    if (isGroup && prompts.has('groupNudge') && !noGroupNudgeTypes.includes(type)) {
        groupNudgeMessage = await Message.fromPromptAsync(prompts.get('groupNudge'), tokenHandler);
        chatCompletion.reserveBudget(groupNudgeMessage);
    }

    let continueMessageCollection = null;
    if (type === 'continue' && cyclePrompt && !continuePrefill) {
        const promptObject = {
            identifier: 'continueNudge',
            role: 'system',
            content: substituteParams(continueNudgePrompt, {
                ...macroContext,
                dynamicMacros: { ...macroContext.dynamicMacros, lastChatMessage: String(cyclePrompt).trim() },
            }),
            system_prompt: true,
        };
        continueMessageCollection = new MessageCollection('continueNudge');
        const continueMessageIndex = messages.findLastIndex(x => !x.injected);
        if (continueMessageIndex >= 0) {
            const continueMessage = messages.splice(continueMessageIndex, 1)[0];
            const prompt = new Prompt(continueMessage);
            const chatMessage = await Message.fromPromptAsync(preparePrompt(prompt, { macroContext }), tokenHandler);
            continueMessageCollection.add(chatMessage);
        }
        const continueNudgePromptInstance = new Prompt(promptObject);
        const preparedNudgePrompt = preparePrompt(continueNudgePromptInstance, { macroContext });
        const continueNudgeMessage = await Message.fromPromptAsync(preparedNudgePrompt, tokenHandler);
        continueMessageCollection.add(continueNudgeMessage);
        chatCompletion.reserveBudget(continueMessageCollection);
    }

    const lastChatPrompt = messages[messages.length - 1];
    const message = await Message.createAsync('user', sendIfEmpty, 'emptyUserMessageReplacement', tokenHandler);
    if (lastChatPrompt && lastChatPrompt.role === 'assistant' && sendIfEmpty && chatCompletion.canAfford(message)) {
        chatCompletion.insert(message, 'chatHistory');
    }

    const lastUserIdx = messages.findLastIndex(x => x.role === 'user');

    const chatPool = [...messages].reverse();
    for (let index = 0; index < chatPool.length; index++) {
        const chatPrompt = chatPool[index];
        const prompt = new Prompt(chatPrompt);
        prompt.identifier = `chatHistory-${messages.length - index}`;
        const chatMessage = await Message.fromPromptAsync(preparePrompt(prompt, { macroContext }), tokenHandler);

        if (namesBehavior === character_names_behavior.COMPLETION && prompt.name) {
            const messageName = isValidChatCompletionName(prompt.name) ? prompt.name : sanitizeChatCompletionName(prompt.name);
            await chatMessage.setName(messageName, tokenHandler);
        }

        const inlineMediaAttachment = async (media) => {
            if (!media || !media.url) return;
            const mediaType = media.type || MEDIA_TYPE.IMAGE;
            if (imageInlining && mediaType === MEDIA_TYPE.IMAGE) {
                await chatMessage.addImage(media.url, { quality: imageQuality, chatCompletionSource, directories });
            }
            if (videoInlining && mediaType === MEDIA_TYPE.VIDEO) {
                await chatMessage.addVideo(media.url, { quality: imageQuality, directories });
            }
            if (audioInlining && mediaType === MEDIA_TYPE.AUDIO) {
                await chatMessage.addAudio(media.url, { directories });
            }
        };

        if (Array.isArray(chatPrompt.media) && chatPrompt.media.length) {
            if (chatPrompt.mediaDisplay === MEDIA_DISPLAY.LIST) {
                for (const media of chatPrompt.media) {
                    await inlineMediaAttachment(media);
                }
            }
            if (chatPrompt.mediaDisplay === MEDIA_DISPLAY.GALLERY) {
                const media = chatPrompt.media[chatPrompt.mediaIndex];
                await inlineMediaAttachment(media);
            }
        }

        if (canUseTools && Array.isArray(chatPrompt.invocations)) {
            const promptIdx = messages.indexOf(chatPrompt);
            const reasoningIsEligible = toolReasoningMode !== TOOL_REASONING_MODES.DISABLED && promptIdx > lastUserIdx;
            let previousAssistantReasoning = '';
            if (reasoningIsEligible) {
                if (toolReasoningMode === TOOL_REASONING_MODES.ACTIVE_CHAIN) {
                    for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                        const candidate = messages[idx];
                        if (candidate?.role === 'tool') continue;
                        if (candidate?.role === 'assistant' && Array.isArray(candidate.invocations)) continue;
                        const hasAssistantText = candidate?.role === 'assistant' && !Array.isArray(candidate.invocations) && typeof candidate.content === 'string' && candidate.content.trim().length > 0;
                        if (hasAssistantText) previousAssistantReasoning = String(candidate.reasoning ?? '');
                        break;
                    }
                } else if (toolReasoningMode === TOOL_REASONING_MODES.SINCE_LAST_USER) {
                    for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                        const candidate = messages[idx];
                        const hasAssistantText = candidate?.role === 'assistant' && !Array.isArray(candidate.invocations) && typeof candidate.content === 'string' && candidate.content.trim().length > 0;
                        if (!hasAssistantText) continue;
                        const candidateReasoning = String(candidate.reasoning ?? '');
                        if (candidateReasoning) { previousAssistantReasoning = candidateReasoning; break; }
                    }
                }
            }
            const invocations = chatPrompt.invocations.map(invocation => {
                const clone = structuredClone(invocation);
                if (!reasoningIsEligible) delete clone.reasoning;
                else if (previousAssistantReasoning && !clone.reasoning) clone.reasoning = previousAssistantReasoning;
                return clone;
            });
            const toolCallMessage = await Message.createAsync(chatMessage.role, undefined, 'toolCall-' + chatMessage.identifier, tokenHandler);
            const toolResultMessages = await Promise.all(invocations.slice().reverse().map((invocation) => Message.createAsync('tool', invocation.result || '[No content]', invocation.id, tokenHandler)));
            await toolCallMessage.setToolCalls(invocations, includeSignature, includeToolReasoning, tokenHandler);
            if (chatCompletion.canAffordAll([toolCallMessage, ...toolResultMessages])) {
                for (const resultMessage of toolResultMessages) chatCompletion.insertAtStart(resultMessage, 'chatHistory');
                chatCompletion.insertAtStart(toolCallMessage, 'chatHistory');
            } else {
                break;
            }
            continue;
        }

        if (includeSignature && chatPrompt.signature) chatMessage.signature = chatPrompt.signature;

        if (chatCompletion.canAfford(chatMessage)) {
            chatCompletion.insertAtStart(chatMessage, 'chatHistory');
        } else {
            break;
        }
    }

    chatCompletion.freeBudget(newChatMessage);
    chatCompletion.insertAtStart(newChatMessage, 'chatHistory');

    if (isGroup && groupNudgeMessage) {
        chatCompletion.freeBudget(groupNudgeMessage);
        chatCompletion.insertAtEnd(groupNudgeMessage, 'chatHistory');
    }

    if (type === 'continue' && continueMessageCollection) {
        chatCompletion.freeBudget(continueMessageCollection);
        chatCompletion.add(continueMessageCollection, -1);
    }
}
