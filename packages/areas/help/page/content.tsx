import type { JSX } from '@solidjs/web';
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
            <span>{props.t('Choose a topic:', 'help_1')}</span>
            <ul>
                <li>
                    {link('slash', ['Slash Commands', 'help_2'])} ({or()} <code>/help slash</code>)
                </li>
                <li>
                    {link('format', ['Formatting', 'help_3'])} ({or()} <code>/help format</code>)
                </li>
                <li>
                    {link('hotkeys', ['Hotkeys', 'help_4'])} ({or()} <code>/help hotkeys</code>)
                </li>
                <li>
                    {link('macros', ['{{Macros}}', 'help_5'])} ({or()} <code>/help macros</code>)
                </li>
            </ul>
            <br />
            <b>
                <span>{props.t('More in the', 'help_6')}</span>{' '}
                <a target="_blank" href="https://docs.sillytavern.app/">
                    {props.t('SillyTavern documentation', 'help_7')}
                </a>
                <span>.</span>
            </b>
        </>
    );
}

export function Formatting(props: { t: T }) {
    const t = (text: string, key: string) => props.t(text, key);
    const line = (code: Text, says: Text, shown?: JSX.Element) => (
        <li>
            <code>{said(props.t, code)}</code> - <span>{said(props.t, says)}</span>
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
                    <del>{t('strikethrough', 'help_format_16')}</del>,
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
