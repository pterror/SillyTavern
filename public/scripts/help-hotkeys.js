/**
 * Every hotkey the app handles, registered so the Hotkeys help topic and the hold-Ctrl list show them all. These only
 * describe the keys; the handlers live where the keys are handled (RossAscends-mods.js, input-md-formatting.js,
 * AutoComplete.js, popup.js, character-field-editor.js, the Quick Reply editor, and so on).
 */
import { getHotkeys, registerHotkey } from './help-registry.js';
import { t, translate } from './i18n.js';
import { power_user } from './power-user.js';

const sendTextarea = () => /** @type {HTMLTextAreaElement | null} */ (document.getElementById('send_textarea'));
const chatBoxEmpty = () => !sendTextarea()?.value;
const markdownHotkeysOn = () => Boolean(power_user.enable_md_hotkeys);

const chat = translate('Chat Hotkeys', 'help_hotkeys_0');
const markdown = translate('Markdown Hotkeys', 'help_hotkeys_20');
const autocomplete = t`Suggestions while typing`;
const editing = t`Editing fields`;
const quickReplies = t`Quick Reply editor`;
const popups = t`Popups`;
const other = t`Other`;

registerHotkey({ category: chat, keys: ['Up'], label: translate('Edit last message in chat', 'help_hotkeys_2'), when: chatBoxEmpty });
registerHotkey({ category: chat, keys: ['Ctrl+Up'], label: translate('Edit last USER message in chat', 'help_hotkeys_4'), when: chatBoxEmpty });
registerHotkey({ category: chat, keys: ['Left'], label: translate('swipe left', 'help_hotkeys_6'), when: chatBoxEmpty });
registerHotkey({ category: chat, keys: ['Right'], label: t`swipe right (only while the chat box is empty)`, when: chatBoxEmpty });
registerHotkey({ category: chat, keys: ['Enter'], label: translate('send your message to AI', 'help_hotkeys_10_1') });
registerHotkey({ category: chat, keys: ['Ctrl+Enter'], label: translate('Regenerate the last AI response', 'help_hotkeys_12') });
registerHotkey({ category: chat, keys: ['Alt+Enter'], label: translate('Continue the last AI response', 'help_hotkeys_14') });
registerHotkey({ category: chat, keys: ['Escape'], label: translate('stop AI response generation, close UI panels, cancel message edit', 'help_hotkeys_16') });
registerHotkey({ category: chat, keys: ['Ctrl+Shift+Up'], label: translate('Scroll to context line', 'help_hotkeys_18') });
registerHotkey({ category: chat, keys: ['Ctrl+Shift+Down'], label: t`Scroll chat to bottom` });
registerHotkey({ category: chat, keys: ['Space'], label: t`On a message's swipe counter: pick a swipe from a list` });

registerHotkey({ category: markdown, keys: ['Ctrl+B'], label: translate('**bold**', 'help_hotkeys_22'), when: markdownHotkeysOn });
registerHotkey({ category: markdown, keys: ['Ctrl+I'], label: translate('*italic*', 'help_hotkeys_23'), when: markdownHotkeysOn });
registerHotkey({ category: markdown, keys: ['Ctrl+U'], label: translate('__underline__', 'help_hotkeys_24'), when: markdownHotkeysOn });
registerHotkey({ category: markdown, keys: ['Ctrl+K'], label: translate('`inline code`', 'help_hotkeys_25'), when: markdownHotkeysOn });
registerHotkey({ category: markdown, keys: ['Ctrl+Shift+~'], label: translate('~~strikethrough~~', 'help_hotkeys_26'), when: markdownHotkeysOn });

registerHotkey({ category: autocomplete, keys: ['Ctrl+Space'], label: t`Show suggestions, or show and hide a suggestion's details` });
registerHotkey({ category: autocomplete, keys: ['Up', 'Down'], label: t`Move through the suggestions` });
registerHotkey({ category: autocomplete, keys: ['Tab', 'Enter'], label: t`Use the selected suggestion` });
registerHotkey({ category: autocomplete, keys: ['Escape'], label: t`Close the suggestions` });

registerHotkey({ category: editing, keys: ['Ctrl+Enter'], label: t`In a character field being edited: save it` });
registerHotkey({ category: editing, keys: ['Escape'], label: t`In a character field being edited: stop editing (asks first if your change would be lost; with autosave on, it saves)` });
registerHotkey({ category: editing, keys: ['Tab', 'Shift+Tab'], label: t`In an expanded editor: indent or unindent` });
registerHotkey({ category: editing, keys: ['Ctrl+F'], label: t`In the slash command or macro list: jump to its search box` });
registerHotkey({ category: editing, keys: ['Ctrl+F'], label: t`In a field's editor: find and replace` });

registerHotkey({ category: quickReplies, keys: ['Ctrl+Enter'], label: t`Run the Quick Reply (when that option is ticked in the editor)` });
registerHotkey({ category: quickReplies, keys: ['F9'], mouse: ['Ctrl+Alt+click'], label: t`Add or remove a breakpoint` });
registerHotkey({ category: quickReplies, keys: ['Ctrl+\\'], label: t`Comment out the selected commands, or uncomment them` });
registerHotkey({ category: quickReplies, mouse: ['Ctrl+click on a Quick Reply button'], label: t`Open that Quick Reply in the editor instead of running it` });

registerHotkey({ category: popups, keys: ['Enter'], label: t`Confirm` });
registerHotkey({ category: popups, keys: ['Escape'], label: t`Close` });
registerHotkey({ category: popups, keys: ['Shift+Enter', 'Alt+Enter'], label: t`In a text box with several lines: new line` });

registerHotkey({ category: other, keys: ['Enter'], label: t`Press the button or control that has focus` });
registerHotkey({ category: other, mouse: ['Shift+click or Alt+click on the persona or chat lorebook button'], label: t`Pick a different lorebook instead of opening the current one` });
registerHotkey({ category: other, keys: ['Hold Ctrl'], label: t`Show this list of hotkeys` });

/**
 * Draws the hotkeys, grouped by category in the order they were registered. Ones that don't work right now (their
 * `when` is false) are shown greyed out.
 * @param {HTMLElement} container
 * @param {string} [query] Only hotkeys whose label, keys or category contain this, ignoring case.
 * @returns {number} How many hotkeys were drawn.
 */
export function renderHotkeys(container, query = '') {
    const needle = query.trim().toLowerCase();
    /** @type {Map<string, import('./help-registry.js').Hotkey[]>} */
    const groups = new Map();
    for (const hotkey of getHotkeys()) {
        const text = [hotkey.label, hotkey.category, ...hotkey.keys, ...hotkey.mouse].join(' ').toLowerCase();
        if (needle && !text.includes(needle)) continue;
        if (!groups.has(hotkey.category)) groups.set(hotkey.category, []);
        groups.get(hotkey.category).push(hotkey);
    }
    let count = 0;
    const root = document.createElement('div');
    root.classList.add('hotkeyList');
    for (const [category, hotkeys] of groups) {
        const group = document.createElement('div');
        group.classList.add('hotkeyGroup');
        const heading = document.createElement('div');
        heading.classList.add('hotkeyGroupTitle');
        heading.textContent = category;
        const list = document.createElement('ul');
        for (const hotkey of hotkeys) {
            const item = document.createElement('li');
            item.classList.add('hotkeyItem');
            let active = true;
            try {
                active = hotkey.when ? Boolean(hotkey.when()) : true;
            } catch {
                active = false;
            }
            item.classList.toggle('hotkeyInactive', !active);
            const keys = document.createElement('span');
            keys.classList.add('hotkeyKeys');
            for (const combo of [...hotkey.keys, ...hotkey.mouse]) {
                const kbd = document.createElement('kbd');
                kbd.textContent = combo;
                keys.appendChild(kbd);
            }
            const label = document.createElement('span');
            label.classList.add('hotkeyLabel');
            label.textContent = hotkey.label;
            item.append(keys, label);
            list.appendChild(item);
            count++;
        }
        group.append(heading, list);
        root.appendChild(group);
    }
    container.appendChild(root);
    return count;
}
