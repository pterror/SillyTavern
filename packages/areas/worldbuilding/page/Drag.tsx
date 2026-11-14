import { Show, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { useUi } from '@st/page/context';
import { LOOP_CHECK_VISITS_PER_WRITE } from '../protocol.ts';
import type { ActionResult } from '@st/page/client';
import type { Grouping, Membership } from './CardMenu.tsx';
import { fill } from './words.ts';

// The drag finds where it is from the elements under the pointer: a region's own element carries these, and each cell
// of its grid `data-entry`.
export const REGION_ATTRIBUTES = (entry: string, name: string, kind: string | null) => ({
    'data-region': entry,
    'data-region-name': name,
    'data-kind': kind ?? '',
});

export type Slot = { after: string | null; before: string | null };

export type CellAt = { column: number | null; row: number | null };

// A card of a board's or grid's cell: what a drop into another cell is said as (null: that cell takes no drop), and
// the drop.
export type CellsDrag = {
    from: CellAt;
    label(from: CellAt, to: CellAt, alt: boolean): { kind: string; change: string; keepBoth: boolean } | null;
    drop(entry: string, from: CellAt, to: CellAt, keepBoth: boolean, slot: Slot): void;
};

export type Dragged = {
    entry: string;
    name: string;
    // Null for a card of a cell, which `cells` moves.
    grouping: Grouping | null;
    region: Membership;
    element: HTMLElement;
    cells?: CellsDrag;
    // The world whose own order a top-level card or row moves in, when the list is drawn in that order.
    reorders?: string;
};

// `top`: a place among the top-level cards or rows, in the world's own order; `name` is then the one it goes before.
type Over = { entry: string; name: string; element: HTMLElement; slot: Slot; cell: CellAt | null; top?: boolean };

type Held = {
    dragged: Dragged;
    ghost: HTMLElement;
    grab: { x: number; y: number };
    at: { x: number; y: number };
    over: Over | null;
    alt: boolean;
};

const STARTS_AFTER_PX = 6;
const GHOST_WIDTH_PX = 330;

// Where among a region's own cells (not its nested regions' cells) a drop at (x, y) lands, leaving out the dragged
// entry: the cells read in their order, the drop going before the first one the point is above or left of the middle of.
// Rows (`rows`) are read top to bottom only: a drop goes before the first row the point is above the middle of.
export function slotAt(
    cells: { entry: string; rect: DOMRect }[],
    x: number,
    y: number,
    dragged: string,
    rows = false,
): Slot {
    const shown = cells.filter((cell) => cell.entry !== dragged);
    const at = shown.findIndex(({ rect }) =>
        rows ? y < rect.top + rect.height / 2 : y < rect.top || (y < rect.bottom && x < rect.left + rect.width / 2),
    );
    if (at === -1) return { after: shown.at(-1)?.entry ?? null, before: null };
    return { after: shown[at - 1]?.entry ?? null, before: shown[at]?.entry ?? null };
}

const cellsOf = (region: HTMLElement) =>
    [...region.querySelectorAll<HTMLElement>(':scope > .wb-grid > [data-entry]')].map((cell) => ({
        entry: cell.dataset['entry'] ?? '',
        rect: cell.getBoundingClientRect(),
    }));

export type DragControl = {
    press(event: PointerEvent, dragged: Dragged): void;
    moves(holding: Pick<Held, 'dragged' | 'over'>): boolean;
    clickIsDrop(): boolean;
    held: Accessor<Held | null>;
};

export function dragControl(act: (type: string, payload: unknown) => Promise<ActionResult>): DragControl {
    const [held, setHeld] = createSignal<Held | null>(null);
    let pressed: { dragged: Dragged; x: number; y: number; grabX: number; grabY: number } | null = null;
    // The card's click that follows a drop's release isn't an open.
    let dropped = false;

    const cellOver = (under: Element | null, x: number, y: number, dragged: Dragged, cells: CellsDrag): Over | null => {
        const element = under?.closest<HTMLElement>('[data-cell]');
        if (!element) return null;
        const [column = '', row = ''] = (element.dataset['cell'] ?? '').split(':');
        const cell = { column: column === '' ? null : Number(column), row: row === '' ? null : Number(row) };
        const moved = cell.column !== cells.from.column || cell.row !== cells.from.row;
        if (moved && !cells.label(cells.from, cell, false)) return null;
        const grid = element.querySelector<HTMLElement>(':scope .wb-cell-cards');
        const shown = grid
            ? [...grid.querySelectorAll<HTMLElement>(':scope > [data-entry]')].map((card) => ({
                  entry: card.dataset['entry'] ?? '',
                  rect: card.getBoundingClientRect(),
              }))
            : [];
        return { entry: '', name: '', element, slot: slotAt(shown, x, y, dragged.entry), cell };
    };

    const topOver = (under: Element | null, x: number, y: number, dragged: Dragged): Over | null => {
        const list = under?.closest<HTMLElement>('.wb-top, .wb-trs');
        if (!list) return null;
        const placed = [...list.querySelectorAll<HTMLElement>(':scope > [data-entry]')];
        const rows = list.classList.contains('wb-trs');
        const slot = slotAt(
            placed.map((cell) => ({ entry: cell.dataset['entry'] ?? '', rect: cell.getBoundingClientRect() })),
            x,
            y,
            dragged.entry,
            rows,
        );
        const before = placed.find((cell) => cell.dataset['entry'] === slot.before);
        return { entry: '', name: before?.dataset['name'] ?? '', element: list, slot, cell: null, top: true };
    };

    const overAt = (x: number, y: number, dragged: Dragged): Over | null => {
        const under = document.elementFromPoint(x, y);
        if (dragged.cells) return cellOver(under, x, y, dragged, dragged.cells);
        const region = under instanceof Element ? under.closest<HTMLElement>('[data-region]') : null;
        const inRegion =
            dragged.grouping !== null &&
            region !== null &&
            !dragged.element.contains(region) &&
            region.dataset['kind'] === dragged.grouping.kind;
        if (!inRegion && dragged.reorders !== undefined) return topOver(under, x, y, dragged);
        if (!dragged.grouping) return null;
        if (!region || dragged.element.contains(region)) return null;
        if (region.dataset['kind'] !== dragged.grouping.kind) return null;
        const entry = region.dataset['region'] ?? '';
        if (entry === dragged.entry) return null;
        return {
            entry,
            name: region.dataset['regionName'] ?? '',
            element: region,
            slot: slotAt(cellsOf(region), x, y, dragged.entry),
            cell: null,
        };
    };

    const moves = (holding: Pick<Held, 'dragged' | 'over'>): boolean => {
        const { over, dragged } = holding;
        if (!over) return false;
        if (over.top === true) return true;
        if (over.cell && dragged.cells)
            return over.cell.column !== dragged.cells.from.column || over.cell.row !== dragged.cells.from.row;
        return over.entry !== dragged.region?.entry;
    };

    const show = (next: Held | null) => {
        const before = held();
        if (before?.over && before.over.element !== next?.over?.element)
            before.over.element.classList.remove('wb-drop');
        if (next?.over && moves(next)) next.over.element.classList.add('wb-drop');
        setHeld(next);
    };

    const end = () => {
        const was = held();
        was?.dragged.element.classList.remove('wb-gone');
        show(null);
        pressed = null;
        window.removeEventListener('pointermove', moved, true);
        window.removeEventListener('pointerup', released, true);
        window.removeEventListener('keydown', key, true);
        window.removeEventListener('keyup', key, true);
    };

    const moved = (event: PointerEvent) => {
        if (!pressed) return;
        const now = held();
        if (!now) {
            if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < STARTS_AFTER_PX) return;
            const ghost = pressed.dragged.element.cloneNode(true) as HTMLElement;
            ghost.classList.remove('wb-region');
            ghost.querySelectorAll('.wb-grid, .wb-card-more, .wb-region-search').forEach((part) => part.remove());
            pressed.dragged.element.classList.add('wb-gone');
            show({
                dragged: pressed.dragged,
                ghost,
                grab: { x: Math.min(pressed.grabX, GHOST_WIDTH_PX - 20), y: pressed.grabY },
                at: { x: event.clientX, y: event.clientY },
                over: null,
                alt: event.altKey,
            });
        }
        const holding = held();
        if (!holding) return;
        show({
            ...holding,
            at: { x: event.clientX, y: event.clientY },
            over: overAt(event.clientX, event.clientY, holding.dragged),
            alt: event.altKey,
        });
    };

    const key = (event: KeyboardEvent) => {
        const holding = held();
        if (event.key === 'Escape') {
            event.stopPropagation();
            event.preventDefault();
            end();
            return;
        }
        if (event.key === 'Alt' && holding) {
            event.preventDefault();
            show({ ...holding, alt: event.type === 'keydown' });
        }
    };

    const released = (event: PointerEvent) => {
        const holding = held();
        end();
        if (!holding) return;
        dropped = true;
        const over = holding.over;
        if (!over) return;
        const { dragged } = holding;
        const keeps = event.altKey || holding.alt;
        if (over.cell && dragged.cells) {
            dragged.cells.drop(dragged.entry, dragged.cells.from, over.cell, keeps, over.slot);
            return;
        }
        if (over.top === true && dragged.reorders !== undefined) {
            if (over.slot.after !== null || over.slot.before !== null)
                void act('worldbuilding.placeInWorldOrder', {
                    book: dragged.reorders,
                    entry: dragged.entry,
                    after: over.slot.after,
                });
            return;
        }
        if (!dragged.grouping) return;
        const relation = { book: dragged.grouping.book, entry: dragged.entry, kind: dragged.grouping.kind };
        const keepBoth = keeps;
        if (dragged.region !== null && !(keepBoth && over.entry !== dragged.region.entry))
            void act('worldbuilding.moveRelation', {
                ...relation,
                target: dragged.region.entry,
                newTarget: over.entry,
                ...over.slot,
                loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
            });
        else
            void act('worldbuilding.addRelation', {
                ...relation,
                target: over.entry,
                ...over.slot,
                weak: false,
                loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
            });
    };

    return {
        held,
        moves,
        clickIsDrop() {
            const was = dropped;
            dropped = false;
            return was;
        },
        press(event, dragged) {
            dropped = false;
            if (event.button !== 0 || held()) return;
            const rect = dragged.element.getBoundingClientRect();
            pressed = {
                dragged,
                x: event.clientX,
                y: event.clientY,
                grabX: event.clientX - rect.left,
                grabY: event.clientY - rect.top,
            };
            window.addEventListener('pointermove', moved, true);
            window.addEventListener('pointerup', released, true);
            window.addEventListener('keydown', key, true);
            window.addEventListener('keyup', key, true);
        },
    };
}

export function DragLayer(props: { control: DragControl }) {
    const { t } = useUi();
    onCleanup(() => props.control.held()?.dragged.element.classList.remove('wb-gone'));
    return (
        <Show when={props.control.held()}>
            {(holding) => {
                const moving = () => (props.control.moves(holding()) ? holding().over : null);
                const cellSaid = () => {
                    const { over, dragged, alt } = holding();
                    return over?.cell && dragged.cells ? dragged.cells.label(dragged.cells.from, over.cell, alt) : null;
                };
                return (
                    <div
                        class="wb-dragged"
                        style={{
                            left: `${holding().at.x - holding().grab.x}px`,
                            top: `${holding().at.y - holding().grab.y}px`,
                            width: `${GHOST_WIDTH_PX}px`,
                        }}
                        aria-hidden="true"
                    >
                        <div class="wb-dragged-card" ref={(element) => element.append(holding().ghost)} />
                        <Show when={moving() && cellSaid()}>
                            {(said) => (
                                <div class="wb-intent">
                                    <span class="wb-intent-kind">{said().kind}</span>
                                    <b>{said().change}</b>
                                    <Show when={said().keepBoth}>
                                        <span>{t('Alt: add instead of move')}</span>
                                    </Show>
                                </div>
                            )}
                        </Show>
                        <Show when={holding().over?.top === true && holding().over}>
                            {(over) => (
                                <div class="wb-intent">
                                    <span class="wb-intent-kind">{t('World order')}</span>
                                    <b>{over().name === '' ? t('Last') : fill(t('Before ${0}'), over().name)}</b>
                                </div>
                            )}
                        </Show>
                        <Show when={!holding().over?.cell && holding().over?.top !== true && moving()}>
                            {(over) => (
                                <div class="wb-intent">
                                    <span class="wb-intent-kind">{holding().dragged.grouping?.kindName ?? ''}</span>
                                    <b>
                                        {holding().alt
                                            ? fill(t('Add to ${0}'), over().name)
                                            : holding().dragged.region
                                              ? `${holding().dragged.region?.label.text ?? ''} → ${over().name}`
                                              : `→ ${over().name}`}
                                    </b>
                                    <Show when={!holding().alt && holding().dragged.region}>
                                        <span>{t('Alt: add instead of move')}</span>
                                    </Show>
                                </div>
                            )}
                        </Show>
                    </div>
                );
            }}
        </Show>
    );
}
