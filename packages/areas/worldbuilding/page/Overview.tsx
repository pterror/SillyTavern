import { Index, Show, createEffect, createMemo, on, onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { OverviewCell, OverviewView } from '../protocol.ts';
import { Cell } from './Cards.tsx';
import type { CardActions } from './Cards.tsx';

import { SCREENS_AHEAD } from './layout.ts';

// The top-level entries of every page read so far, from the first; a page not in yet ends them.
export function drawnEntries(view: OverviewView): OverviewCell[] {
    const all: OverviewCell[] = [];
    for (let at = 0; at < view.pageCount; at++) {
        const page = view.pages[at];
        if (!page) break;
        all.push(...page.entries);
    }
    return all;
}

const entryOf = (cell: OverviewCell) => (cell.cell === 'entry' ? cell.entry : undefined);
const nameOf = (cell: OverviewCell) => (cell.cell === 'entry' ? cell.label.text : undefined);

// Every top-level entry read is drawn and stays. While less than SCREENS_AHEAD screens of them are below what is on
// screen, the page asks for as many more as fill that many screens, as far as it has drawn tells it; past that it waits
// until the person scrolls on.
export function TopLevel(props: {
    view: OverviewView;
    pane: HTMLElement;
    actions: CardActions;
    onMore: (to: number) => void;
    // Draws each top-level entry, its region with it, in place of its card; one column of them.
    rows?: (cell: OverviewCell) => JSX.Element;
}) {
    const entries = createMemo(() => drawnEntries(props.view));
    const allIn = () => {
        for (let at = 0; at < props.view.pageCount; at++) if (!props.view.pages[at]) return false;
        return true;
    };
    const hasMore = () => allIn() && entries().length < props.view.topLevelCount;
    let list: HTMLDivElement | undefined;
    // What the last ask asked for, and how many were drawn then: fewer drawn now, or another overview, asks afresh.
    let asked = { to: 0, drawn: 0 };
    const askIfNear = () => {
        if (!list || !hasMore()) return;
        const screen = props.pane.clientHeight;
        const drawn = entries().length;
        if (drawn < asked.drawn) asked = { to: 0, drawn: 0 };
        const tall = list.getBoundingClientRect();
        const below = tall.bottom - props.pane.getBoundingClientRect().bottom;
        if (below > SCREENS_AHEAD * screen || tall.height === 0) return;
        const perScreen = Math.max(1, Math.ceil((drawn * screen) / tall.height));
        const to = drawn + SCREENS_AHEAD * perScreen;
        if (to <= asked.to) return;
        asked = { to, drawn };
        props.onMore(to);
    };
    onMount(() => {
        props.pane.addEventListener('scroll', askIfNear, { passive: true });
        onCleanup(() => {
            props.pane.removeEventListener('scroll', askIfNear);
        });
    });
    createEffect(
        on(
            () => [props.view.book, props.view.groupBy, props.view.pageSize],
            () => {
                asked = { to: 0, drawn: 0 };
            },
        ),
    );
    createEffect(
        on(
            () => [entries().length, props.view.topLevelCount],
            () => requestAnimationFrame(askIfNear),
        ),
    );

    return (
        <>
            <div class={props.rows ? 'wb-trs' : 'wb-grid wb-top'} ref={(element) => (list = element)}>
                <Index each={entries()}>
                    {(cell) => (
                        <Show
                            when={props.rows}
                            fallback={
                                <div
                                    class="wb-top-cell"
                                    data-rank={cell().topLevelRank}
                                    data-entry={entryOf(cell())}
                                    data-name={nameOf(cell())}
                                    classList={{ 'wb-wide': cell().region.length > 0 }}
                                >
                                    <Cell cell={cell()} region={null} actions={props.actions} />
                                </div>
                            }
                        >
                            {(draw) => (
                                <div
                                    class="wb-top-row"
                                    data-rank={cell().topLevelRank}
                                    data-entry={entryOf(cell())}
                                    data-name={nameOf(cell())}
                                >
                                    {draw()(cell())}
                                </div>
                            )}
                        </Show>
                    )}
                </Index>
            </div>
        </>
    );
}
