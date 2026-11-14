import {
    For,
    Match,
    Show,
    Switch,
    createEffect,
    createMemo,
    createResource,
    createSignal,
    on,
    onCleanup,
    onMount,
    untrack,
} from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { useUi } from '@st/page/context';
import { HOTKEYS_VIEW, PANEL_VIEW, TOPICS } from '../protocol.ts';
import type { HotkeysView, PanelView, Topic } from '../protocol.ts';
import { Formatting, Overview, TITLES, hotkeysMatching, said } from './content.tsx';
import type { T } from './content.tsx';

/** The lists the old page holds: its slash commands and its macros. */
export type Browser = 'slash' | 'macros';

export type OldPage = {
    /** Puts `content` on the page as a layer over the drawers; `requestClose` is called on its close button and Escape. */
    layer(
        content: HTMLElement,
        options: { className: string; closeTitle: string; requestClose: () => void },
    ): { raise(): void; close(): void };
    /** Draws the list into `into`; `search` filters it and says how many are left. */
    browser(kind: Browser, into: HTMLElement): Promise<{ search(query: string): number }>;
};

type Open = Extract<PanelView, { open: true }>;

const BROWSERS: Partial<Record<Topic, Browser>> = { slash: 'slash', macros: 'macros' };

type Handlers = { old: OldPage; onRaise: (raise: (() => void) | null) => void; onClose: () => void };

/** `shown`: from the answer that opened help until the user closes it, whatever the server answers to the close. */
export function Help(props: Handlers & { shown: boolean }) {
    return (
        <Show when={props.shown}>
            <Reader old={props.old} onRaise={props.onRaise} onClose={props.onClose} />
        </Show>
    );
}

function Reader(props: Handlers) {
    const { client } = useUi();
    const panel = client.view<PanelView>(PANEL_VIEW);
    const hotkeys = client.view<HotkeysView>(HOTKEYS_VIEW);
    const open = () => {
        const view = panel();
        return view?.open === true ? view : null;
    };
    return (
        <Show when={open() !== null && hotkeys() !== undefined}>
            <Panel
                view={() => open() as Open}
                markdown={() => hotkeys()?.markdown === true}
                old={props.old}
                onRaise={props.onRaise}
                onClose={props.onClose}
            />
        </Show>
    );
}

export function Hotkeys() {
    const { client } = useUi();
    const view = client.view<HotkeysView>(HOTKEYS_VIEW);
    return <Show when={view()}>{(shown) => <HotkeyList query="" markdown={shown().markdown} />}</Show>;
}

function HotkeyList(props: { query: string; markdown: boolean }) {
    const { t } = useUi();
    return (
        <div class="hotkeyList">
            <For each={hotkeysMatching(t, props.query)}>
                {(group) => (
                    <div class="hotkeyGroup">
                        <div class="hotkeyGroupTitle">{group.category}</div>
                        <ul>
                            <For each={group.hotkeys}>
                                {(hotkey) => (
                                    <li
                                        class="hotkeyItem"
                                        classList={{ hotkeyInactive: hotkey.markdown && !props.markdown }}
                                    >
                                        <span class="hotkeyKeys">
                                            <For each={hotkey.combos}>{(combo) => <kbd>{combo}</kbd>}</For>
                                        </span>
                                        <span class="hotkeyLabel">{hotkey.label}</span>
                                    </li>
                                )}
                            </For>
                        </ul>
                    </div>
                )}
            </For>
        </div>
    );
}

const LINES = 'li, tr, p, blockquote, pre, h1, h2, h3';

/** Takes out of `container` every line that doesn't hold `query` (ignoring case), and the lists left empty; counts the lines kept. */
function keepMatchingLines(container: HTMLElement, query: string): number {
    const needle = query.toLowerCase();
    let count = 0;
    for (const line of container.querySelectorAll(LINES)) {
        if (line.parentElement?.closest('li, tr, p, blockquote, pre')) continue;
        if (line.textContent.toLowerCase().includes(needle)) count++;
        else line.remove();
    }
    for (const list of container.querySelectorAll('ul, ol, table')) {
        if (!list.querySelector('li, tr')) list.remove();
    }
    return count;
}

type Found = { topic: Topic; element: JSX.Element; count: Accessor<number | null> };

/** A topic in the side menu; `count` while searching: how many of its lines match. */
type Listed = { topic: Topic; count?: number };

const EVERY_TOPIC: Listed[] = TOPICS.map((topic) => ({ topic }));

function Panel(props: Handlers & { view: Accessor<Open>; markdown: Accessor<boolean> }) {
    const { client, t } = useUi();
    const [navOpen, setNavOpen] = createSignal(false);
    // The page's own: a search filters what the panel holds, asking the server nothing.
    const [typed, setTyped] = createSignal('');

    const topic = () => props.view().topic;
    createEffect(on(topic, () => setTyped(''), { defer: true }));
    const query = () => typed().trim();
    const searching = createMemo(() => query() !== '');
    const show = (next: Topic) => {
        setTyped('');
        void client.send('help.show', { topic: next });
    };

    let content: HTMLDivElement | undefined;
    createEffect(
        on([topic, query], () => {
            if (content) content.scrollTop = 0;
        }),
    );

    const found = createMemo(() => (searching() ? search(t, query, props.markdown, props.old, show) : null));
    const settled = () => found()?.every((f) => f.count() !== null) === true;
    const matched = () => (found() ?? []).filter((f) => (f.count() ?? 0) > 0);
    const listed = createMemo<Listed[]>((before) => {
        if (!searching()) return EVERY_TOPIC;
        if (!settled()) return before;
        return matched().map((f) => ({ topic: f.topic, count: f.count() ?? 0 }));
    }, EVERY_TOPIC);

    const pick = (next: Topic) => {
        setNavOpen(false);
        if (searching()) {
            content?.querySelector(`.helpSection[data-topic="${next}"]`)?.scrollIntoView({ block: 'start' });
            return;
        }
        show(next);
    };
    const onKey = (event: KeyboardEvent, act: () => void) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        act();
    };

    const TopicItem = (item: { topic: Topic; count?: number }) => (
        <li
            class="helpTopic"
            classList={{ active: item.count === undefined && item.topic === topic() }}
            data-topic={item.topic}
            tabIndex={0}
            role="button"
            onClick={() => pick(item.topic)}
            onKeyDown={(event) => onKey(event, () => pick(item.topic))}
        >
            {said(t, TITLES[item.topic])}
            <Show when={item.count !== undefined}>
                <span class="helpTopicCount">{String(item.count)}</span>
            </Show>
        </li>
    );

    const panel = (
        <div class="helpPanel" classList={{ helpNavOpen: navOpen() }}>
            <div class="helpHeader">
                <div
                    class="helpMenuButton menu_button fa-solid fa-bars"
                    role="button"
                    tabIndex={0}
                    title={t('Help topics')}
                    onClick={() => setNavOpen((now) => !now)}
                    onKeyDown={(event) => onKey(event, () => setNavOpen((now) => !now))}
                />
                <span class="helpHeaderTitle">{searching() ? t('Search results') : said(t, TITLES[topic()])}</span>
            </div>
            <div class="helpMain">
                <nav class="helpNav">
                    <input
                        type="search"
                        class="helpSearch text_pole"
                        placeholder={t('Search all help')}
                        aria-label={t('Search all help')}
                        value={typed()}
                        onInput={(event) => setTyped(event.currentTarget.value)}
                    />
                    <ul class="helpTopics">
                        <For each={listed()}>{(item) => <TopicItem {...item} />}</For>
                    </ul>
                </nav>
                <div class="helpContent" ref={(el: HTMLDivElement) => (content = el)}>
                    <Show
                        when={found()}
                        fallback={
                            <Show when={topic()} keyed>
                                {(shown) => (
                                    <TopicSection
                                        topic={shown}
                                        markdown={props.markdown()}
                                        old={props.old}
                                        onTopic={show}
                                    />
                                )}
                            </Show>
                        }
                    >
                        {(results) => (
                            <div>
                                {results().map((f) => f.element)}
                                <Show when={settled() && matched().length === 0}>
                                    <div class="helpNoResults">{t('Nothing in help matches this search.')}</div>
                                </Show>
                            </div>
                        )}
                    </Show>
                </div>
            </div>
        </div>
    ) as HTMLElement;

    const layer = props.old.layer(panel, {
        className: 'helpLayer',
        closeTitle: t('Close help'),
        requestClose: () => props.onClose(),
    });
    props.onRaise(() => layer.raise());
    onCleanup(() => {
        props.onRaise(null);
        layer.close();
    });
    return null;
}

function TopicSection(props: { topic: Topic; markdown: boolean; old: OldPage; onTopic: (topic: Topic) => void }) {
    const { t } = useUi();
    const [failed, setFailed] = createSignal(false);
    let section: HTMLDivElement | undefined;
    onMount(() => {
        const kind = BROWSERS[props.topic];
        if (kind === undefined || !section) return;
        props.old.browser(kind, section).catch((error: unknown) => {
            console.error(`Help topic "${props.topic}" failed to draw:`, error);
            setFailed(true);
        });
    });
    return (
        <div class="helpSection" data-topic={props.topic} ref={(el: HTMLDivElement) => (section = el)}>
            <Switch>
                <Match when={failed()}>{t('This help topic could not be shown.')}</Match>
                <Match when={props.topic === 'overview'}>
                    <Overview t={t} onTopic={(next) => props.onTopic(next)} />
                </Match>
                <Match when={props.topic === 'format'}>
                    <Formatting t={t} />
                </Match>
                <Match when={props.topic === 'hotkeys'}>
                    <HotkeyList query="" markdown={props.markdown} />
                </Match>
            </Switch>
        </div>
    );
}

/** Every topic's part matching the query, each with how many of its lines match: null until known. */
function search(
    t: T,
    query: Accessor<string>,
    markdown: Accessor<boolean>,
    old: OldPage,
    onTopic: (topic: Topic) => void,
): Found[] {
    const section = (topic: Topic, count: Accessor<number | null>, body: () => JSX.Element) => (
        <div class="helpSection" data-topic={topic} hidden={(count() ?? 0) === 0}>
            <h3 class="helpSectionTitle">{said(t, TITLES[topic])}</h3>
            {body()}
        </div>
    );
    const document = (topic: Topic, lines: () => JSX.Element): Found => {
        const drawn = createMemo(() => {
            const needle = query();
            const body = (<div>{untrack(lines)}</div>) as HTMLElement;
            return { body, count: keepMatchingLines(body, needle) };
        });
        const count = () => drawn().count;
        return { topic, count, element: section(topic, count, () => drawn().body) };
    };
    const browser = (topic: Topic, kind: Browser): Found => {
        const body = (<div />) as HTMLElement;
        const [list] = createResource(() =>
            old.browser(kind, body).catch((error: unknown) => {
                console.error(`Help topic "${topic}" failed to search:`, error);
                return null;
            }),
        );
        const count = createMemo(() => {
            const shown = list();
            if (shown === undefined) return null;
            return shown === null ? 0 : shown.search(query());
        });
        return { topic, count, element: section(topic, count, () => body) };
    };
    return TOPICS.map((topic): Found => {
        switch (topic) {
            case 'overview':
                return document(topic, () => <Overview t={t} onTopic={onTopic} />);
            case 'format':
                return document(topic, () => <Formatting t={t} />);
            case 'hotkeys': {
                const count = () => hotkeysMatching(t, query()).reduce((sum, group) => sum + group.hotkeys.length, 0);
                return {
                    topic,
                    count,
                    element: section(topic, count, () => (
                        <div>
                            <HotkeyList query={query()} markdown={markdown()} />
                        </div>
                    )),
                };
            }
            case 'slash':
            case 'macros':
                return browser(topic, topic);
        }
    });
}
