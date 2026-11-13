import { For, Show, onCleanup, onMount } from 'solid-js';
import { useUi } from '@st/page/context';
import { MAX_CARDS_PER_READ } from '../protocol.ts';
import type { Chip, ResultsView } from '../protocol.ts';
import { Cell } from './Cards.tsx';
import type { CardActions } from './Cards.tsx';
import { Icon } from './icons.tsx';
import { EntryRows } from './Rows.tsx';
import type { RowsContext } from './Rows.tsx';
import { fill } from './words.ts';

// What is typed in the search box and the region it is scoped to: the box's own input, sent whole with each change.
export type Typed = { query: string; scope: { chip: Chip; label: string } | null };

export const NOTHING_TYPED: Typed = { query: '', scope: null };

export const filterOf = (typed: Typed): { query: string; chips: Chip[] } => ({
    query: typed.query,
    chips: typed.scope === null ? [] : [typed.scope.chip],
});

export function SearchBox(props: { typed: Typed; onType: (typed: Typed) => void }) {
    const { t } = useUi();
    const scope = () => props.typed.scope;
    return (
        <label class="wb-search" classList={{ 'wb-searching': props.typed.query !== '' || scope() !== null }}>
            <Icon name="search" />
            <Show when={scope()}>
                {(shown) => (
                    <span class="wb-scope">
                        {shown().label}
                        <button
                            type="button"
                            aria-label={t('Search the whole world')}
                            onClick={(event) => {
                                event.preventDefault();
                                props.onType({ ...props.typed, scope: null });
                            }}
                        >
                            ×
                        </button>
                    </span>
                )}
            </Show>
            <input
                aria-label={t('Search this world')}
                placeholder={scope() ? fill(t('Search in ${0}'), scope()?.label ?? '') : t('Search this world')}
                value={props.typed.query}
                onInput={(event) => props.onType({ ...props.typed, query: event.currentTarget.value })}
            />
        </label>
    );
}

export function Results(props: {
    view: Extract<ResultsView, { book: string }>;
    pageSize: number;
    actions: CardActions;
    onMore: (pages: number) => void;
    rows: RowsContext | null;
}) {
    const { t } = useUi();
    let end: HTMLDivElement | undefined;
    const entries = () => props.view.pages.flatMap((page) => page.entries);
    const more = () => props.view.pages.at(-1)?.next !== null && props.view.pages.length > 0;
    onMount(() => {
        const watch = new IntersectionObserver((seen) => {
            if (!seen.some((one) => one.isIntersecting) || !more()) return;
            const pages = props.view.pages.length + 1;
            if (pages * props.pageSize <= MAX_CARDS_PER_READ) props.onMore(pages);
        });
        if (end) watch.observe(end);
        onCleanup(() => watch.disconnect());
    });
    return (
        <>
            <Show
                when={props.rows}
                fallback={
                    <div class="wb-grid">
                        <For each={entries()}>
                            {(cell) => (
                                <div class="wb-top-cell" classList={{ 'wb-wide': cell.region.length > 0 }}>
                                    <Cell cell={cell} region={null} actions={props.actions} />
                                </div>
                            )}
                        </For>
                    </div>
                }
            >
                {(rows) => (
                    <div class="wb-trs">
                        <For each={entries()}>{(cell) => <EntryRows cell={cell} depth={0} context={rows()} />}</For>
                    </div>
                )}
            </Show>
            <Show when={entries().length === 0 && !more()}>
                <p class="wb-quiet">{t('No entry matches.')}</p>
            </Show>
            <div ref={(element) => (end = element)} class="wb-results-end" aria-hidden="true" />
        </>
    );
}
