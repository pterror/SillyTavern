import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import { unwrap } from 'solid-js/store';
import { useUi } from '@st/page/context';
import { ask } from '@st/page/dialog';
import { COUNTS_VIEW, LIST_VIEW, MATCHES_VIEW } from '../protocol.ts';
import type { CountsView, GreetingOp, Item, ListView, MatchesView, Target } from '../protocol.ts';
import { markWords, matchedWords } from './marks.ts';
import { createSeen } from './seen.ts';
import type { Seen } from './seen.ts';

export type OldPage = {
    format(text: string, item: { name: string; role: Item['role'] }, mesId: number | null): DocumentFragment;
    date(value: string | number): string;
    tokenizer(): Record<string, unknown> | null;
    cantGo(mesId: number): string | null;
    go(mesId: number, index: number): Promise<void>;
    remove(mesId: number, index: number): Promise<void>;
    copy(text: string): Promise<void>;
    greetingsChanged(card: NonNullable<ListView['card']>, edit: { hash: number; text: string } | null): void;
    editAt(event: MouseEvent, rendered: HTMLElement, source: string): number | null;
};

export type Look = { target: Target; mesId: number | null; title: string; at?: number };

const keyOf = (target: Target) => JSON.stringify(target);
const FIRST_ROWS = 40;

export function Alternatives(props: { look: Look | null; old: OldPage; onClose: () => void }) {
    const { client } = useUi();
    const views = {
        list: client.view<ListView>(LIST_VIEW),
        counts: client.view<CountsView>(COUNTS_VIEW),
        matches: client.view<MatchesView>(MATCHES_VIEW),
    };
    const seen = createSeen();
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
    html: DocumentFragment | null;
    htmlOf: string;
    painted: string;
    visible: boolean;
};

const idle: (work: (deadline: { timeRemaining(): number }) => void) => void =
    typeof requestIdleCallback === 'function'
        ? (work) => void requestIdleCallback(work, { timeout: 200 })
        : (work) => {
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
    seen: ReturnType<typeof createSeen>;
}) {
    const { client, t } = useUi();
    const key = keyOf(props.look.target);
    const greetingsList = 'greetings' in props.look.target;
    const mesId = props.look.mesId;

    const isOurs = (list: ListView | undefined) => !!list?.target && keyOf(list.target) === key;
    const [seen, setSeen] = createSignal<Seen | null>(null);
    void props.seen.find(key).then(setSeen);
    const list = createMemo(() => {
        const live = props.views.list();
        if (isOurs(live) && (live!.complete || !seen())) return live!;
        return seen()?.list ?? null;
    });
    const items = () => list()?.items ?? [];
    const total = () => list()?.total ?? 0;
    const byIndex = createMemo(() => new Map(items().map((item) => [item.index, item])));
    const itemAt = (index: number) => byIndex().get(index);
    const counts = () => (isOurs(props.views.list()) ? props.views.counts()?.counts : seen()?.counts.counts) ?? {};
    const current = () => list()?.current ?? null;
    const matches = () => props.views.matches()?.matches ?? null;
    const searching = () => {
        const view = props.views.matches();
        return view?.matches != null && view.checked < view.total;
    };
    const matchesKey = createMemo(() => JSON.stringify(matches()));

    const [query, setQuery] = createSignal('');
    const [notice, setNotice] = createSignal<string | null>(null);
    const [editing, setEditing] = createSignal<{ id: string; at?: number } | null>(null);
    const [drop, setDrop] = createSignal<{ id: string; side: 'before' | 'after' } | null>(null);
    const [ticks, setTicks] = createSignal<{ top: number; current: boolean }[]>([]);

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
        if (isOurs(live) && live!.complete) {
            void props.seen.keep({
                key,
                version: client.version(LIST_VIEW),
                list: structuredClone(unwrap(live!)),
                counts: structuredClone(unwrap(props.views.counts() ?? { counts: {} })),
                used: Date.now(),
            });
        }
        void client.send('alternatives.close', {});
    });

    let dialog: HTMLDialogElement | undefined;
    let scroller: HTMLOListElement | undefined;
    onMount(() => dialog?.showModal());

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
                if (isPainted(row) || hidden(row.item)) continue;
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

    createEffect(
        on(matchesKey, (now, before) => {
            for (const row of rows.values()) if (row.visible) paint(row);
            paintRest();
            measure();
            if (now === 'null' && before !== undefined && before !== 'null') {
                queueMicrotask(() => scrollTo(current() ?? 0, false));
            }
        }),
    );

    const rowOf = (index: number) => {
        const item = itemAt(index);
        return item ? rows.get(item.id) : undefined;
    };
    const scrollTo = (index: number, focus: boolean) => {
        const row = rowOf(index);
        if (!row) return;
        paint(row);
        row.li.scrollIntoView({ block: 'center' });
        if (focus) row.li.focus({ preventScroll: true });
    };

    let placed = false;
    const [reach, setReach] = createSignal(FIRST_ROWS / 2);
    const mounted = createMemo(() => {
        const at = untrack(() => props.look.at ?? current() ?? 0);
        const within = reach();
        return within >= total() ? items() : items().filter((item) => Math.abs(item.index - at) <= within);
    });
    const widen = () => {
        if (reach() >= total()) {
            setReach(Number.POSITIVE_INFINITY);
            return;
        }
        setReach(reach() * 4);
        requestAnimationFrame(widen);
    };
    createEffect(() => {
        if (placed || items().length === 0) return;
        placed = true;
        const at = props.look.at ?? current() ?? 0;
        const view = scroller?.clientHeight ?? 0;
        const lay = (row: RowState) => {
            paint(row);
            row.li.classList.add('laid');
            return row.li.offsetHeight;
        };
        for (let i = at, below = 0; below < view; i++) {
            const row = rowOf(i);
            if (!row) break;
            below += lay(row);
        }
        for (let i = at - 1, above = 0; above < view; i--) {
            const row = rowOf(i);
            if (!row) break;
            above += lay(row);
        }
        scrollTo(at, false);
        paintRest();
        requestAnimationFrame(() => requestAnimationFrame(widen));
    });

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
                if (!row || hidden(row.item)) return;
                const top = Math.round((row.li.offsetTop / height) * 1000) / 10;
                marks.set(top, (marks.get(top) ?? false) || isCurrent);
            };
            if (found) for (const id of Object.keys(found)) at(id, false);
            const now = current();
            const currentItem = now === null ? undefined : itemAt(now);
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
        return found === null ? total() : Object.keys(found).length;
    };

    const [picked, setPicked] = createSignal<number | null>(props.look.at ?? null);
    const selected = () => picked() ?? current();
    const select = (text: string) => {
        const n = Number.parseInt(text, 10);
        if (!Number.isInteger(n) || n < 1 || n > total()) {
            if (text.trim() !== '') setNotice(t('Enter a number from 1 to ${0}.').replace('${0}', String(total())));
            return;
        }
        setNotice(null);
        setPicked(n - 1);
        const wanted = itemAt(n - 1);
        if (wanted && hidden(wanted)) search('');
        queueMicrotask(() => scrollTo(n - 1, false));
    };
    const selectedWhy = () => {
        const index = selected();
        const item = index === null ? undefined : itemAt(index);
        return item ? whyNotGo(item, index!) : t('Select one first.');
    };
    const goSelected = () => {
        const index = selected();
        const item = index === null ? undefined : itemAt(index);
        if (item) void go(item, index!);
    };

    const whyNotGo = (item: Item, index: number): string | null => {
        if (greetingsList) {
            if (list()?.chatOpen !== true) return t('Open a chat with this character to show a greeting in it.');
            if (item.opening === null) return t("This greeting isn't one the chat can show.");
            return null;
        }
        if (index === current()) return t('The chat shows this one.');
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
    const isCardRow = (item: Item) => item.card !== null && list()?.card != null;
    const canRemove = (item: Item) => !greetingsList && item.nodeId !== null && total() > 1;
    const remove = async (index: number) => {
        await props.old.remove(mesId!, index);
    };
    const removeGreeting = async (item: Item) => {
        const sure = await ask({ kind: 'confirm', message: t('Delete this greeting from the card?') }, t);
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
    const add = async (text: string) => text.trim() !== '' && (await greeting({ op: 'add', text }, null));
    const save = async (item: Item, text: string) => {
        if (text.trim() === '') {
            const sure = await ask({ kind: 'confirm', message: t('This greeting is empty now. Delete it?') }, t);
            if (!sure) return;
        }
        const card = item.card!;
        if (await greeting({ op: 'edit', position: card.position, hash: card.hash, text }, { hash: card.hash, text }))
            setEditing(null);
    };
    const editAt = (item: Item, event: MouseEvent) => {
        if (!isCardRow(item) || editing()?.id === item.id) return;
        const at = props.old.editAt(event, event.currentTarget as HTMLElement, item.text);
        if (at !== null) setEditing({ id: item.id, at });
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
    const keyMove = (item: Item, event: KeyboardEvent) => {
        const cards = items().filter((i) => i.card !== null);
        const at = cards.findIndex((i) => i.id === item.id);
        const to: Record<string, [number, 'before' | 'after']> = {
            ArrowUp: [at - 1, 'before'],
            ArrowDown: [at + 1, 'after'],
            Home: [0, 'before'],
            End: [cards.length - 1, 'after'],
        };
        const [index, side] = to[event.key] ?? [-1, 'after'];
        const target = cards[index];
        if (!target) return;
        event.preventDefault();
        move(item, target, side);
    };

    const title = () =>
        greetingsList ? t('Greetings') : props.look.title !== '' ? props.look.title : t('Alternatives');
    const counted = () => {
        const one = total() === 1;
        const words = greetingsList
            ? one
                ? t('${0} greeting')
                : t('${0} greetings')
            : one
              ? t('${0} alternative')
              : t('${0} alternatives');
        return words.replace('${0}', total().toLocaleString());
    };

    return (
        <dialog
            ref={(el: HTMLDialogElement) => (dialog = el)}
            class="alternatives"
            aria-label={title()}
            onCancel={(event) => {
                event.preventDefault();
                props.onClose();
            }}
        >
            <div class="alternatives-body">
                <header class="alternatives-header">
                    <h3 class="alternatives-title">{title()}</h3>
                    <span class="alternatives-place" aria-live="polite">
                        <Show when={list()} fallback={t('Loading…')}>
                            <Show when={current() !== null} fallback={counted()}>
                                {t('#${0} of ${1}')
                                    .replace('${0}', ((current() ?? 0) + 1).toLocaleString())
                                    .replace('${1}', total().toLocaleString())}
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
                                max={total()}
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
                        <Show
                            when={searching()}
                            fallback={
                                shownCount() === 0
                                    ? t('Nothing matches.')
                                    : t('${0} match').replace('${0}', String(shownCount()))
                            }
                        >
                            {t('Searching… ${0} of ${1} checked, ${2} found')
                                .replace('${0}', String(props.views.matches()?.checked ?? 0))
                                .replace('${1}', String(props.views.matches()?.total ?? 0))
                                .replace('${2}', String(shownCount()))}
                        </Show>
                    </p>
                </Show>
                <div class="alternatives-frame">
                    {/* A search hides what doesn't match by one class on the list (rows only say they match), so it
                        changes as many rows as it finds, not every row. */}
                    <ol
                        class="alternatives-list"
                        classList={{ filtering: matches() !== null }}
                        ref={(el: HTMLOListElement) => (scroller = el)}
                    >
                        <For each={mounted()}>
                            {(item) => (
                                <li
                                    class="alternative"
                                    data-id={item.id}
                                    tabindex="-1"
                                    onClick={(event) => {
                                        if (
                                            !(event.target as HTMLElement).closest('button, textarea, a, [role=button]')
                                        )
                                            setPicked(item.index);
                                    }}
                                    classList={{
                                        matched: matches()?.[item.id] !== undefined,
                                        current: item.index === current(),
                                        selected: item.index === selected(),
                                        'drop-before': drop()?.id === item.id && drop()?.side === 'before',
                                        'drop-after': drop()?.id === item.id && drop()?.side === 'after',
                                    }}
                                    ref={(li: HTMLLIElement) => {
                                        const body = li.querySelector<HTMLElement>('.alternative-text');
                                        if (body) untrack(() => register(item, li, body));
                                    }}
                                >
                                    <div class="alternative-head">
                                        <Show when={isCardRow(item)}>
                                            <span
                                                class="alternative-drag fa-solid fa-grip-vertical"
                                                role="button"
                                                tabindex="0"
                                                title={t('Drag to reorder (or use the arrow keys, Home and End)')}
                                                aria-label={t('Reorder')}
                                                onPointerDown={(event) => dragFrom(item, event)}
                                                onKeyDown={(event) => keyMove(item, event)}
                                            />
                                        </Show>
                                        <span class="alternative-number">#{item.index + 1}</span>
                                        <Show when={item.index === current()}>
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
                                                class="alternative-button alternative-go"
                                                aria-disabled={whyNotGo(item, item.index) !== null}
                                                title={whyNotGo(item, item.index) ?? undefined}
                                                onClick={() => void go(item, item.index)}
                                            >
                                                {greetingsList ? t('Show in chat') : t('Go')}
                                            </button>
                                            <button
                                                type="button"
                                                class="alternative-button alternative-copy fa-solid fa-copy"
                                                title={t('Copy')}
                                                aria-label={t('Copy')}
                                                onClick={() => void props.old.copy(item.text)}
                                            />
                                            <Show when={isCardRow(item)}>
                                                <button
                                                    type="button"
                                                    class="alternative-button alternative-default fa-star"
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
                                                    class="alternative-button alternative-edit fa-solid fa-pencil"
                                                    title={t('Edit')}
                                                    aria-label={t('Edit')}
                                                    onClick={() => setEditing({ id: item.id })}
                                                />
                                                <button
                                                    type="button"
                                                    class="alternative-button alternative-delete-greeting fa-solid fa-trash-can"
                                                    title={t('Delete from the card')}
                                                    aria-label={t('Delete from the card')}
                                                    onClick={() => void removeGreeting(item)}
                                                />
                                            </Show>
                                            <Show when={canRemove(item)}>
                                                <button
                                                    type="button"
                                                    class="alternative-button alternative-delete fa-solid fa-comment-slash"
                                                    title={t('Delete from the chat')}
                                                    aria-label={t('Delete from the chat')}
                                                    onClick={() => void remove(item.index)}
                                                />
                                            </Show>
                                        </span>
                                    </div>
                                    <div
                                        class="mes_text alternative-text"
                                        hidden={editing()?.id === item.id}
                                        onClick={(event) => editAt(item, event)}
                                        onDblClick={(event) => editAt(item, event)}
                                    />
                                    <Show when={editing()?.id === item.id ? editing() : null}>
                                        {(edit) => (
                                            <Editor
                                                text={item.text}
                                                at={edit().at}
                                                onSave={(text) => void save(item, text)}
                                                onCancel={() => setEditing(null)}
                                            />
                                        )}
                                    </Show>
                                </li>
                            )}
                        </For>
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
                <Show when={list()?.card}>
                    <AddBox onAdd={add} />
                </Show>
            </div>
        </dialog>
    );
}

function AddBox(props: { onAdd: (text: string) => Promise<boolean> }) {
    const { t } = useUi();
    const [text, setText] = createSignal('');
    const [busy, setBusy] = createSignal(false);
    const submit = async () => {
        if (busy() || text().trim() === '') return;
        setBusy(true);
        try {
            if (await props.onAdd(text())) setText('');
        } finally {
            setBusy(false);
        }
    };
    return (
        <form
            class="alternatives-add"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <textarea
                class="text_pole textarea_compact"
                rows="1"
                placeholder={t('New greeting…')}
                aria-label={t('New greeting')}
                value={text()}
                onInput={(event) => setText(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        void submit();
                    } else if (event.key === 'Escape' && text() !== '') {
                        event.preventDefault();
                        event.stopPropagation();
                        setText('');
                    }
                }}
            />
            <button type="submit" class="menu_button" disabled={busy() || text().trim() === ''}>
                {t('Add')}
            </button>
        </form>
    );
}

function Editor(props: {
    text: string;
    at?: number | undefined;
    onSave: (text: string) => void;
    onCancel: () => void;
}) {
    const { t } = useUi();
    const [text, setText] = createSignal(props.text);
    let area: HTMLTextAreaElement | undefined;
    onMount(() => {
        area?.focus();
        if (props.at !== undefined) area?.setSelectionRange(props.at, props.at);
    });
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
