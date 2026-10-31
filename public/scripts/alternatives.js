import { SWIPE_DIRECTION, SWIPE_SOURCE } from './constants.js';
import { t } from './i18n.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { power_user } from './power-user.js';
import { getTokenizerState } from './tokenizers.js';
import { copyText, timestampToMoment } from './utils.js';
import { messageFormatting } from './message-formatting.js';
import { isStoredNodeId } from './node-identity.js';
import { selected_group } from './group-chats.js';
import { newUi } from './new-ui-page.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { applyServerGreetings, deleteSwipe, ensureSwipes, isMessageSwipeable, isSwipingAllowed, swipe, syncMesToSwipe } from '/script.js';
import { chat } from '/scripts/chat-state.js';

/**
 * @param {number} messageId
 * @returns {boolean}
 */
export function canOpenSwipePickerForMessage(messageId) {
    const message = chat[messageId];
    if (!message) {
        return false;
    }
    if (ensureSwipes(message)) {
        syncMesToSwipe(messageId);
    }
    return Boolean(message.swipes?.length > 1 && !message.extra?.isSmallSys && message.extra?.swipeable !== false);
}

/**
 * @param {number} messageId
 * @returns {string|null}
 */
function cantGo(messageId) {
    if (!isSwipingAllowed()) return t`The chat can't change its messages now (a reply is being written).`;
    if (!isMessageSwipeable(messageId, chat[messageId])) return t`This message can't be swiped now (a message above it is being edited).`;
    return null;
}

/**
 * @param {number} messageId
 * @returns {boolean}
 */
export function canJumpToSwipeForMessage(messageId) {
    return canOpenSwipePickerForMessage(messageId) && cantGo(messageId) === null;
}

/**
 * @param {number} messageId
 * @param {number} index
 */
async function go(messageId, index) {
    const message = chat[messageId];
    if (!message) return;
    const shown = Number(message.swipe_id ?? 0);
    if (index === shown) return;
    const direction = index > shown ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
    await swipe(null, direction, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: messageId, forceSwipeId: index });
}

/** @type {import('/ui/entry.js').StartOptions['alternatives']} */
export const alternativesOldPage = {
    format(text, item, mesId) {
        const html = messageFormatting(text, item.name, item.role === 'system', item.role === 'user', mesId ?? 0);
        const template = document.createElement('template');
        template.innerHTML = html;
        return template.content;
    },
    date: value => timestampToMoment(value).format('lll'),
    tokenizer: () => getTokenizerState(),
    cantGo,
    go,
    async remove(messageId, index) {
        if (power_user.confirm_message_delete) {
            const result = await callGenericPopup(t`Are you sure you want to delete swipe #${index + 1}?`, POPUP_TYPE.CONFIRM, null, {
                okButton: t`Delete Swipe`,
                cancelButton: t`Cancel`,
            });
            if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        }
        await deleteSwipe(index, messageId, { ask: true });
    },
    async copy(text) {
        await copyText(text);
        toastr.info(t`Copied!`, '', { timeOut: 2000 });
    },
    greetingsChanged(card, edit) {
        void applyServerGreetings(card.avatar, card, edit);
    },
};

/**
 * @param {number} messageId
 * @param {number} [at]
 */
export function openAlternatives(messageId, at) {
    const message = chat[messageId];
    if (!canOpenSwipePickerForMessage(messageId)) {
        toastr.info(t`This message has no other alternatives yet.`);
        return;
    }
    const opening = messageId === 0 && selected_group == null;
    if (!opening && !isStoredNodeId(message.node_id)) {
        toastr.info(t`This message isn't saved yet.`);
        return;
    }
    newUi().alternatives.openMessage(messageId, opening ? null : String(message.node_id), String(message.name ?? ''), at);
}

export function initSwipePicker() {
    /** @param {JQuery.TriggeredEvent} event */
    function onCounter(event) {
        event.preventDefault();
        event.stopPropagation();
        openAlternatives(Number($(event.currentTarget).closest('.mes').attr('mesid')));
    }
    $(document).on('click', '.swipes-counter.swipe-picker-enabled, .mes_swipe_picker', onCounter);
    $(document).on('keydown', '.swipes-counter.swipe-picker-enabled', function (event) {
        if (event.key === ' ' || event.key === 'Enter') onCounter(event);
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'swipe-go',
        callback: async (args, value) => {
            const messageId = args.message === undefined || args.message === '' ? chat.length - 1 : Number(args.message);
            const number = Number(value);
            const message = chat[messageId];
            if (!message || !Number.isInteger(number) || number < 1 || number > (message.swipes?.length ?? 1)) {
                toastr.warning(t`No such alternative.`);
                return '';
            }
            const why = cantGo(messageId);
            if (why) {
                toastr.warning(why);
                return '';
            }
            await go(messageId, number - 1);
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'message',
                description: 'The message (its id); the last one when not given.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Which alternative (its number, from 1)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: true,
            }),
        ],
        helpString: 'The chat goes to that alternative (swipe) of a message, as Go in its list of alternatives does.',
    }));
}
