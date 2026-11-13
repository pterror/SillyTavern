import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from 'solid-js';
import { useUi } from '@st/page/context';
import { ask } from '@st/page/dialog';
import { Name } from '@st/page/name';
import { LOOP_CHECK_VISITS_PER_WRITE, MAX_CARDS_PER_READ, MENTION_PAGES_AT_MOST, WORLDS_VIEW } from '../protocol.ts';
import type {
    MentionsPage,
    OpenEntryView,
    Placement,
    PointingAtSection,
    PointingAtView,
    RelationKind,
    WorldsView,
} from '../protocol.ts';
import { Cell, Label, Picture } from './Cards.tsx';
import type { CardActions } from './Cards.tsx';
import { useWb } from './context.ts';
import { dismissOn } from './dismiss.ts';
import { Editable } from './Editable.tsx';
import { hoverCards } from './HoverCard.tsx';
import { Icon } from './icons.tsx';
import { Keys } from './Keys.tsx';
import { PlacementPopover } from './Placement.tsx';
import { RelationsLine } from './Relations.tsx';
import { chooseFile } from './Switcher.tsx';
import { EntryText } from './Text.tsx';
import { openedView } from './views.ts';
import { fill } from './words.ts';

export function EntryPage(props: {
    entry: OpenEntryView;
    pointingAt: Extract<PointingAtView, { book: string }> | null;
    kinds: RelationKind[];
    worldName: string;
    groupBy: string | null;
    actions: CardActions;
    onWorld: () => void;
}) {
    const { t } = useUi();
    const wb = useWb();
    const hover = hoverCards();
    const [placing, setPlacing] = createSignal(false);
    const [menu, setMenu] = createSignal(false);
    let placeButton: HTMLButtonElement | undefined;
    let menuButton: HTMLButtonElement | undefined;
    const at = () => ({ book: props.entry.book, entry: props.entry.entry });
    const newEntryKind = () => {
        const kinds = props.kinds.filter((kind) => kind.mergingInto === null);
        return kinds.find((kind) => kind.id === props.groupBy) ?? kinds[0] ?? null;
    };
    return (
        <article class="wb-entry">
            <RelationsLine
                entry={props.entry}
                worldName={props.worldName}
                kinds={props.kinds}
                onWorld={props.onWorld}
            />
            <header class="wb-entry-head">
                <Show when={props.entry.picture}>{(url) => <Picture url={url()} class="wb-entry-pic" />}</Show>
                <div class="wb-entry-headwords">
                    <div class="wb-entry-title">
                        <Editable
                            class="wb-entry-name"
                            label={t('The entry’s title')}
                            value={props.entry.title ?? ''}
                            onSave={(title) => void wb.act('worldbuilding.setEntryTitle', { ...at(), title })}
                        >
                            <Switch>
                                <Match when={props.entry.label.shownAs === 'name'}>
                                    <Name named={props.entry.label} />
                                </Match>
                                <Match when={props.entry.label.shownAs === 'title'}>
                                    <span>{props.entry.label.text}</span>
                                </Match>
                                <Match when={props.entry.label.shownAs === 'opening'}>
                                    <span class="wb-ghost">{t('Add a title')}</span>
                                </Match>
                            </Switch>
                        </Editable>
                        <Show when={props.entry.keys.some((key) => key.isName)}>
                            <button
                                type="button"
                                class="wb-icon-button"
                                aria-label={t('How this entry’s names look')}
                                title={t('How this entry’s names look')}
                                onClick={() => void wb.act('looks.open', { thing: props.entry.entry })}
                            >
                                <Icon name="pencil" />
                            </button>
                        </Show>
                        <button
                            ref={(element) => (placeButton = element)}
                            type="button"
                            class="wb-icon-button"
                            aria-label={t('In the prompt')}
                            title={t('In the prompt')}
                            aria-expanded={placing()}
                            onClick={() => {
                                setMenu(false);
                                setPlacing(!placing());
                            }}
                        >
                            <Icon name="prompt" />
                            <Show when={props.entry.placementDiffersFromDefaults}>
                                <span class="wb-dot" aria-hidden="true" />
                            </Show>
                        </button>
                        <span class="wb-fill" />
                        <button
                            ref={(element) => (menuButton = element)}
                            type="button"
                            class="wb-icon-button"
                            aria-label={t('More')}
                            aria-expanded={menu()}
                            onClick={() => {
                                setPlacing(false);
                                setMenu(!menu());
                            }}
                        >
                            <Icon name="more" />
                        </button>
                        <Show when={placing()}>
                            <PlacementPopover
                                placement={props.entry.placement}
                                tokens={props.entry.tokens}
                                opener={() => placeButton}
                                onClose={() => setPlacing(false)}
                                onSet={(fields: Partial<Placement>) =>
                                    void wb.act('worldbuilding.setPlacement', { ...at(), fields })
                                }
                            />
                        </Show>
                        <Show when={menu()}>
                            <EntryMenu entry={props.entry} opener={() => menuButton} onClose={() => setMenu(false)} />
                        </Show>
                    </div>
                    <Keys entry={props.entry} />
                </div>
            </header>
            <EntryText
                text={props.entry.text}
                links={props.entry.links}
                onSave={(text) => wb.act('worldbuilding.setEntryText', { ...at(), text })}
                onEnter={(entry, element) => hover.enter(props.entry.book, entry, element)}
                onLeave={hover.leave}
                onOpen={(entry) => wb.open(entry)}
            />
            <For each={props.pointingAt?.entry === props.entry.entry ? props.pointingAt.sections : []}>
                {(section) => <PointingAt section={section} entry={props.entry} actions={props.actions} />}
            </For>
            <button
                type="button"
                class="wb-new-under"
                onClick={() => {
                    const kind = newEntryKind();
                    void wb.act('worldbuilding.createEntry', {
                        book: props.entry.book,
                        after: null,
                        name: null,
                        relation: kind === null ? null : { kind: kind.id, target: props.entry.entry },
                        open: { pointingAt: wb.pointingAt() },
                        loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
                    });
                }}
            >
                {t('+ New entry')}
                <Show when={newEntryKind()}>
                    {(kind) => (
                        <span class="wb-new-under-rel">
                            {kind().name} → {props.entry.label.text}
                        </span>
                    )}
                </Show>
            </button>
            <Mentions entry={props.entry} onEnter={hover.enter} onLeave={hover.leave} />
            <hover.Drawn />
        </article>
    );
}

function PointingAt(props: { section: PointingAtSection; entry: OpenEntryView; actions: CardActions }) {
    const wb = useWb();
    let end: HTMLDivElement | undefined;
    const shownEnd = () => props.section.firstRank + props.section.entries.length;
    onMount(() => {
        const watch = new IntersectionObserver((seen) => {
            if (!seen.some((one) => one.isIntersecting) || shownEnd() >= props.section.count) return;
            const endRank = Math.min(props.section.count, Math.max(shownEnd() * 2, shownEnd() + 8));
            const firstRank = Math.max(0, Math.min(props.section.firstRank, endRank - MAX_CARDS_PER_READ));
            void wb.act('worldbuilding.showPointingAtRange', { kind: props.section.kind, firstRank, endRank });
        });
        if (end) watch.observe(end);
        onCleanup(() => watch.disconnect());
    });
    return (
        <section class="wb-section">
            <h3>
                {props.section.kindName ?? ''} → {props.entry.label.text}
            </h3>
            <div class="wb-grid">
                <For each={props.section.entries}>
                    {(cell) => (
                        <div class="wb-top-cell" classList={{ 'wb-wide': cell.region.length > 0 }}>
                            <Cell cell={cell} regionEntry={null} actions={props.actions} />
                        </div>
                    )}
                </For>
            </div>
            <div ref={(element) => (end = element)} aria-hidden="true" />
        </section>
    );
}

function Mentions(props: {
    entry: OpenEntryView;
    onEnter: (book: string, entry: string, at: HTMLElement) => void;
    onLeave: (event: MouseEvent) => void;
}) {
    const { t } = useUi();
    const wb = useWb();
    let end: HTMLDivElement | undefined;
    const pages = () => props.entry.mentionedIn.pages;
    const rows = () => pages().flatMap((page: MentionsPage) => page.entries);
    onMount(() => {
        const watch = new IntersectionObserver((seen) => {
            const last = pages().at(-1);
            if (!seen.some((one) => one.isIntersecting) || !last || last.next === null) return;
            if (pages().length >= MENTION_PAGES_AT_MOST) return;
            void wb.act('worldbuilding.showMentions', { from: pages()[0]?.cursor ?? null, pages: pages().length + 1 });
        });
        if (end) watch.observe(end);
        onCleanup(() => watch.disconnect());
    });
    return (
        <Show when={rows().length > 0}>
            <section class="wb-section">
                <h3>
                    {t('mentions')} → {props.entry.label.text}
                </h3>
                <For each={rows()}>
                    {(row) => (
                        <div class="wb-mention">
                            <Picture url={row.picture} class="wb-mention-pic" />
                            <div class="wb-mention-words">
                                <div class="wb-mention-from">
                                    <button type="button" onClick={() => wb.open(row.from.thing)}>
                                        <Label named={row.from} />
                                    </button>
                                </div>
                                <div class="wb-mention-sentence">
                                    {row.sentence.before}
                                    <a
                                        class="wb-link"
                                        href="#"
                                        onMouseEnter={(event) =>
                                            props.onEnter(props.entry.book, props.entry.entry, event.currentTarget)
                                        }
                                        onMouseLeave={(event) => props.onLeave(event)}
                                        onClick={(event) => event.preventDefault()}
                                    >
                                        <Name
                                            named={{
                                                thing: props.entry.entry,
                                                text: row.sentence.mention,
                                                shownAs: 'name',
                                            }}
                                            picture={props.entry.picture}
                                        />
                                    </a>
                                    {row.sentence.after}
                                </div>
                            </div>
                        </div>
                    )}
                </For>
                <div ref={(element) => (end = element)} aria-hidden="true" />
            </section>
        </Show>
    );
}

function EntryMenu(props: { entry: OpenEntryView; opener: () => HTMLElement | undefined; onClose: () => void }) {
    const { t } = useUi();
    const wb = useWb();
    const [moving, setMoving] = createSignal(false);
    let box: HTMLDivElement | undefined;
    dismissOn(() => box, props.onClose, props.opener);
    const at = () => ({ book: props.entry.book, entry: props.entry.entry });
    // The action starts before the menu closes, so what it reads of the menu's props is read while they are there.
    const run = (action: () => Promise<unknown>) => {
        const started = action();
        props.onClose();
        void started;
    };
    return (
        <div class="wb-menu wb-entry-menu" role="menu" ref={(element) => (box = element)}>
            <Show when={!moving()} fallback={<MoveTo entry={props.entry} onDone={props.onClose} />}>
                <button
                    type="button"
                    role="menuitem"
                    onClick={() => run(() => wb.act('looks.open', { thing: props.entry.entry }))}
                >
                    {t('How its names look')}
                </button>
                <hr />
                <button type="button" role="menuitem" onClick={() => setMoving(true)}>
                    {t('Move to another world…')}
                </button>
                <button
                    type="button"
                    role="menuitem"
                    onClick={() =>
                        run(async () => {
                            const entry = at();
                            const file = await chooseFile('image/*');
                            if (file) await wb.act('worldbuilding.setPicture', entry, file);
                        })
                    }
                >
                    {t('Choose a picture…')}
                </button>
                <Show when={props.entry.picture !== null}>
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => run(() => wb.act('worldbuilding.removePicture', at()))}
                    >
                        {t('Remove the picture')}
                    </button>
                </Show>
                <button
                    type="button"
                    role="menuitem"
                    class="wb-danger"
                    onClick={() => run(() => wb.act('worldbuilding.deleteEntry', at()))}
                >
                    {t('Delete')}
                </button>
            </Show>
        </div>
    );
}

function MoveTo(props: { entry: OpenEntryView; onDone: () => void }) {
    const { client, t } = useUi();
    const wb = useWb();
    const worlds = openedView<WorldsView>(client, WORLDS_VIEW);
    const others = () => (worlds()?.worlds ?? []).filter((world) => world.id !== props.entry.book);
    return (
        <>
            <div class="wb-menu-head">{t('Move to')}</div>
            <For each={others()}>
                {(world) => (
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() =>
                            void (async () => {
                                props.onDone();
                                const sure = await ask(
                                    {
                                        kind: 'confirm',
                                        message: fill(t('Move ${0} to ${1}?'), props.entry.label.text, world.name),
                                        detail: t('Its relations stay behind.'),
                                    },
                                    t,
                                );
                                if (sure)
                                    await wb.act('worldbuilding.moveEntryToWorld', {
                                        book: props.entry.book,
                                        entry: props.entry.entry,
                                        toBook: world.id,
                                    });
                            })()
                        }
                    >
                        {world.name}
                    </button>
                )}
            </For>
        </>
    );
}
