import { Message, MessageCollection } from './chat-completion-budget.js';
import { substituteParams } from './macro-substitution.js';

/**
 * @typedef {import('./chat-completion-budget.js').TokenHandler} TokenHandler
 * @typedef {import('./chat-completion-budget.js').ChatCompletion} ChatCompletion
 * @typedef {import('./chat-completion-prompt-collection.js').PromptCollection} PromptCollection
 * @typedef {object} DialogueExamplePrompt
 * @property {string} [content]
 * @property {string} [name]
 * @typedef {object} PopulateDialogueExamplesOptions
 * @property {string} [newExampleChatPrompt]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 * @property {TokenHandler} [tokenHandler]
 */

/**
 * @param {PromptCollection} prompts
 * @param {ChatCompletion} chatCompletion
 * @param {DialogueExamplePrompt[][]} messageExamples
 * @param {PopulateDialogueExamplesOptions} [options]
 * @returns {Promise<void>}
 */
export async function populateDialogueExamples(prompts, chatCompletion, messageExamples, { newExampleChatPrompt, macroContext, tokenHandler } = {}) {
    if (!prompts.has('dialogueExamples')) {
        return;
    }

    chatCompletion.add(new MessageCollection('dialogueExamples'), prompts.index('dialogueExamples'));

    if (Array.isArray(messageExamples) && messageExamples.length) {
        const newExampleChat = await Message.createAsync('system', substituteParams(newExampleChatPrompt, macroContext), 'newChat', tokenHandler);

        let dialogueIndex = 0;
        for (const dialogue of messageExamples) {
            const chatMessages = [];
            for (let promptIndex = 0; promptIndex < dialogue.length; promptIndex++) {
                const prompt = dialogue[promptIndex];
                const role = 'system';
                const content = prompt.content || '';
                const identifier = `dialogueExamples ${dialogueIndex}-${promptIndex}`;
                const chatMessage = await Message.createAsync(role, content, identifier, tokenHandler);
                await chatMessage.setName(prompt.name, tokenHandler);
                chatMessages.push(chatMessage);
            }

            if (!chatCompletion.canAffordAll([newExampleChat, ...chatMessages])) {
                break;
            }

            chatCompletion.insert(newExampleChat, 'dialogueExamples');
            for (const chatMessage of chatMessages) {
                chatCompletion.insert(chatMessage, 'dialogueExamples');
            }

            dialogueIndex++;
        }
    }
}
