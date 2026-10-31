import { Message, MessageCollection } from './chat-completion-budget.js';
import { Prompt, INJECTION_POSITION, isPromptDisabledForCharacter } from './chat-completion-prompt-collection.js';
import { populateInjectionPrompts } from './chat-completion-injection-prompts.js';
import { populateChatHistory, sanitizeChatCompletionName } from './chat-completion-history.js';
import { populateDialogueExamples } from './chat-completion-dialogue-examples.js';
import { substituteParams } from './macro-substitution.js';

/**
 * @typedef {import('./chat-completion-budget.js').ChatCompletion} ChatCompletion
 * @typedef {import('./chat-completion-budget.js').TokenHandler} TokenHandler
 * @typedef {import('./chat-completion-prompt-collection.js').PromptCollection} PromptCollection
 * @typedef {import('./chat-completion-prompt-collection.js').PromptOrderList} PromptOrderList
 * @typedef {import('./macro-substitution.js').SubstituteParamsContext} SubstituteParamsContext
 * @typedef {object} PopulateChatCompletionOptions
 * @property {string} [bias]
 * @property {string} [quietPrompt]
 * @property {string} [quietImage]
 * @property {boolean} [imageInlining]
 * @property {string} [imageQuality]
 * @property {string} [chatCompletionSource]
 * @property {{userImages?: string}} [directories]
 * @property {string} [type]
 * @property {string} [cyclePrompt]
 * @property {object[]} messages
 * @property {object[][]} [messageExamples]
 * @property {PromptOrderList[]} [promptOrder]
 * @property {string|number} [characterId]
 * @property {number} [toolBudgetTokens]
 * @property {boolean} [continuePrefill]
 * @property {boolean} [supportsAssistantPrefill]
 * @property {boolean} [namesInCompletion]
 * @property {string} [assistantPrefill]
 * @property {boolean} [pinExamples]
 * @property {import('./extension-prompt-table.js').ExtensionPromptTable} [injectionTable]
 * @property {SubstituteParamsContext} [macroContext]
 * @property {TokenHandler} tokenHandler
 * @property {import('./chat-completion-history.js').PopulateChatHistoryOptions} [historyOptions]
 * @property {import('./chat-completion-dialogue-examples.js').PopulateDialogueExamplesOptions} [dialogueExamplesOptions]
 */

/**
 * @param {PromptCollection} prompts
 * @param {ChatCompletion} chatCompletion
 * @param {PopulateChatCompletionOptions} options
 * @returns {Promise<{messages: object[]}>}
 */
export async function populateChatCompletion(prompts, chatCompletion, {
    bias = '',
    quietPrompt,
    quietImage,
    imageInlining = false,
    imageQuality = 'auto',
    chatCompletionSource,
    directories,
    type = null,
    cyclePrompt = null,
    messages,
    messageExamples,
    promptOrder = [],
    characterId,
    toolBudgetTokens = 0,
    continuePrefill = false,
    supportsAssistantPrefill = false,
    namesInCompletion = false,
    assistantPrefill = '',
    pinExamples = false,
    injectionTable = {},
    macroContext = {},
    tokenHandler,
    historyOptions = {},
    dialogueExamplesOptions = {},
} = {}) {
    void quietPrompt;

    const addToChatCompletion = async (source, target = null) => {
        if (false === prompts.has(source)) return;
        if (isPromptDisabledForCharacter(promptOrder, characterId, source) && source !== 'main') return;
        const prompt = prompts.get(source);
        if (prompt.injection_position === INJECTION_POSITION.ABSOLUTE) return;
        const index = target ? prompts.index(target) : prompts.index(source);
        const collection = new MessageCollection(source);
        const message = await Message.fromPromptAsync(prompt, tokenHandler);
        collection.add(message);
        chatCompletion.add(collection, index);
    };

    chatCompletion.reserveBudget(3);
    await addToChatCompletion('worldInfoBefore');
    await addToChatCompletion('main');
    await addToChatCompletion('worldInfoAfter');
    await addToChatCompletion('charDescription');
    await addToChatCompletion('charPersonality');
    await addToChatCompletion('scenario');
    await addToChatCompletion('personaDescription');

    chatCompletion.setOverriddenPrompts(prompts.overriddenPrompts);
    const controlPrompts = new MessageCollection('controlPrompts');

    const impersonateMessage = await Message.fromPromptAsync(prompts.get('impersonate'), tokenHandler) ?? null;
    if (type === 'impersonate') controlPrompts.add(impersonateMessage);

    const quietPromptMessage = await Message.fromPromptAsync(prompts.get('quietPrompt'), tokenHandler) ?? null;
    if (quietPromptMessage && quietPromptMessage.content) {
        if (imageInlining && quietImage) {
            await quietPromptMessage.addImage(quietImage, { quality: imageQuality, chatCompletionSource, directories });
        }
        controlPrompts.add(quietPromptMessage);
    }

    chatCompletion.reserveBudget(controlPrompts);

    const systemPrompts = ['nsfw', 'jailbreak'];
    const userRelativePrompts = prompts.collection
        .filter((prompt) => false === prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE)
        .reduce((acc, prompt) => { acc.push(prompt.identifier); return acc; }, []);
    const absolutePrompts = prompts.collection
        .filter((prompt) => prompt.injection_position === INJECTION_POSITION.ABSOLUTE)
        .reduce((acc, prompt) => { acc.push(prompt); return acc; }, []);

    for (const identifier of [...systemPrompts, ...userRelativePrompts]) await addToChatCompletion(identifier);

    if (prompts.has('enhanceDefinitions')) await addToChatCompletion('enhanceDefinitions');
    if (bias && bias.trim().length) await addToChatCompletion('bias');

    const injectToMain = async (prompt, position) => {
        if (chatCompletion.has('main')) {
            const message = await Message.fromPromptAsync(prompt, tokenHandler);
            chatCompletion.insert(message, 'main', position);
        } else {
            const indexOfMain = absolutePrompts.findIndex(p => p.identifier === 'main');
            if (indexOfMain >= 0) {
                const main = absolutePrompts[indexOfMain];
                const promptCopy = new Prompt(prompt);
                promptCopy.role = main.role;
                promptCopy.injection_position = main.injection_position;
                promptCopy.injection_depth = main.injection_depth;
                promptCopy.injection_order = main.injection_order;
                const newIndex = position === 'end' ? indexOfMain + 1 : indexOfMain;
                absolutePrompts.splice(newIndex, 0, promptCopy);
            }
        }
    };

    const knownPrompts = ['summary', 'authorsNote', 'vectorsMemory', 'vectorsDataBank', 'smartContext'];
    for (const key of knownPrompts) {
        if (prompts.has(key)) {
            const prompt = prompts.get(key);
            if (prompt.position) await injectToMain(prompt, prompt.position);
        }
    }
    for (const prompt of prompts.collection.filter(p => p.extension && p.position)) await injectToMain(prompt, prompt.position);

    if (toolBudgetTokens > 0) {
        chatCompletion.reserveBudget(toolBudgetTokens);
    }

    if (type === 'continue' && continuePrefill && messages.length) {
        const chatMessage = messages.shift();
        const isAssistantRole = chatMessage.role === 'assistant';
        const prefill = isAssistantRole && supportsAssistantPrefill ? substituteParams(assistantPrefill, macroContext) : '';
        const messageContent = [prefill, chatMessage.content].filter(x => x).join('\n\n');
        const continueMessage = await Message.createAsync(chatMessage.role, messageContent, 'continuePrefill', tokenHandler);
        if (chatMessage.name && namesInCompletion) await continueMessage.setName(sanitizeChatCompletionName(chatMessage.name), tokenHandler);
        controlPrompts.add(continueMessage);
        chatCompletion.reserveBudget(continueMessage);
    }

    let workingMessages = populateInjectionPrompts(absolutePrompts, messages, { table: injectionTable, macroContext });

    const sharedHistoryOptions = { type, cyclePrompt, continuePrefill, tokenHandler, macroContext, ...historyOptions };
    const sharedDialogueExamplesOptions = { tokenHandler, macroContext, ...dialogueExamplesOptions };

    if (pinExamples) {
        await populateDialogueExamples(prompts, chatCompletion, messageExamples, sharedDialogueExamplesOptions);
        await populateChatHistory(workingMessages, prompts, chatCompletion, sharedHistoryOptions);
    } else {
        await populateChatHistory(workingMessages, prompts, chatCompletion, sharedHistoryOptions);
        await populateDialogueExamples(prompts, chatCompletion, messageExamples, sharedDialogueExamplesOptions);
    }

    chatCompletion.freeBudget(controlPrompts);
    if (controlPrompts.collection.length) chatCompletion.add(controlPrompts);

    return { messages: workingMessages };
}
