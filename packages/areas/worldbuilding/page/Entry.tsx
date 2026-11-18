import { For, Match, Show, Switch, createEffect, createSignal, onSettled } from 'solid-js';
import { useUi } from '@st/page/context';
import { ask } from '@st/page/dialog';
import { Name } from '@st/page/name';
import { LOOP_CHECK_VISITS_PER_WRITE, MAX_CARDS_PER_READ, MENTION_PAGES_AT_MOST } from '../protocol.ts';
import type {
    Deleted,
    MentionsPage,
    OpenEntryView,
    Placement,
    PointingAtSection,
    PointingAtView,
    RelationKind,
} from '../protocol.ts';
import { Cell, Label, Picture } from './Cards.tsx';
import { REGION_ATTRIBUTES } from './Drag.tsx';
import type { CardActions } from './Cards.tsx';
import { useWb } from './context.ts';
import { dismissOn } from './dismiss.ts';
import { copies } from './copies.ts';
import { Editable } from './Editable.tsx';
import { hoverCards } from './HoverCard.tsx';
import { Icon } from './icons.tsx';
import { Names, Triggers } from './Keys.tsx';
import { PlacementPopover } from './Placement.tsx';
import { StatusDot, statusOf } from './Status.tsx';
import { RelationsLine } from './Relations.tsx';
import { chooseFile } from './Switcher.tsx';
import { SelectionMenu } from './Selection.tsx';
import type { Selected } from './Selection.tsx';
import { EntryText } from './Text.tsx';
import { EntryContent } from './EntryContent.tsx';
import { WorldChoice } from './WorldChoice.tsx';
import { fill } from './words.ts';
import { PHONE } from './layout.ts';

// A swipe this far to the right, more across than down, goes back to the world.
const SWIPE_BACK = 80;
const isPhone = () => window.matchMedia(PHONE).matches;

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
    const [selected, setSelected] = createSignal<Selected | null>(null);
    let placeButton: HTMLButtonElement | undefined;
    let menuOpener: HTMLButtonElement | undefined;
    const toggleMenu = (button: HTMLButtonElement) => {
        menuOpener = button;
        setPlacing(false);
        setMenu(!menu());
    };
    let swipedFrom: { x: number; y: number } | null = null;
    const at = () => ({ book: props.entry.book, entry: props.entry.entry });
    const edited = () => ({ ...at(), version: props.entry.version });
    carryCopies(() => props.entry);
    const newEntryKind = () => {
        const kinds = props.kinds.filter((kind) => kind.mergingInto === null);
        return kinds.find((kind) => kind.id === props.groupBy) ?? kinds[0] ?? null;
    };
    return (
        <article
            class="wb-entry wb-hover-host"
            onTouchStart={(event) => {
                const touch = event.touches[0];
                const editing = event.target instanceof Element && event.target.closest('.wb-text-editing') !== null;
                swipedFrom = touch && !editing && isPhone() ? { x: touch.clientX, y: touch.clientY } : null;
            }}
            onTouchEnd={(event) => {
                const touch = event.changedTouches[0];
                const from = swipedFrom;
                swipedFrom = null;
                if (!touch || !from) return;
                const across = touch.clientX - from.x;
                if (across > SWIPE_BACK && Math.abs(touch.clientY - from.y) < across / 2) props.onWorld();
            }}
        >
            <div class="wb-phone-bar">
                <button
                    type="button"
                    class="right_menu_button interactable wb-icon-button wb-phone-back"
                    aria-label={t('Back to world')}
                    onClick={() => props.onWorld()}
                >
                    <Icon name="back" />
                </button>
                <span class="wb-phone-rels">
                    {props.entry.relations
                        .filter((relation) => !relation.targetDeleted)
                        .map((relation) => `${relation.kindName ?? ''}: ${relation.target?.text ?? ''}`)
                        .join(' · ')}
                </span>
                <button
                    type="button"
                    class="right_menu_button interactable wb-icon-button"
                    aria-label={t('More')}
                    aria-expanded={menu() ? 'true' : 'false'}
                    onClick={(event) => toggleMenu(event.currentTarget)}
                >
                    <Icon name="more" />
                </button>
            </div>
            <RelationsLine
                entry={props.entry}
                worldName={props.worldName}
                kinds={props.kinds}
                onWorld={props.onWorld}
            />
            <EntryContent
                entry={props.entry}
                title={
                    <>
                        <Editable
                            class="wb-entry-name"
                            label={t('Title')}
                            value={props.entry.title ?? ''}
                            onSave={(title) =>
                                void wb.edit('worldbuilding.setEntryTitle', { ...edited(), title }, 'title')
                            }
                        >
                            <Switch>
                                <Match when={props.entry.label.shownAs === 'name'}>
                                    <Name named={props.entry.label} />
                                </Match>
                                <Match when={props.entry.label.shownAs === 'title'}>
                                    <span>{props.entry.label.text}</span>
                                </Match>
                                <Match when={props.entry.label.shownAs === 'opening'}>
                                    <span class="wb-ghost">{t('Title')}</span>
                                </Match>
                            </Switch>
                        </Editable>
                        <Show when={props.entry.keys.some((key) => key.isName)}>
                            <button
                                type="button"
                                class="right_menu_button interactable wb-icon-button"
                                aria-label={t('Look')}
                                title={t('Look')}
                                onClick={() => void wb.act('looks.open', { thing: props.entry.entry })}
                            >
                                <Icon name="pencil" />
                            </button>
                        </Show>
                        <button
                            ref={(element) => (placeButton = element)}
                            type="button"
                            class="right_menu_button interactable wb-icon-button"
                            aria-label={t('Entry settings')}
                            title={t('Entry settings')}
                            aria-expanded={placing() ? 'true' : 'false'}
                            onClick={() => {
                                setMenu(false);
                                setPlacing(!placing());
                            }}
                        >
                            <StatusDot status={statusOf(props.entry.placement)} />
                            <Show when={props.entry.placementDiffersFromDefaults}>
                                <span class="wb-dot" aria-hidden="true" />
                            </Show>
                        </button>
                        <span class="wb-fill" />
                        <button
                            type="button"
                            class="right_menu_button interactable wb-icon-button wb-entry-more"
                            aria-label={t('More')}
                            aria-expanded={menu() ? 'true' : 'false'}
                            onClick={(event) => toggleMenu(event.currentTarget)}
                        >
                            <Icon name="more" />
                        </button>
                        <Show when={placing()}>
                            <PlacementPopover
                                placement={props.entry.placement}
                                characterFilter={props.entry.characterFilter}
                                tokens={props.entry.tokens}
                                opener={() => placeButton}
                                onClose={() => setPlacing(false)}
                                onSet={(fields: Partial<Omit<Placement, 'characterFilter'>>) =>
                                    void wb.edit('worldbuilding.setPlacement', { ...edited(), fields })
                                }
                                onFilter={(change) =>
                                    void wb.edit('worldbuilding.changeCharacterFilter', { ...edited(), change })
                                }
                            />
                        </Show>
                        <Show when={menu()}>
                            <EntryMenu entry={props.entry} opener={() => menuOpener} onClose={() => setMenu(false)} />
                        </Show>
                    </>
                }
                keys={
                    <>
                        <Names entry={props.entry} />
                        <Triggers entry={props.entry} />
                    </>
                }
                body={
                    <EntryText
                        text={props.entry.text}
                        version={props.entry.version}
                        copyOf={{ ...at(), field: 'text' }}
                        links={props.entry.links}
                        onSave={(text, version) =>
                            wb.edit('worldbuilding.setEntryText', { ...at(), version, text }, 'text')
                        }
                        onEnter={(entry, element) => hover.enter(props.entry.book, entry, element)}
                        onLeave={hover.leave}
                        onOpen={(entry) => wb.open(entry)}
                        onSelect={setSelected}
                    />
                }
            />
            <Show when={selected()} keyed>
                {(shown) => (
                    <SelectionMenu
                        selected={shown}
                        book={props.entry.book}
                        entry={props.entry.entry}
                        kind={props.groupBy}
                        onClose={() => setSelected(null)}
                    />
                )}
            </Show>
            <For each={props.pointingAt?.entry === props.entry.entry ? props.pointingAt.sections : []}>
                {(section) => (
                    <PointingAt
                        section={section}
                        entry={props.entry}
                        actions={{
                            ...props.actions,
                            hover: {
                                enter: (entry, element) => hover.enter(props.entry.book, entry, element, 'card'),
                                leave: hover.leave,
                                hide: hover.hide,
                            },
                        }}
                    />
                )}
            </For>
            <button
                type="button"
                class="menu_button menu_button_icon margin0 whitespacenowrap wb-new-under"
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

// The browser's copies of the entry's text and title, of any tab, each sent once when the entry is shown: what the
// server hasn't got of them merges in, or asks which side to keep.
function carryCopies(entry: () => OpenEntryView) {
    const wb = useWb();
    createEffect(
        () => `${entry().book}:${entry().entry}`,
        () => {
            const { book, entry: id } = entry();
            void (async () => {
                for (const copy of copies.of(book, id)) {
                    const shown = entry();
                    if (shown.book !== book || shown.entry !== id) return;
                    const now = copy.field === 'text' ? shown.text : (shown.title ?? '');
                    if (copy.text !== now) {
                        const type =
                            copy.field === 'text' ? 'worldbuilding.setEntryText' : 'worldbuilding.setEntryTitle';
                        await wb.edit(
                            type,
                            { book, entry: id, version: copy.version, [copy.field]: copy.text },
                            copy.field,
                        );
                    }
                    copies.drop(copy);
                }
            })();
        },
    );
}

function PointingAt(props: { section: PointingAtSection; entry: OpenEntryView; actions: CardActions }) {
    const wb = useWb();
    const actions: CardActions = {
        ...props.actions,
        grouping: () => ({
            book: props.entry.book,
            kind: props.section.kind,
            kindName: props.section.kindName ?? '',
        }),
    };
    const here = () => ({ entry: props.entry.entry, label: props.entry.label });
    let end: HTMLDivElement | undefined;
    const shownEnd = () => props.section.firstRank + props.section.entries.length;
    onSettled(() => {
        const watch = new IntersectionObserver((seen) => {
            if (!seen.some((one) => one.isIntersecting) || shownEnd() >= props.section.count) return;
            const endRank = Math.min(props.section.count, Math.max(shownEnd() * 2, shownEnd() + 8));
            const firstRank = Math.max(0, Math.min(props.section.firstRank, endRank - MAX_CARDS_PER_READ));
            void wb.act('worldbuilding.showPointingAtRange', { kind: props.section.kind, firstRank, endRank });
        });
        if (end) watch.observe(end);
        return () => watch.disconnect();
    });
    return (
        <section
            class="wb-section"
            {...REGION_ATTRIBUTES(props.entry.entry, props.entry.label.text, props.section.kind)}
        >
            <h3>
                {props.section.kindName ?? ''} → {props.entry.label.text}
            </h3>
            <div class="wb-grid">
                <For each={props.section.entries}>
                    {(cell) => (
                        <div class={['wb-top-cell', { 'wb-wide': cell.region.length > 0 }]} data-entry={cell.entry}>
                            <Cell cell={cell} region={here()} actions={actions} />
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
    onSettled(() => {
        const watch = new IntersectionObserver((seen) => {
            const last = pages().at(-1);
            if (!seen.some((one) => one.isIntersecting) || !last || last.next === null) return;
            if (pages().length >= MENTION_PAGES_AT_MOST) return;
            void wb.act('worldbuilding.showMentions', { from: pages()[0]?.cursor ?? null, pages: pages().length + 1 });
        });
        if (end) watch.observe(end);
        return () => watch.disconnect();
    });
    return (
        <Show when={rows().length > 0}>
            <section class="wb-section">
                <h3>
                    <span class="wb-wide-only">
                        {t('Mentioned in')} → {props.entry.label.text}
                    </span>
                    <span class="wb-phone-only">{t('Mentioned in')}</span>
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
    const [sending, setSending] = createSignal<'move' | 'copy' | null>(null);
    let box: HTMLDivElement | undefined;
    dismissOn(() => box, props.onClose, props.opener, { align: 'end' });
    const at = () => ({ book: props.entry.book, entry: props.entry.entry });
    // The action starts before the menu closes, so what it reads of the menu's props is read while they are there.
    const run = (action: () => Promise<unknown>) => {
        const started = action();
        props.onClose();
        void started;
    };
    return (
        <div class="wb-menu list-group wb-entry-menu" role="menu" ref={(element) => (box = element)}>
            <Show
                when={sending()}
                keyed
                fallback={
                    <>
                        <button
                            class="list-group-item"
                            type="button"
                            role="menuitem"
                            onClick={() => run(() => wb.act('looks.open', { thing: props.entry.entry }))}
                        >
                            {t('Look…')}
                        </button>
                        <hr />
                        <button
                            class="list-group-item"
                            type="button"
                            role="menuitem"
                            onClick={() =>
                                run(() =>
                                    wb.act('worldbuilding.duplicateEntry', {
                                        ...at(),
                                        loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
                                    }),
                                )
                            }
                        >
                            {t('Duplicate')}
                        </button>
                        <button
                            class="list-group-item"
                            type="button"
                            role="menuitem"
                            onClick={() => setSending('copy')}
                        >
                            {t('Copy to world…')}
                        </button>
                        <button
                            class="list-group-item"
                            type="button"
                            role="menuitem"
                            onClick={() => setSending('move')}
                        >
                            {t('Move to world…')}
                        </button>
                        <button
                            class="list-group-item"
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
                            {t('Set picture…')}
                        </button>
                        <Show when={props.entry.picture !== null}>
                            <button
                                class="list-group-item"
                                type="button"
                                role="menuitem"
                                onClick={() => run(() => wb.act('worldbuilding.removePicture', at()))}
                            >
                                {t('Remove picture')}
                            </button>
                        </Show>
                        <button
                            type="button"
                            role="menuitem"
                            class="list-group-item wb-danger"
                            onClick={() =>
                                run(async () => {
                                    const done = await wb.act('worldbuilding.deleteEntry', at());
                                    const answer = done.ok ? (done.answer as Deleted | undefined) : undefined;
                                    if (!answer) return;
                                    const { book, set, one } = answer.deleted;
                                    wb.offerUndo(
                                        fill(t('Deleted ${0}'), one?.text ?? ''),
                                        () => void wb.act('worldbuilding.undoDelete', { book, set }),
                                    );
                                })
                            }
                        >
                            {t('Delete')}
                        </button>
                    </>
                }
            >
                {(how) => <SendTo entry={props.entry} how={how} onDone={props.onClose} />}
            </Show>
        </div>
    );
}

function SendTo(props: { entry: OpenEntryView; how: 'move' | 'copy'; onDone: () => void }) {
    const { t } = useUi();
    const wb = useWb();
    const at = { book: props.entry.book, entry: props.entry.entry };
    return (
        <WorldChoice
            heading={props.how === 'move' ? t('Move to') : t('Copy to')}
            from={props.entry.book}
            onPick={(toBook, name) =>
                void (async () => {
                    props.onDone();
                    if (props.how === 'copy') {
                        await wb.act('worldbuilding.copyEntryToWorld', { ...at, toBook });
                        return;
                    }
                    const sure = await ask(
                        {
                            kind: 'confirm',
                            message: fill(t('Move ${0} to ${1}?'), props.entry.label.text, name),
                            detail: t('Its relations stay in this world.'),
                        },
                        t,
                    );
                    if (sure) await wb.act('worldbuilding.moveEntryToWorld', { ...at, toBook });
                })()
            }
        />
    );
}
