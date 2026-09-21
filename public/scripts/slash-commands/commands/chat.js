import { SlashCommandParser } from '../SlashCommandParser.js';
import { SlashCommand } from '../SlashCommand.js';
import { chat, closeCurrentChat, displayPastChats, getCurrentChatDetails, getCurrentChatId, getFirstDisplayedMessageId, newAssistantChat, reloadCurrentChat, renameChat, saveChatConditional, saveSettings, showMoreMessages } from '../../../script.js';
import { eventSource, event_types } from '../../events.js';
import { debounce_timeout } from '../../constants.js';
import { t } from '../../i18n.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../SlashCommandArgument.js';
import { commonEnumProviders } from '../SlashCommandCommonEnumsProvider.js';
import { delay, flashHighlight, isTrueBoolean } from '../../utils.js';

export function registerChatCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'delchat',
        callback: async function () {
            return displayPastChats().then(() => new Promise((resolve) => {
                let resolved = false;
                const timeOutId = setTimeout(() => {
                    toastr.error(t`Chat deletion timed out. Please try again.`);
                    setResolved();
                }, 5000);

                const setResolved = () => {
                    if (resolved) {
                        return;
                    }
                    resolved = true;
                    [event_types.CHAT_DELETED, event_types.GROUP_CHAT_DELETED].forEach((eventType) => {
                        eventSource.removeListener(eventType, setResolved);
                    });
                    clearTimeout(timeOutId);
                    resolve('');
                };

                [event_types.CHAT_DELETED, event_types.GROUP_CHAT_DELETED].forEach((eventType) => {
                    eventSource.on(eventType, setResolved);
                });

                const currentChatDeleteButton = $('.select_chat_block[highlight=\'true\']').parent().find('.PastChat_cross');
                $(currentChatDeleteButton).trigger('click', { fromSlashCommand: true });
            }));
        },
        helpString: t`Deletes the current chat.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'renamechat',
        callback: async function doRenameChat(_, chatName) {
            if (!chatName) {
                toastr.warning(t`Name must be provided as an argument to rename this chat.`);
                return '';
            }

            const currentChatName = getCurrentChatId();
            if (!currentChatName) {
                toastr.warning(t`No chat selected that can be renamed.`);
                return '';
            }

            await renameChat(currentChatName, chatName.toString());

            toastr.success(t`Successfully renamed chat to: ${chatName}`);
            return '';
        },
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`new chat name`, [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: t`Renames the current chat.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getchatname',
        callback: async function doGetChatName() {
            return getCurrentChatDetails().sessionName;
        },
        returns: t`chat file name`,
        helpString: t`Returns the name of the current chat file into the pipe.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'closechat',
        callback: async function () {
            await closeCurrentChat();
            return '';
        },
        helpString: t`Closes the current chat.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tempchat',
        callback: () => {
            return new Promise((resolve, reject) => {
                const eventCallback = async (chatId) => {
                    if (chatId) {
                        return reject(t`Not in a temporary chat`);
                    }
                    await newAssistantChat({ temporary: true });
                    return resolve('');
                };
                eventSource.once(event_types.CHAT_CHANGED, eventCallback);
                // Not awaited: resolution comes from the CHAT_CHANGED listener above.
                void closeCurrentChat();
                setTimeout(() => {
                    reject(t`Failed to open temporary chat`);
                    eventSource.removeListener(event_types.CHAT_CHANGED, eventCallback);
                }, debounce_timeout.relaxed);
            });
        },
        helpString: t`Opens a temporary chat with Assistant.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'forcesave',
        callback: async function () {
            await saveSettings();
            await saveChatConditional();
            toastr.success(t`Chat and settings saved.`);
            return '';
        },
        helpString: t`Forces a save of the current chat and settings`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'chat-manager',
        callback: () => {
            $('#option_select_chat').trigger('click');
            return '';
        },
        aliases: ['chat-history', 'manage-chats'],
        helpString: t`Opens the chat manager for the current character/group.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'chat-render',
        helpString: t`Renders a specified number of messages into the chat window. Displays all messages if no argument is provided.`,
        callback: async (args, number) => {
            await showMoreMessages(number && !isNaN(Number(number)) ? Number(number) : Number.MAX_SAFE_INTEGER);
            if (isTrueBoolean(String(args?.scroll ?? ''))) {
                $('#chat').scrollTop(0);
            }
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'scroll',
                description: t`scroll to the top after rendering`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`number of messages`, [ARGUMENT_TYPE.NUMBER], false,
            ),
        ],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'chat-reload',
        helpString: t`Reloads the current chat.`,
        callback: async () => {
            await reloadCurrentChat();
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'chat-jump',
        aliases: ['chat-scrollto', 'floor-teleport'],
        callback: async (_, index) => {
            const messageIndex = Number(index);

            if (isNaN(messageIndex) || messageIndex < 0 || messageIndex >= chat.length) {
                toastr.warning(t`Invalid message index: ${index}. Please enter a number between 0 and ${chat.length}.`);
                console.warn(`WARN: Invalid message index provided for /chat-jump: ${index}. Max index: ${chat.length}`);
                return '';
            }

            const firstDisplayedMessageId = getFirstDisplayedMessageId();
            if (isFinite(firstDisplayedMessageId) && messageIndex < firstDisplayedMessageId) {
                const needToLoadCount = firstDisplayedMessageId - messageIndex;
                await showMoreMessages(needToLoadCount);
                await delay(debounce_timeout.quick);
            }

            const chatContainer = document.getElementById('chat');
            const messageElement = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);

            if (messageElement instanceof HTMLElement && chatContainer instanceof HTMLElement) {
                const elementRect = messageElement.getBoundingClientRect();
                const containerRect = chatContainer.getBoundingClientRect();

                const scrollPosition = elementRect.top - containerRect.top + chatContainer.scrollTop;
                chatContainer.scrollTo({
                    top: scrollPosition,
                    behavior: 'smooth',
                });

                flashHighlight($(messageElement), 2000);
            } else {
                toastr.warning(t`Could not find element for message ${messageIndex}. It might not be rendered yet or the index is invalid.`);
                console.warn(`WARN: Element not found for message index ${messageIndex} in /chat-jump.`);
            }

            return '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`The message index (0-based) to scroll to.`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: true,
                enumProvider: commonEnumProviders.messages(),
            }),
        ],
        helpString: `
        <div>
            ${t`Scrolls the chat view to the specified message index. Index starts at 0.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong> <pre><code>/chat-jump 10</code></pre> ${t`Scrolls to the 11th message (id=10).`}
        </div>
    `,
    }));
}
