import { t } from './i18n.js';
import { isStoredNodeId } from './node-identity.js';
import { newUi } from './new-ui-page.js';
import { openEmbeddedLoreEditor, openWorldInfoEntry } from './world-info.js';
import { chat } from '/scripts/chat-state.js';

/** @type {import('/ui/entry.js').StartOptions['activations']} */
export const activationsOldPage = {
    messageNumber(nodeId) {
        const index = chat.findIndex(message => message?.node_id === nodeId);
        return index === -1 ? null : index;
    },
    openEntry(book, uid) {
        void openWorldInfoEntry(book, uid);
    },
    openCardBook(avatar) {
        void openEmbeddedLoreEditor(avatar);
    },
};

/**
 * @param {Record<string, any>} message
 * @param {JQuery<HTMLElement>} messageElement
 */
export function updateLoreMark(message, messageElement) {
    const record = message?.is_user ? null : message?.extra?.activations;
    const mark = messageElement.find('.mes_lore');
    const count = Array.isArray(record?.entries) ? record.entries.length : 0;
    mark.prop('hidden', !record);
    mark.find('.mes_lore_count').text(record ? String(count) : '');
}

export function initLoreMarks() {
    /** @param {JQuery.TriggeredEvent} event */
    function onMark(event) {
        event.preventDefault();
        event.stopPropagation();
        const message = chat[Number($(event.currentTarget).closest('.mes').attr('mesid'))];
        if (!isStoredNodeId(message?.node_id)) {
            toastr.info(t`This message isn't saved yet.`);
            return;
        }
        newUi().activations.open(String(message.node_id));
    }
    $(document).on('click', '.mes_lore', onMark);
    $(document).on('keydown', '.mes_lore', function (event) {
        if (event.key === ' ' || event.key === 'Enter') onMark(event);
    });
}
