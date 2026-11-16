import { getCurrentCharacter, getCurrentChatId } from '../script.js';
import { selected_group } from './group-chats.js';
import { t } from './i18n.js';
import { switchToNode } from './node-navigation.js';
import { fixToastrForDialogs } from './popup.js';
import { timestampToMoment } from './utils.js';
import { openRecentCharacterChat, openRecentGroupChat } from './welcome-screen.js';

/** @type {import('/ui/entry.js').StartOptions['recentHistory']} */
export const recentHistoryOldPage = {
    async go(chat, nodeId) {
        const owner = chat.owner;
        const open = 'avatar' in owner
            ? (selected_group == null || selected_group === '') && getCurrentCharacter()?.avatar === owner.avatar
            : String(selected_group) === owner.group;
        if (!open || getCurrentChatId() !== chat.name) {
            if ('avatar' in owner) await openRecentCharacterChat(owner.avatar, chat.name);
            else await openRecentGroupChat(owner.group, chat.name);
            if (getCurrentChatId() !== chat.name) return t`The chat couldn't be opened.`;
        }
        // A group chat opens where it is: going to one of its messages isn't supported yet (`switchToNode`).
        if ('group' in owner) return null;
        return await switchToNode(nodeId) ? null : t`The message couldn't be shown.`;
    },
    date: value => timestampToMoment(value).format('lll'),
    failed: message => toastr.warning(message),
    dialogsChanged: fixToastrForDialogs,
};
