import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { OverviewView } from '../protocol.ts';
import { Cell } from './Cards.tsx';
import type { CardActions } from './Cards.tsx';
import { CARD_HEIGHT } from './layout.ts';

export type Range = { firstRank: number; endRank: number };

// The world's top-level entries, read a range at a time as the pane scrolls. What is above the range read stands as
// the height it had when it was drawn, so moving the range never moves what is on screen.
export function TopLevel(props: {
    view: OverviewView;
    pane: HTMLElement;
    shown: number;
    columns: number;
    actions: CardActions;
    onRange: (range: Range) => void;
    // Draws each top-level entry, its region with it, in place of its card; one column of them.
    rows?: (cell: OverviewView['entries'][number]) => JSX.Element;
    rowHeight?: number;
}) {
    const columns = () => (props.rows ? 1 : props.columns);
    const itemHeight = () => props.rowHeight ?? CARD_HEIGHT;
    let list: HTMLDivElement | undefined;
    const tops = new Map<number, number>();
    const rowStarts = new Set<number>();
    const [asked, setAsked] = createSignal<Range | null>(null);
    const averageRow = () => {
        const known = [...tops.values()];
        if (known.length < 2) return itemHeight();
        return Math.max(itemHeight() / 2, (Math.max(...known) - Math.min(...known)) / Math.max(1, known.length - 1));
    };
    const estimatedTop = (rank: number): number => {
        const known = tops.get(rank);
        if (known !== undefined) return known;
        return (rank / Math.max(1, columns())) * averageRow();
    };
    const lastRank = () => props.view.firstRank + props.view.entries.length;
    const above = () => (props.view.firstRank === 0 ? 0 : estimatedTop(props.view.firstRank));
    const below = () => Math.max(0, ((props.view.topLevelCount - lastRank()) / Math.max(1, columns())) * averageRow());

    const measure = () => {
        if (!list) return;
        let left = Infinity;
        const items = [...list.querySelectorAll<HTMLElement>(':scope > [data-rank]')];
        for (const item of items) left = Math.min(left, item.offsetLeft);
        for (const item of items) {
            const rank = Number(item.dataset['rank']);
            tops.set(rank, item.offsetTop);
            if (item.offsetLeft === left) rowStarts.add(rank);
            else rowStarts.delete(rank);
        }
    };

    const rankAt = (y: number): number => {
        let best = 0;
        for (const [rank, top] of tops) if (top <= y && rank > best) best = rank;
        if (tops.size === 0 || y > Math.max(...tops.values()) + 2 * averageRow())
            return Math.min(props.view.topLevelCount, Math.floor((y / averageRow()) * Math.max(1, columns())));
        return best;
    };

    const rowStartAtOrBefore = (rank: number): number => {
        for (let at = rank; at > 0; at--) if (rowStarts.has(at) || !tops.has(at)) return at;
        return 0;
    };

    const follow = () => {
        if (!list) return;
        measure();
        const screen = props.pane.clientHeight;
        const top = props.pane.scrollTop - list.offsetTop;
        const first = props.view.firstRank;
        const end = lastRank();
        const count = props.view.topLevelCount;
        const loadedBottom = end >= count ? Infinity : estimatedTop(end);
        const loadedTop = first === 0 ? -Infinity : estimatedTop(first);
        if (top + 2 * screen < loadedBottom && top - screen > loadedTop) return;
        const centre = rankAt(top + screen / 2);
        const half = Math.floor(props.shown / 2);
        const firstRank = rowStartAtOrBefore(Math.max(0, Math.min(centre - half, count - props.shown)));
        const range = { firstRank, endRank: Math.min(count, firstRank + props.shown) };
        const held = asked();
        if (range.firstRank === first && range.endRank === end) return;
        if (held && held.firstRank === range.firstRank && held.endRank === range.endRank) return;
        setAsked(range);
        props.onRange(range);
    };

    onMount(() => {
        const scrolled = () => requestAnimationFrame(follow);
        props.pane.addEventListener('scroll', scrolled, { passive: true });
        onCleanup(() => props.pane.removeEventListener('scroll', scrolled));
    });
    createEffect(
        on(
            () => [props.view.firstRank, props.view.entries.length, props.view.topLevelCount],
            () => requestAnimationFrame(follow),
        ),
    );

    return (
        <div
            class={props.rows ? 'wb-trs' : 'wb-grid wb-top'}
            ref={(element) => (list = element)}
            style={{ 'padding-top': `${above()}px`, 'padding-bottom': `${below()}px` }}
        >
            <For each={props.view.entries}>
                {(cell) => (
                    <Show
                        when={props.rows}
                        fallback={
                            <div
                                class="wb-top-cell"
                                data-rank={cell.topLevelRank}
                                data-entry={cell.cell === 'entry' ? cell.entry : undefined}
                                classList={{ 'wb-wide': cell.region.length > 0 }}
                            >
                                <Cell cell={cell} region={null} actions={props.actions} />
                            </div>
                        }
                    >
                        {(draw) => <div data-rank={cell.topLevelRank}>{draw()(cell)}</div>}
                    </Show>
                )}
            </For>
        </div>
    );
}
