import type { JSX } from 'solid-js';
import type { Topic } from '../protocol.ts';

export type T = (text: string, key?: string) => string;

/** The text as written here and its key in the locale files. */
export type Text = readonly [text: string, key?: string];

export const said = (t: T, [text, key]: Text) => (key === undefined ? t(text) : t(text, key));

export const TITLES: Record<Topic, Text> = {
    overview: ['Overview'],
    slash: ['Slash Commands'],
    format: ['Formatting'],
    hotkeys: ['Hotkeys'],
    macros: ['Macros'],
};

export function Overview(props: { t: T; onTopic: (topic: Topic) => void }) {
    const link = (topic: Topic, text: Text) => (
        <a
            href="#"
            onClick={(event) => {
                event.preventDefault();
                props.onTopic(topic);
            }}
        >
            {said(props.t, text)}
        </a>
    );
    const or = () => props.t('or', 'help_or');
    return (
        <>
            <span>
                {props.t('Hello there! Please select the help topic you would like to learn more about:', 'help_1')}
            </span>
            <ul>
                <li>
                    {link('slash', ['Slash Commands', 'help_2'])} ({or()} <tt>/help slash</tt>)
                </li>
                <li>
                    {link('format', ['Formatting', 'help_3'])} ({or()} <tt>/help format</tt>)
                </li>
                <li>
                    {link('hotkeys', ['Hotkeys', 'help_4'])} ({or()} <tt>/help hotkeys</tt>)
                </li>
                <li>
                    {link('macros', ['{{Macros}}', 'help_5'])} ({or()} <tt>/help macros</tt>)
                </li>
            </ul>
            <br />
            <b>
                <span>{props.t('Still got questions left? The', 'help_6')}</span>{' '}
                <a target="_blank" href="https://docs.sillytavern.app/">
                    {props.t('Official SillyTavern Documentation Website', 'help_7')}
                </a>
                <span>{props.t(' has much more information!', 'help_8')}</span>
            </b>
        </>
    );
}

export function Formatting(props: { t: T }) {
    const t = (text: string, key: string) => props.t(text, key);
    const line = (code: Text, says: Text, shown?: JSX.Element) => (
        <li>
            <tt>{said(props.t, code)}</tt> - <span>{said(props.t, says)}</span>
            {shown}
        </li>
    );
    const likeThis = () => t('like this', 'help_format_like_this');
    return (
        <>
            <span>{t('Text formatting commands:', 'help_format_1')}</span>
            <ul>
                {line(
                    ['*text*', 'help_format_2'],
                    ['displays as ', 'help_format_3'],
                    <i>{t('italics', 'help_format_4')}</i>,
                )}
                {line(
                    ['**text**', 'help_format_5'],
                    ['displays as ', 'help_format_6'],
                    <b>{t('bold', 'help_format_7')}</b>,
                )}
                {line(
                    ['***text***', 'help_format_8'],
                    ['displays as ', 'help_format_9'],
                    <b>
                        <i>{t('bold italics', 'help_format_10')}</i>
                    </b>,
                )}
                {line(
                    ['__text__', 'help_format_11'],
                    ['displays as an ', 'help_format_12'],
                    <u>{t('underline', 'help_format_13')}</u>,
                )}
                {line(
                    ['~~text~~', 'help_format_14'],
                    ['displays as a ', 'help_format_15'],
                    <del>{t('strikethough', 'help_format_16')}</del>,
                )}
                {line(
                    ['[text](url)', 'help_format_17'],
                    ['displays as a ', 'help_format_18'],
                    <a href="#" onClick={(event) => event.preventDefault()}>
                        {t('hyperlink', 'help_format_19')}
                    </a>,
                )}
                {line(['![text](url)', 'help_format_20'], ['displays as an image', 'help_format_21'])}
                {line(
                    ['```text```', 'help_format_22'],
                    ['displays as a code block (new lines allowed between the backticks)', 'help_format_23'],
                )}
            </ul>
            <pre>
                <code>{t(' like this', 'help_format_like_this')}</code>
            </pre>
            <ul>
                {line(
                    ['`text`', 'help_format_24'],
                    ['displays as ', 'help_format_25'],
                    <code>{t('inline code', 'help_format_26')}</code>,
                )}
                {line(
                    ['> text', 'help_format_27'],
                    ['displays as a blockquote (note the space after >)', 'help_format_28'],
                )}
                <blockquote>{likeThis()}</blockquote>
                {line(['# text', 'help_format_29'], ['displays as a large header (note the space)', 'help_format_30'])}
                <h1>{likeThis()}</h1>
                {line(
                    ['## text', 'help_format_32'],
                    ['displays as a medium header (note the space)', 'help_format_33'],
                )}
                <h2>{likeThis()}</h2>
                {line(
                    ['### text', 'help_format_35'],
                    ['displays as a small header (note the space)', 'help_format_36'],
                )}
                <h3>{likeThis()}</h3>
            </ul>
        </>
    );
}

type Hotkey = {
    category: Text;
    keys?: readonly string[];
    mouse?: readonly string[];
    label: Text;
    /** works only while the markdown formatting hotkeys are on */
    markdown?: true;
};

const CHAT: Text = ['Chat Hotkeys', 'help_hotkeys_0'];
const MARKDOWN: Text = ['Markdown Hotkeys', 'help_hotkeys_20'];
const SUGGESTIONS: Text = ['Suggestions while typing'];
const EDITING: Text = ['Editing fields'];
const POPUPS: Text = ['Popups'];
const OTHER: Text = ['Other'];

/** Listed in this order, grouped by category in the order each first appears. */
export const HOTKEYS: readonly Hotkey[] = [
    { category: CHAT, keys: ['Up'], label: ['Edit last message in chat', 'help_hotkeys_2'] },
    { category: CHAT, keys: ['Ctrl+Up'], label: ['Edit last USER message in chat', 'help_hotkeys_4'] },
    { category: CHAT, keys: ['Left'], label: ['swipe left', 'help_hotkeys_6'] },
    { category: CHAT, keys: ['Right'], label: ['swipe right'] },
    { category: CHAT, keys: ['Enter'], label: ['send your message to AI', 'help_hotkeys_10_1'] },
    { category: CHAT, keys: ['Ctrl+Enter'], label: ['Regenerate the last AI response', 'help_hotkeys_12'] },
    { category: CHAT, keys: ['Alt+Enter'], label: ['Continue the last AI response', 'help_hotkeys_14'] },
    {
        category: CHAT,
        keys: ['Escape'],
        label: ['stop AI response generation, close UI panels, cancel message edit', 'help_hotkeys_16'],
    },
    { category: CHAT, keys: ['Ctrl+Shift+Up'], label: ['Scroll to context line', 'help_hotkeys_18'] },
    { category: CHAT, keys: ['Ctrl+Shift+Down'], label: ['Scroll chat to bottom'] },
    { category: CHAT, keys: ['Space'], label: ["On a message's swipe counter: pick a swipe from a list"] },

    { category: MARKDOWN, keys: ['Ctrl+B'], label: ['**bold**', 'help_hotkeys_22'], markdown: true },
    { category: MARKDOWN, keys: ['Ctrl+I'], label: ['*italic*', 'help_hotkeys_23'], markdown: true },
    { category: MARKDOWN, keys: ['Ctrl+U'], label: ['__underline__', 'help_hotkeys_24'], markdown: true },
    { category: MARKDOWN, keys: ['Ctrl+K'], label: ['`inline code`', 'help_hotkeys_25'], markdown: true },
    { category: MARKDOWN, keys: ['Ctrl+Shift+~'], label: ['~~strikethrough~~', 'help_hotkeys_26'], markdown: true },

    {
        category: SUGGESTIONS,
        keys: ['Ctrl+Space'],
        label: ["Show suggestions, or show and hide a suggestion's details"],
    },
    { category: SUGGESTIONS, keys: ['Up', 'Down'], label: ['Move through the suggestions'] },
    { category: SUGGESTIONS, keys: ['Tab', 'Enter'], label: ['Use the selected suggestion'] },
    { category: SUGGESTIONS, keys: ['Escape'], label: ['Close the suggestions'] },

    { category: EDITING, keys: ['Ctrl+Enter'], label: ['In a character field being edited: save it'] },
    {
        category: EDITING,
        keys: ['Escape'],
        label: [
            'In a character field being edited: stop editing (asks first if your change would be lost; with autosave on, it saves)',
        ],
    },
    { category: EDITING, keys: ['Tab', 'Shift+Tab'], label: ['In an expanded editor: indent or unindent'] },
    { category: EDITING, keys: ['Ctrl+F'], label: ['In the slash command or macro list: jump to its search box'] },
    { category: EDITING, keys: ['Ctrl+F'], label: ["In a field's editor: find and replace"] },
    {
        category: EDITING,
        keys: ['Ctrl+Alt+V'],
        label: [
            "Right after pasting into a field's editor: switch how the paste went in (keep formatting, keep as HTML, text only)",
        ],
    },
    {
        category: EDITING,
        keys: ['Escape'],
        label: ["Right after pasting into a field's editor: put the paste options away"],
    },

    { category: POPUPS, keys: ['Enter'], label: ['Confirm'] },
    { category: POPUPS, keys: ['Escape'], label: ['Close'] },
    { category: POPUPS, keys: ['Shift+Enter', 'Alt+Enter'], label: ['In a text box with several lines: new line'] },

    { category: OTHER, keys: ['Enter'], label: ['Press the button or control that has focus'] },
    {
        category: OTHER,
        mouse: ['Shift+click or Alt+click on the persona or chat lorebook button'],
        label: ['Pick a different lorebook instead of opening the current one'],
    },
    { category: OTHER, keys: ['Hold Ctrl'], label: ['Show this list of hotkeys'] },
];

export type HotkeyGroup = { category: string; hotkeys: { combos: string[]; label: string; markdown: boolean }[] };

/** The hotkeys whose text, as shown, holds `query` (ignoring case), grouped; every hotkey for an empty query. */
export function hotkeysMatching(t: T, query: string): HotkeyGroup[] {
    const needle = query.trim().toLowerCase();
    const groups = new Map<string, HotkeyGroup>();
    for (const hotkey of HOTKEYS) {
        const category = said(t, hotkey.category);
        const label = said(t, hotkey.label);
        const combos = [...(hotkey.keys ?? []), ...(hotkey.mouse ?? [])];
        if (needle !== '' && ![label, category, ...combos].join(' ').toLowerCase().includes(needle)) continue;
        let group = groups.get(category);
        if (!group) {
            group = { category, hotkeys: [] };
            groups.set(category, group);
        }
        group.hotkeys.push({ combos, label, markdown: hotkey.markdown === true });
    }
    return [...groups.values()];
}
