import {
    canStopGenerating,
    chat,
    deleteMessage,
    is_send_press,
    isSwipingAllowed,
    leaveMessageEdit,
    messageEditOpen,
    requestTextareaSend,
    stopGenerating,
} from '../script.js';
import { editLastMessage, shouldSendOnEnter, swipeLast } from './RossAscends-mods.js';
import { chatBoxFocused, chatBoxSuggesting, chatBoxText, focusChatBox } from './chat-box.js';
import { fieldEditOpen, handleFieldEditKey } from './character-field-editor.js';
import { loadedChatEditor } from './chat-text/editors.js';
import { FORMAT_KEYS, formatCommandId } from './chat-text/format-keys.js';
import { formatTextarea } from './input-md-formatting.js';
import { t } from './i18n.js';
import { newUi } from './new-ui-page.js';
import { Popup } from './popup.js';
import { power_user } from './power-user.js';
import { accountStorage } from './util/AccountStorage.js';

/** @typedef {import('/ui/entry.js').Command} Command */

/** @returns {boolean} whether focus is in a field text is typed into */
function typingInField() {
    const active = document.activeElement;
    return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable);
}

/** @returns {boolean} whether keys go to the chat: focus is in the chat box, or on nothing that takes them itself */
function chatHasKeys() {
    if (chatBoxFocused()) return true;
    const active = document.activeElement;
    if (active === null || active === document.body) return true;
    return !typingInField() && !(active instanceof HTMLVideoElement) && active.closest('#sheld') !== null;
}

const chatBoxEmptyFocused = () => chatBoxFocused() && chatBoxText() === '' && !chatBoxSuggesting();

/** @returns {boolean} whether the last message can be swiped from the keyboard */
function canSwipeByKey() {
    if (!isSwipingAllowed() || document.body.classList.contains('nGY2_body_scrollbar')) return false;
    if ($('#shadow_select_chat_popup').css('display') !== 'none') return false;
    return chatBoxEmptyFocused() || (chatHasKeys() && !chatBoxFocused());
}

/** @param {number} to where the chat scrolls to, in px from its top */
function scrollChat(to) {
    $('#chat').animate({ scrollTop: to }, 300);
}

async function regenerate() {
    const skipConfirmKey = 'RegenerateWithCtrlEnter';
    if (accountStorage.getItem(skipConfirmKey) !== 'true') {
        let dontAsk = false;
        const result = await Popup.show.confirm(t`Regenerate Message`, t`Are you sure you want to regenerate the latest message?`, {
            customInputs: [{ id: 'regenerateWithCtrlEnter', label: t`Don't ask again` }],
            onClose: (popup) => {
                dontAsk = Boolean(popup.inputResults.get('regenerateWithCtrlEnter') ?? false);
            },
        });
        if (!result) return;
        accountStorage.setItem(skipConfirmKey, String(dontAsk));
    }
    $('#option_regenerate').trigger('click');
    $('#options').hide();
}

/**
 * The first panel Escape closes, top down, as a function that closes it
 * @returns {(() => void) | undefined}
 */
function topPanelCloser() {
    const click = (/** @type {string} */ selector) => () => void $(selector).trigger('click');
    if ($('#dialogue_popup').is(':visible')) {
        return $('#dialogue_popup_cancel').is(':visible') ? click('#dialogue_popup_cancel') : click('#dialogue_popup_ok');
    }
    if ($('#select_chat_popup').is(':visible')) return click('#select_chat_cross');
    if ($('#dialogue_del_mes_cancel').is(':visible')) return click('#dialogue_del_mes_cancel');
    const drawers = $('.drawer-content:visible')
        .not('#left-nav-panel')
        .not('#right-nav-panel')
        .not('#floatingPrompt')
        .not('#cfgConfig')
        .not('#logprobsViewer')
        .not('#movingDivs > div');
    if (drawers.length) return () => void drawers.parent().find('.drawer-icon').trigger('click');
    if ($('#logprobsViewer').is(':visible')) return click('#logprobsViewerClose');
    if ($('#cfgConfig').is(':visible')) return click('#CFGClose');
    if ($('#floatingPrompt').is(':visible')) return click('#ANClose');
    const moving = $('#movingDivs > div').toArray().reverse().find(div => $(div).is(':visible'));
    if (moving) return () => void $(moving).find('.floating_panel_close, .dragClose').trigger('click');
    if ($('#left-nav-panel').is(':visible') && $('#lm_button_panel_pin').prop('checked') === false) return click('#leftNavDrawerIcon');
    if ($('#right-nav-panel').is(':visible') && $('#rm_button_panel_pin').prop('checked') === false) return click('#rightNavDrawerIcon');
    if ($('.draggable').is(':visible')) return () => void $('.draggable:first').remove();
    return undefined;
}

/**
 * The commands on a message, for the right-click menu (one message) and for keys and the palette (the message focus
 * is in). Each runs the message's own button, so a command does what the button does and applies where it is shown.
 * @param {() => HTMLElement | null} messageOf
 * @returns {Command[]}
 */
function messageCommands(messageOf) {
    const category = t`Message`;
    /**
     * @param {string} id
     * @param {string} label
     * @param {string} button the button's class
     * @param {'click' | 'pointerup'} [event] what the button's handler listens for
     * @returns {Command}
     */
    const byButton = (id, label, button, event = 'click') => ({
        id,
        label,
        category,
        when: () => {
            const found = messageOf()?.querySelector(`.${button}`);
            return found instanceof HTMLElement && getComputedStyle(found).display !== 'none';
        },
        run: () => {
            const found = messageOf()?.querySelector(`.${button}`);
            if (!found) return false;
            $(found).trigger(event);
            return true;
        },
    });
    const idOf = () => Number(messageOf()?.getAttribute('mesid'));
    return [
        byButton('message.edit', t`Edit`, 'mes_edit'),
        byButton('message.copy', t`Copy`, 'mes_copy', 'pointerup'),
        byButton('message.alternatives', t`Swipe history`, 'mes_swipe_picker'),
        byButton('message.bookmark', t`Bookmark`, 'mes_bookmark_add'),
        byButton('message.hide', t`Exclude from prompts`, 'mes_hide'),
        byButton('message.unhide', t`Include in prompts`, 'mes_unhide'),
        byButton('message.embed', t`Attach file`, 'mes_embed'),
        byButton('message.prompt', t`Show prompt`, 'mes_prompt', 'pointerup'),
        byButton('message.greeting', t`Show in character info`, 'mes_show_greeting'),
        {
            id: 'message.delete',
            label: t`Delete`,
            category,
            when: () => {
                const id = idOf();
                return Number.isInteger(id) && chat[id] !== undefined && !messageEditOpen();
            },
            run: () => {
                void deleteMessage(idOf(), undefined, power_user.confirm_message_delete);
            },
        },
    ];
}

/** @returns {HTMLElement | null} the message focus is in */
function focusedMessage() {
    const found = document.activeElement?.closest('#chat .mes');
    return found instanceof HTMLElement ? found : null;
}

/**
 * Opens the right-click menu on a message, at the pointer for a click and below the message for a key
 * @param {Event} event
 * @returns {boolean} whether it opened, so a click elsewhere keeps the browser's menu
 */
function openMessageMenu(event) {
    const pointed = event instanceof MouseEvent && event.target instanceof Element ? event.target.closest('#chat .mes') : null;
    const message = event instanceof MouseEvent ? pointed : focusedMessage();
    if (!(message instanceof HTMLElement)) return false;
    // A selection in the message keeps the browser's menu, for copying it
    if (event instanceof MouseEvent && String(window.getSelection() ?? '') !== '' && message.contains(window.getSelection()?.anchorNode ?? null)) return false;
    const anchor = event instanceof MouseEvent
        ? { getBoundingClientRect: () => new DOMRect(event.clientX, event.clientY, 0, 0) }
        : message;
    newUi().commands.openMenu(anchor, messageCommands(() => message));
    return true;
}

/** @returns {HTMLTextAreaElement | null} a plain text box that takes formatting keys (`mdHotkeys`) with focus */
function focusedTextarea() {
    const at = document.activeElement;
    return at instanceof HTMLTextAreaElement && at.classList.contains('mdHotkeys') ? at : null;
}

/**
 * The formatting commands, run on the editor (or plain text box) that has focus
 * @returns {Command[]}
 */
function formatCommands() {
    const category = t`Formatting`;
    return FORMAT_KEYS.map(key => {
        const allowed = () => !key.hotkeys || power_user.enable_md_hotkeys === true;
        return {
            id: formatCommandId(key.id),
            label: key.label(t),
            category,
            keys: [key.keys],
            typing: true,
            when: () => allowed() && ((loadedChatEditor()?.focusedTool(key.id) ?? null) !== null || (key.hotkeys && focusedTextarea() !== null)),
            run: () => {
                const focused = loadedChatEditor()?.focusedTool(key.id);
                if (focused) return focused.tool.run(focused.view);
                const textarea = focusedTextarea();
                return textarea ? formatTextarea(textarea, /** @type {Parameters<typeof formatTextarea>[1]} */ (key.id)) : false;
            },
        };
    });
}

/** Registers the page's commands: the chat's, the message's, a character field's and formatting */
export function registerPageCommands() {
    const commands = newUi().commands;
    const chatCategory = t`Chat`;
    const editing = t`Editing`;
    const panels = t`Panels`;
    commands.register(formatCommands(), { capture: true });
    // Before the chat box's own keys, which take Enter and the arrows; Escape is left to them first
    commands.register([
        {
            id: 'characterField.save',
            label: t`Save the character field`,
            category: editing,
            keys: ['ctrl+Enter'],
            typing: true,
            when: fieldEditOpen,
            run: () => handleFieldEditKey('confirm'),
        },
        {
            id: 'message.acceptEdit',
            label: t`Save the message edit`,
            category: editing,
            keys: ['ctrl+Enter'],
            typing: true,
            when: () => $('.mes_edit_done:visible, .mes_reasoning_edit_done:visible').length > 0,
            run: () => {
                const done = $('.mes_edit_done:visible');
                focusChatBox();
                (done.length ? done : $('.mes_reasoning_edit_done:visible')).first().trigger('click');
            },
        },
        {
            id: 'chat.regenerate',
            label: t`Regenerate the last reply`,
            category: chatCategory,
            keys: ['ctrl+Enter'],
            typing: true,
            when: () => !is_send_press && chatHasKeys() && chatBoxText() === '',
            run: () => void regenerate(),
        },
        {
            id: 'chat.send',
            label: t`Send message`,
            category: chatCategory,
            keys: ['Enter', 'ctrl+Enter'],
            typing: true,
            when: () => chatBoxFocused() && !chatBoxSuggesting() && shouldSendOnEnter(),
            run: () => void requestTextareaSend('enter'),
        },
        {
            id: 'chat.editLast',
            label: t`Edit last message`,
            category: chatCategory,
            keys: ['ArrowUp'],
            typing: true,
            when: chatBoxEmptyFocused,
            run: () => editLastMessage(false),
        },
        {
            id: 'chat.editLastOwn',
            label: t`Edit your last message`,
            category: chatCategory,
            keys: ['ctrl+ArrowUp'],
            typing: true,
            when: chatBoxEmptyFocused,
            run: () => editLastMessage(true),
        },
        {
            id: 'chat.swipeLeft',
            label: t`Swipe left`,
            category: chatCategory,
            keys: ['ArrowLeft'],
            typing: true,
            when: canSwipeByKey,
            run: event => swipeLast('left', event instanceof KeyboardEvent && event.repeat),
        },
        {
            id: 'chat.swipeRight',
            label: t`Swipe right`,
            category: chatCategory,
            keys: ['ArrowRight'],
            typing: true,
            when: canSwipeByKey,
            run: event => swipeLast('right', event instanceof KeyboardEvent && event.repeat),
        },
        {
            id: 'chat.continue',
            label: t`Continue the last reply`,
            category: chatCategory,
            keys: ['alt+Enter'],
            typing: true,
            when: () => !is_send_press && chatHasKeys(),
            run: () => void $('#option_continue').trigger('click'),
        },
        {
            id: 'chat.toContext',
            label: t`Scroll to the context line`,
            category: chatCategory,
            keys: ['ctrl+shift+ArrowUp'],
            typing: true,
            run: () => {
                const line = $('.lastInContext');
                if (line.length === 0) {
                    toastr.warning(t`Context line not found, send a message first!`);
                    return;
                }
                const chatBox = $('#chat');
                scrollChat(line.offset().top - chatBox.offset().top + chatBox.scrollTop());
            },
        },
        {
            id: 'chat.toBottom',
            label: t`Scroll to the bottom`,
            category: chatCategory,
            keys: ['ctrl+shift+ArrowDown'],
            typing: true,
            run: () => scrollChat($('#chat').prop('scrollHeight')),
        },
    ], { capture: true });
    commands.register([
        {
            id: 'characterField.leave',
            label: t`Stop editing the character field`,
            category: editing,
            keys: ['Escape'],
            typing: true,
            when: fieldEditOpen,
            run: () => handleFieldEditKey('escape'),
        },
        {
            id: 'message.leaveEdit',
            label: t`Stop editing the message`,
            category: editing,
            keys: ['Escape'],
            typing: true,
            when: messageEditOpen,
            run: () => leaveMessageEdit(),
        },
        {
            id: 'chat.stop',
            label: t`Stop generating`,
            category: chatCategory,
            keys: ['Escape'],
            typing: true,
            when: canStopGenerating,
            run: () => stopGenerating(),
        },
        {
            id: 'panel.close',
            label: t`Close the top panel`,
            category: panels,
            keys: ['Escape'],
            typing: true,
            when: () => !messageEditOpen() && !canStopGenerating() && topPanelCloser() !== undefined,
            run: () => topPanelCloser()?.(),
        },
        {
            id: 'message.menu',
            label: t`Message actions`,
            category: t`Message`,
            keys: ['shift+F10'],
            mouse: ['RightClick'],
            run: openMessageMenu,
        },
        ...messageCommands(focusedMessage),
    ]);
}
