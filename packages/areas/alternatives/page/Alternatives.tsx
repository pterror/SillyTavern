import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import { unwrap } from 'solid-js/store';
import { useUi } from '@st/page/context';
import { ask } from '@st/page/dialog';
import { COUNTS_VIEW, LIST_VIEW, MATCHES_VIEW } from '../protocol.ts';
import type { CountsView, GreetingOp, Item, ListView, MatchesView, Target } from '../protocol.ts';
import { markWords, matchedWords } from './marks.ts';

// The alternatives of a message (docs/design/alternatives.md): one list, every alternative rendered as the chat
// renders it. The server sends the list, the counts and the search's matches; the page draws them, and keeps only
// what is its own: which list is open, the search box's text, the greeting being edited.

/** What only the old page does yet. */
export type OldPage = {
    /** An alternative's text as the chat renders it. */
    format(text: string, item: { name: string; role: Item['role'] }, mesId: number | null): DocumentFragment;
    /** A stored send date as the chat shows dates. */
    date(value: string | number): string;
    /** The on-screen connection's tokenizer state (the count routes'), null when there's none. */
    tokenizer(): Record<string, unknown> | null;
    /** Why the chat can't show another alternative of this message now (null: it can). */
    cantGo(mesId: number): string | null;
    /** The chat shows this alternative of the message. */
    go(mesId: number, index: number): Promise<void>;
    /** Deletes one of a chat message's alternatives (asking first, as the chat's delete does). */
    remove(mesId: number, index: number): Promise<void>;
    copy(text: string): Promise<void>;
    /** The card's greetings changed through this list: the old page's character and greeting pager take them. */
    greetingsChanged(card: NonNullable<ListView['card']>, edit: { hash: number; text: string } | null): void;
};

/** A list opened: what it's of, and the message it's for in the chat on screen (null: a greetings list). */
export type Look = { target: Target; mesId: number | null; title: string; at?: number };

const keyOf = (target: Target) => JSON.stringify(target);

/** A list last seen, shown at once when it's opened again (the server's then corrects it). */
type Seen = { list: ListView; counts: CountsView };

export function Alternatives(props: { look: Look | null; old: OldPage; onClose: () => void }) {
    const { client } = useUi();
    const views = {
        list: client.view<ListView>(LIST_VIEW),
        counts: client.view<CountsView>(COUNTS_VIEW),
        matches: client.view<MatchesView>(MATCHES_VIEW),
    };
    const seen = new Map<string, Seen>();
    return (
        <Show when={props.look} keyed>
            {(look) => <Dialog look={look} old={props.old} onClose={props.onClose} views={views} seen={seen} />}
        </Show>
    );
}

type RowState = {
    li: HTMLLIElement;
    body: HTMLElement;
    item: Item;
    /** The rendered text, and the text it is of. */
    html: DocumentFragment | null;
    htmlOf: string;
    /** What the body shows now: text and matches. */
    painted: string;
    visible: boolean;
};

const idle: (work: (deadline: { timeRemaining(): number }) => void) => void =
    typeof requestIdleCallback === 'function'
        ? (work) => void requestIdleCallback(work, { timeout: 200 })
        : (work) => {
              // No idle callbacks (Safari): a frame's first few milliseconds.
              requestAnimationFrame(() => {
                  const start = performance.now();
                  work({ timeRemaining: () => Math.max(0, 8 - (performance.now() - start)) });
              });
          };

function Dialog(props: {
    look: Look;
    old: OldPage;
    onClose: () => void;
    views: {
        list: Accessor<ListView | undefined>;
        counts: Accessor<CountsView | undefined>;
        matches: Accessor<MatchesView | undefined>;
    };
    seen: Map<string, Seen>;
}) {
    const { client, t } = useUi();
    const key = keyOf(props.look.target);
    const greetingsList = 'greetings' in props.look.target;
    const mesId = props.look.mesId;

    const isOurs = (list: ListView | undefined) => !!list?.target && keyOf(list.target) === key;
    const list = createMemo(() => {
        const live = props.views.list();
        return isOurs(live) ? live! : (props.seen.get(key)?.list ?? null);
    });
    const items = () => list()?.items ?? [];
    const counts = () =>
        (isOurs(props.views.list()) ? props.views.counts()?.counts : props.seen.get(key)?.counts.counts) ?? {};
    const current = () => list()?.current ?? null;
    const matches = () => props.views.matches()?.matches ?? null;
    // What the matches are, read through: the store merges a new answer into the one before, in place.
    const matchesKey = createMemo(() => JSON.stringify(matches()));

    const [query, setQuery] = createSignal('');
    const [notice, setNotice] = createSignal<string | null>(null);
    const [editing, setEditing] = createSignal<string | null>(null);
    const [adding, setAdding] = createSignal(false);
    const [drop, setDrop] = createSignal<{ id: string; side: 'before' | 'after' } | null>(null);
    const [ticks, setTicks] = createSignal<{ top: number; current: boolean }[]>([]);

    // The tab looks at this list until it's closed; the server forgetting it (a restart) is told to it again.
    const [opened, setOpened] = createSignal(false);
    const open = () =>
        void client
            .send('alternatives.open', { target: props.look.target, tokenizer: props.old.tokenizer() })
            .then(() => setOpened(true));
    open();
    createEffect(() => {
        if (opened() && props.views.list() !== undefined && props.views.list()!.target === null) {
            setOpened(false);
            open();
        }
    });
    onCleanup(() => {
        const live = props.views.list();
        if (isOurs(live)) {
            props.seen.set(key, {
                list: structuredClone(unwrap(live!)),
                counts: structuredClone(unwrap(props.views.counts() ?? { counts: {} })),
            });
        }
        void client.send('alternatives.close', {});
    });

    let dialog: HTMLDialogElement | undefined;
    let scroller: HTMLOListElement | undefined;
    onMount(() => dialog?.showModal());

    // Rows are drawn as the chat draws messages: those in view first, the rest when there's time. A row not drawn
    // yet shows its text as it is.
    const rows = new Map<string, RowState>();
    const spansOf = (id: string) => matches()?.[id] ?? null;
    const paint = (row: RowState) => {
        const spans = spansOf(row.item.id);
        const want = `${row.item.text}\u0000${spans?.join(',') ?? ''}`;
        if (row.html === null || row.htmlOf !== row.item.text) {
            row.html = props.old.format(row.item.text, row.item, mesId);
            row.htmlOf = row.item.text;
        }
        if (row.painted === want) return;
        row.body.replaceChildren(row.html.cloneNode(true));
        if (spans !== null) markWords(row.body, matchedWords(row.item.text, spans));
        row.painted = want;
    };
    const isPainted = (row: RowState) =>
        row.painted === `${row.item.text}\u0000${spansOf(row.item.id)?.join(',') ?? ''}`;

    const observer = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const row = rows.get((entry.target as HTMLElement).dataset['id'] ?? '');
                if (!row) continue;
                row.visible = entry.isIntersecting;
                if (row.visible) paint(row);
            }
        },
        { rootMargin: '100% 0px' },
    );
    onCleanup(() => observer.disconnect());

    let idleRunning = false;
    const paintRest = () => {
        if (idleRunning) return;
        idleRunning = true;
        const step = (deadline: { timeRemaining(): number }) => {
            let left = false;
            for (const row of rows.values()) {
                if (isPainted(row) || row.li.hidden === true) continue;
                if (deadline.timeRemaining() < 1) {
                    left = true;
                    break;
                }
                paint(row);
            }
            measure();
            if (left && rows.size > 0) idle(step);
            else idleRunning = false;
        };
        idle(step);
    };
    onCleanup(() => rows.clear());

    const register = (item: Item, li: HTMLLIElement, body: HTMLElement) => {
        const row: RowState = { li, body, item, html: null, htmlOf: '', painted: '', visible: false };
        rows.set(item.id, row);
        body.textContent = item.text;
        observer.observe(li);
        onCleanup(() => {
            observer.unobserve(li);
            if (rows.get(item.id) === row) rows.delete(item.id);
        });
        // A text that changed (an edit) is drawn again.
        createEffect(
            on(
                () => item.text,
                () => {
                    if (row.painted !== '' && row.htmlOf !== item.text) {
                        if (row.visible) paint(row);
                        else paintRest();
                    }
                },
                { defer: true },
            ),
        );
    };

    // The matches drawn: those in view at once, the rest when there's time.
    createEffect(
        on(matchesKey, (now, before) => {
            for (const row of rows.values()) if (row.visible) paint(row);
            paintRest();
            measure();
            // The search cleared: back to the current one, now that every row shows again.
            if (now === 'null' && before !== undefined && before !== 'null') {
                queueMicrotask(() => scrollTo(current() ?? 0, false));
            }
        }),
    );

    const rowOf = (index: number) => {
        const item = items()[index];
        return item ? rows.get(item.id) : undefined;
    };
    const scrollTo = (index: number, focus: boolean) => {
        const row = rowOf(index);
        if (!row) return;
        paint(row);
        row.li.scrollIntoView({ block: 'center' });
        if (focus) row.li.focus({ preventScroll: true });
    };

    // Opens on the current alternative (or the one asked for), once the list is there.
    let placed = false;
    createEffect(() => {
        if (placed || items().length === 0) return;
        placed = true;
        const at = props.look.at ?? current() ?? 0;
        // Drawn before it's shown, with its neighbours: what's first in view isn't raw text.
        for (let i = Math.max(0, at - 3); i <= at + 3; i++) {
            const row = rowOf(i);
            if (row) paint(row);
        }
        scrollTo(at, false);
        paintRest();
    });

    // Markers beside the list: matches and the current one, where they are in it.
    let measuring = false;
    const measure = () => {
        if (measuring) return;
        measuring = true;
        requestAnimationFrame(() => {
            measuring = false;
            const height = scroller?.scrollHeight ?? 0;
            if (height === 0) return;
            const found = matches();
            const marks = new Map<number, boolean>();
            const at = (id: string, isCurrent: boolean) => {
                const row = rows.get(id);
                if (!row || row.li.hidden === true) return;
                // One marker per pixel row of the track at most.
                const top = Math.round((row.li.offsetTop / height) * 1000) / 10;
                marks.set(top, (marks.get(top) ?? false) || isCurrent);
            };
            if (found) for (const id of Object.keys(found)) at(id, false);
            const now = current();
            const currentItem = now === null ? undefined : items()[now];
            if (currentItem) at(currentItem.id, true);
            setTicks([...marks].map(([top, isCurrent]) => ({ top, current: isCurrent })));
        });
    };
    createEffect(on([items, current], measure));

    const search = (text: string) => {
        setQuery(text);
        void client.send('alternatives.search', { query: text }).then((result) => {
            if (!result.ok) setNotice(result.error);
        });
    };

    const hidden = (item: Item) => {
        const found = matches();
        return found !== null && !(item.id in found);
    };
    const shownCount = () => {
        const found = matches();
        return found === null ? items().length : Object.keys(found).length;
    };

    // The one selected in the list: the current one until another is picked (by its number, or a click on it). Go
    // sends the chat to it; selecting only finds it.
    const [picked, setPicked] = createSignal<number | null>(props.look.at ?? null);
    const selected = () => picked() ?? current();
    const select = (text: string) => {
        const n = Number.parseInt(text, 10);
        if (!Number.isInteger(n) || n < 1 || n > items().length) {
            if (text.trim() !== '')
                setNotice(t('Enter a number from 1 to ${0}.').replace('${0}', String(items().length)));
            return;
        }
        setNotice(null);
        setPicked(n - 1);
        if (hidden(items()[n - 1]!)) search('');
        queueMicrotask(() => scrollTo(n - 1, false));
    };
    const selectedWhy = () => {
        const index = selected();
        const item = index === null ? undefined : items()[index];
        return item ? whyNotGo(item, index!) : t('Select one first.');
    };
    const goSelected = () => {
        const index = selected();
        const item = index === null ? undefined : items()[index];
        if (item) void go(item, index!);
    };

    // What can be done with a row, and why not when it can't.
    const whyNotGo = (item: Item, index: number): string | null => {
        if (greetingsList) {
            if (list()?.chatOpen !== true) return t('Open a chat with this character to show a greeting in it.');
            if (item.opening === null) return t("This greeting isn't one the chat can show.");
            return null;
        }
        if (index === current()) return t('The chat shows this one.');
        // Asked each time: the chat may be busy (a reply being written) now and not a moment later.
        return mesId === null ? null : props.old.cantGo(mesId);
    };
    const go = async (item: Item, index: number) => {
        const why = whyNotGo(item, index);
        if (why !== null) {
            setNotice(why);
            return;
        }
        props.onClose();
        if (greetingsList) await props.old.go(0, item.opening!);
        else await props.old.go(mesId!, index);
    };
    const canRemove = (item: Item) => (greetingsList ? true : item.nodeId !== null && items().length > 1);
    const remove = async (item: Item, index: number) => {
        if (!greetingsList) {
            await props.old.remove(mesId!, index);
            return;
        }
        const sure = await ask({ kind: 'confirm', message: t('Delete this greeting?') }, t);
        if (sure) await greeting({ op: 'delete', position: item.card!.position, hash: item.card!.hash }, null);
    };

    const greeting = async (op: GreetingOp, edit: { hash: number; text: string } | null) => {
        const result = await client.send('alternatives.greeting', op);
        const card = list()?.card;
        if (!result.ok) {
            setNotice(result.error);
            return false;
        }
        setNotice(null);
        if (card) props.old.greetingsChanged(structuredClone(unwrap(card)), edit);
        return true;
    };
    const save = async (item: Item | null, text: string) => {
        if (item === null) {
            if (text.trim() === '') {
                setAdding(false);
                return;
            }
            if (await greeting({ op: 'add', text }, null)) {
                setAdding(false);
                queueMicrotask(() => scrollTo(items().length - 1, false));
            }
            return;
        }
        if (text.trim() === '') {
            const sure = await ask({ kind: 'confirm', message: t('This greeting is empty now. Delete it?') }, t);
            if (!sure) return;
        }
        const card = item.card!;
        if (await greeting({ op: 'edit', position: card.position, hash: card.hash, text }, { hash: card.hash, text }))
            setEditing(null);
    };
    const setDefault = (item: Item) => {
        const card = item.card!;
        const isDefault = list()?.card?.defaultPosition === card.position;
        void greeting(
            isDefault
                ? { op: 'undefault', hash: card.hash }
                : { op: 'default', position: card.position, hash: card.hash },
            null,
        );
    };
    const move = (item: Item, target: Item, side: 'before' | 'after') => {
        if (item.id === target.id || !item.card || !target.card) return;
        void greeting(
            {
                op: 'move',
                position: item.card.position,
                hash: item.card.hash,
                side,
                target: target.card.position,
                targetHash: target.card.hash,
            },
            null,
        );
    };

    // Dragging a greeting by its handle: where it would land is shown, and it's moved when let go.
    const dragFrom = (item: Item, event: PointerEvent) => {
        const handle = event.currentTarget as HTMLElement;
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
        const over = (moved: PointerEvent) => {
            const li = document.elementFromPoint(moved.clientX, moved.clientY)?.closest<HTMLElement>('.alternative');
            const id = li?.dataset['id'];
            if (li && id !== undefined) {
                const box = li.getBoundingClientRect();
                setDrop({ id, side: moved.clientY < box.top + box.height / 2 ? 'before' : 'after' });
            }
            const box = scroller?.getBoundingClientRect();
            if (box && scroller) {
                if (moved.clientY < box.top + 40) scroller.scrollBy(0, -20);
                else if (moved.clientY > box.bottom - 40) scroller.scrollBy(0, 20);
            }
        };
        const done = () => {
            handle.removeEventListener('pointermove', over);
            handle.removeEventListener('pointerup', done);
            handle.removeEventListener('pointercancel', cancel);
            const target = drop();
            setDrop(null);
            const to = target && items().find((i) => i.id === target.id);
            if (to) move(item, to, target.side);
        };
        const cancel = () => {
            handle.removeEventListener('pointermove', over);
            handle.removeEventListener('pointerup', done);
            handle.removeEventListener('pointercancel', cancel);
            setDrop(null);
        };
        handle.addEventListener('pointermove', over);
        handle.addEventListener('pointerup', done);
        handle.addEventListener('pointercancel', cancel);
    };
    // The arrow keys move a greeting by one; Home and End to the start and the end.
    const keyMove = (item: Item, index: number, event: KeyboardEvent) => {
        const to: Record<string, [number, 'before' | 'after']> = {
            ArrowUp: [index - 1, 'before'],
            ArrowDown: [index + 1, 'after'],
            Home: [0, 'before'],
            End: [items().length - 1, 'after'],
        };
        const [at, side] = to[event.key] ?? [-1, 'after'];
        const target = items()[at];
        if (!target) return;
        event.preventDefault();
        move(item, target, side);
    };

    const title = () =>
        greetingsList ? t('Greetings') : props.look.title !== '' ? props.look.title : t('Alternatives');

    return (
        <dialog
            ref={(el: HTMLDialogElement) => (dialog = el)}
            class="popup wide_dialogue_popup large_dialogue_popup alternatives"
            aria-label={title()}
            onCancel={(event) => {
                event.preventDefault();
                props.onClose();
            }}
        >
            <div class="popup-body alternatives-body">
                <header class="alternatives-header">
                    <h3 class="alternatives-title">{title()}</h3>
                    <span class="alternatives-place" aria-live="polite">
                        <Show when={list()} fallback={t('Loading…')}>
                            <Show
                                when={current() !== null}
                                fallback={t('${0} in all').replace('${0}', String(items().length))}
                            >
                                {t('#${0} of ${1}')
                                    .replace('${0}', String((current() ?? 0) + 1))
                                    .replace('${1}', String(items().length))}
                            </Show>
                        </Show>
                    </span>
                    <button
                        type="button"
                        class="menu_button alternatives-close fa-solid fa-xmark"
                        title={t('Close')}
                        aria-label={t('Close')}
                        onClick={() => props.onClose()}
                    />
                </header>
                <div class="alternatives-tools">
                    <input
                        type="search"
                        class="text_pole alternatives-search"
                        placeholder={t('Search')}
                        aria-label={t('Search')}
                        value={query()}
                        onInput={(event) => search(event.currentTarget.value)}
                    />
                    <form
                        class="alternatives-select"
                        onSubmit={(event) => {
                            // Enter, as the button: the chat goes to the one selected.
                            event.preventDefault();
                            goSelected();
                        }}
                    >
                        <label class="alternatives-select-label">
                            #
                            <input
                                name="n"
                                type="number"
                                inputmode="numeric"
                                min="1"
                                max={items().length}
                                class="text_pole alternatives-select-n"
                                aria-label={t('Select by number')}
                                value={selected() === null ? '' : selected()! + 1}
                                onInput={(event) => select(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                    if (event.key !== 'Enter') return;
                                    event.preventDefault();
                                    goSelected();
                                }}
                            />
                        </label>
                        <button
                            type="submit"
                            class="menu_button alternatives-go"
                            aria-disabled={selectedWhy() !== null}
                            title={selectedWhy() ?? undefined}
                        >
                            {greetingsList ? t('Show in chat') : t('Go')}
                        </button>
                    </form>
                    <Show when={greetingsList}>
                        <button
                            type="button"
                            class="menu_button alternatives-add"
                            disabled={adding()}
                            onClick={() => {
                                setAdding(true);
                                queueMicrotask(() =>
                                    scroller
                                        ?.querySelector('.alternatives-new textarea')
                                        ?.scrollIntoView({ block: 'center' }),
                                );
                            }}
                        >
                            <i class="fa-solid fa-plus" /> {t('Add greeting')}
                        </button>
                    </Show>
                </div>
                <Show when={notice()}>
                    {(text) => (
                        <p class="alternatives-notice" role="status">
                            {text()}
                        </p>
                    )}
                </Show>
                <Show when={matches() !== null}>
                    <p class="alternatives-found" role="status">
                        {shownCount() === 0
                            ? t('Nothing matches.')
                            : t('${0} match').replace('${0}', String(shownCount()))}
                    </p>
                </Show>
                <div class="alternatives-frame">
                    <ol class="alternatives-list" ref={(el: HTMLOListElement) => (scroller = el)}>
                        <For each={items()}>
                            {(item, index) => (
                                <li
                                    class="alternative"
                                    data-id={item.id}
                                    tabindex="-1"
                                    hidden={hidden(item)}
                                    onClick={(event) => {
                                        if (
                                            !(event.target as HTMLElement).closest('button, textarea, a, [role=button]')
                                        )
                                            setPicked(index());
                                    }}
                                    classList={{
                                        current: index() === current(),
                                        selected: index() === selected(),
                                        'drop-before': drop()?.id === item.id && drop()?.side === 'before',
                                        'drop-after': drop()?.id === item.id && drop()?.side === 'after',
                                    }}
                                    ref={(li: HTMLLIElement) => {
                                        const body = li.querySelector<HTMLElement>('.alternative-text');
                                        if (body) untrack(() => register(item, li, body));
                                    }}
                                >
                                    <div class="alternative-head">
                                        <Show when={greetingsList}>
                                            <span
                                                class="alternative-drag fa-solid fa-grip-vertical"
                                                role="button"
                                                tabindex="0"
                                                title={t('Drag to reorder (or use the arrow keys, Home and End)')}
                                                aria-label={t('Reorder')}
                                                onPointerDown={(event) => dragFrom(item, event)}
                                                onKeyDown={(event) => keyMove(item, index(), event)}
                                            />
                                        </Show>
                                        <span class="alternative-number">#{index() + 1}</span>
                                        <Show when={index() === current()}>
                                            <span class="alternative-badge">
                                                {greetingsList ? t('Default') : t('Current')}
                                            </span>
                                        </Show>
                                        <Show when={!greetingsList && item.card}>
                                            {(card) => (
                                                <span class="alternative-badge">
                                                    {t('Card greeting #${0}').replace(
                                                        '${0}',
                                                        String(card().position + 1),
                                                    )}
                                                </span>
                                            )}
                                        </Show>
                                        <Show when={!greetingsList && item.name}>
                                            <span class="alternative-name">{item.name}</span>
                                        </Show>
                                        <Show when={item.date !== null}>
                                            <span class="alternative-date">{props.old.date(item.date!)}</span>
                                        </Show>
                                        <span class="alternative-size">
                                            {t('${0} chars').replace('${0}', String(item.text.length))}
                                            <Show when={counts()[item.id] !== undefined}>
                                                {`, ${counts()[item.id]}t`}
                                            </Show>
                                        </span>
                                        <span class="alternative-actions">
                                            <button
                                                type="button"
                                                class="menu_button alternative-go"
                                                aria-disabled={whyNotGo(item, index()) !== null}
                                                title={whyNotGo(item, index()) ?? undefined}
                                                onClick={() => void go(item, index())}
                                            >
                                                {greetingsList ? t('Show in chat') : t('Go')}
                                            </button>
                                            <button
                                                type="button"
                                                class="menu_button alternative-copy fa-solid fa-copy"
                                                title={t('Copy')}
                                                aria-label={t('Copy')}
                                                onClick={() => void props.old.copy(item.text)}
                                            />
                                            <Show when={greetingsList}>
                                                <button
                                                    type="button"
                                                    class="menu_button alternative-default fa-star"
                                                    classList={{
                                                        'fa-solid':
                                                            list()?.card?.defaultPosition === item.card?.position,
                                                        'fa-regular':
                                                            list()?.card?.defaultPosition !== item.card?.position,
                                                    }}
                                                    title={t('Default greeting')}
                                                    aria-label={t('Default greeting')}
                                                    aria-pressed={list()?.card?.defaultPosition === item.card?.position}
                                                    onClick={() => setDefault(item)}
                                                />
                                                <button
                                                    type="button"
                                                    class="menu_button alternative-edit fa-solid fa-pencil"
                                                    title={t('Edit')}
                                                    aria-label={t('Edit')}
                                                    onClick={() => setEditing(item.id)}
                                                />
                                            </Show>
                                            <Show when={canRemove(item)}>
                                                <button
                                                    type="button"
                                                    class="menu_button alternative-delete fa-solid fa-trash-can"
                                                    title={t('Delete')}
                                                    aria-label={t('Delete')}
                                                    onClick={() => void remove(item, index())}
                                                />
                                            </Show>
                                        </span>
                                    </div>
                                    <div class="mes_text alternative-text" hidden={editing() === item.id} />
                                    <Show when={editing() === item.id}>
                                        <Editor
                                            text={item.text}
                                            onSave={(text) => void save(item, text)}
                                            onCancel={() => setEditing(null)}
                                        />
                                    </Show>
                                </li>
                            )}
                        </For>
                        <Show when={adding()}>
                            <li class="alternative alternatives-new">
                                <Editor
                                    text=""
                                    onSave={(text) => void save(null, text)}
                                    onCancel={() => setAdding(false)}
                                />
                            </li>
                        </Show>
                    </ol>
                    <div class="alternatives-markers" aria-hidden="true">
                        <For each={ticks()}>
                            {(tick) => (
                                <span
                                    class="alternatives-marker"
                                    classList={{ current: tick.current }}
                                    style={{ top: `${tick.top}%` }}
                                />
                            )}
                        </For>
                    </div>
                </div>
            </div>
        </dialog>
    );
}

function Editor(props: { text: string; onSave: (text: string) => void; onCancel: () => void }) {
    const { t } = useUi();
    const [text, setText] = createSignal(props.text);
    let area: HTMLTextAreaElement | undefined;
    onMount(() => area?.focus());
    return (
        <div class="alternative-editor">
            <textarea
                ref={(el: HTMLTextAreaElement) => (area = el)}
                class="text_pole textarea_compact"
                rows="8"
                value={text()}
                onInput={(event) => setText(event.currentTarget.value)}
            />
            <div class="alternative-editor-buttons">
                <button type="button" class="menu_button" onClick={() => props.onSave(text())}>
                    {t('Save')}
                </button>
                <button type="button" class="menu_button" onClick={() => props.onCancel()}>
                    {t('Cancel')}
                </button>
            </div>
        </div>
    );
}
