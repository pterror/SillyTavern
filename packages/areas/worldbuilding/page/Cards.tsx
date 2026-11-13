import { For, Match, Show, Switch, createSignal } from 'solid-js';
import { useUi } from '@st/page/context';
import { LOOP_CHECK_VISITS_PER_WRITE } from '../protocol.ts';
import type { EntryCell, Named, PlaceOfDeletedEntryCell, RegionCell } from '../protocol.ts';
import { CardMenuButton } from './CardMenu.tsx';
import type { Grouping, Membership } from './CardMenu.tsx';
import { useWb } from './context.ts';
import { REGION_ATTRIBUTES } from './Drag.tsx';
import { Label, Picture } from './Label.tsx';

export { Label, Picture };
import { Icon } from './icons.tsx';
import { count, fill } from './words.ts';

export type CardActions = {
    open(entry: string): void;
    searchIn(entry: string, label: string): void;
    // The kind the cards are grouped by: what their menus and drags change. Null: grouped by nothing.
    grouping(): Grouping | null;
};

// A card's menu, its drag and Alt+arrows, which move it among the cards of its region.
function arranging(props: { entry: string; label: Named; region: Membership; actions: CardActions }) {
    const wb = useWb();
    const [menu, setMenu] = createSignal(false);
    let root: HTMLElement | undefined;
    const press = (event: PointerEvent) => {
        const grouping = props.actions.grouping();
        if (!grouping || !root || (event.target as Element).closest('.wb-card-more, .wb-region-search')) return;
        wb.drag.press(event, {
            entry: props.entry,
            name: props.label.text,
            grouping,
            region: props.region,
            element: root,
        });
    };
    const reorder = (event: KeyboardEvent, entry: string, region: Membership, grouping: Grouping | null) => {
        const grid = root?.parentElement?.closest('.wb-grid');
        if (!event.altKey || !grouping || !region || !root || !grid) return;
        const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
        if (!back && event.key !== 'ArrowRight' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        const cells = [...grid.querySelectorAll<HTMLElement>(':scope > [data-entry]')];
        const at = cells.findIndex((cell) => cell.contains(root ?? null));
        const entryAt = (index: number) => cells[index]?.dataset['entry'] ?? null;
        const slot = back
            ? { after: entryAt(at - 2), before: entryAt(at - 1) }
            : { after: entryAt(at + 1), before: entryAt(at + 2) };
        if ((back ? slot.before : slot.after) === null) return;
        const focused = event.currentTarget as HTMLElement;
        void wb
            .act('worldbuilding.moveRelation', {
                book: grouping.book,
                entry,
                kind: grouping.kind,
                target: region.entry,
                newTarget: region.entry,
                ...slot,
                loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
            })
            .then(() => {
                const moved = grid.querySelector<HTMLElement>(
                    `:scope > [data-entry="${entry}"] :is(.wb-card-open, .wb-region-head)`,
                );
                (moved ?? focused).focus();
            });
    };
    const key = (event: KeyboardEvent) => {
        reorder(event, props.entry, props.region, props.actions.grouping());
    };
    const open = () => {
        if (!wb.drag.clickIsDrop()) props.actions.open(props.entry);
    };
    const Menu = () => (
        <Show when={props.actions.grouping()}>
            {(grouping) => (
                <CardMenuButton
                    entry={props.entry}
                    label={props.label}
                    grouping={grouping()}
                    region={props.region}
                    open={menu()}
                    onOpen={setMenu}
                />
            )}
        </Show>
    );
    return { menu, Menu, press, key, open, ref: (element: HTMLElement) => (root = element) };
}

// What a card says under the name: the text's first paragraph, or nothing when the name already is the opening.
export const gistOf = (cell: Pick<EntryCell, 'label' | 'text'>): string =>
    cell.label.shownAs === 'opening' ? '' : (cell.text.split(/\n/u).find((line) => line.trim() !== '') ?? '');

export function Card(props: { cell: EntryCell; region: Membership; actions: CardActions }) {
    const arrange = arranging({
        get entry() {
            return props.cell.entry;
        },
        get label() {
            return props.cell.label;
        },
        get region() {
            return props.region;
        },
        get actions() {
            return props.actions;
        },
    });
    return (
        <div
            class="wb-card"
            classList={{ 'wb-card-menu-open': arrange.menu() }}
            data-entry={props.cell.entry}
            ref={arrange.ref}
        >
            <button
                type="button"
                class="wb-card-open"
                onPointerDown={arrange.press}
                onKeyDown={arrange.key}
                onClick={arrange.open}
            >
                <Picture url={props.cell.picture} class="wb-card-pic" />
                <span class="wb-card-words">
                    <span class="wb-card-name">
                        <Label named={props.cell.label} />
                    </span>
                    <span class="wb-card-text">{gistOf(props.cell)}</span>
                </span>
            </button>
            <arrange.Menu />
        </div>
    );
}

function DeletedCard() {
    const { t } = useUi();
    return (
        <div class="wb-card wb-card-deleted">
            <span class="wb-card-open">
                <span class="wb-card-pic" aria-hidden="true" />
                <span class="wb-card-words">
                    <span class="wb-card-name wb-opening">{t('A deleted entry')}</span>
                </span>
            </span>
        </div>
    );
}

export function Region(props: { cell: EntryCell; region: Membership; actions: CardActions }) {
    const { t } = useUi();
    const label = () => props.cell.label.text;
    const arrange = arranging({
        get entry() {
            return props.cell.entry;
        },
        get label() {
            return props.cell.label;
        },
        get region() {
            return props.region;
        },
        get actions() {
            return props.actions;
        },
    });
    return (
        <section
            class="wb-region"
            classList={{ 'wb-card-menu-open': arrange.menu() }}
            aria-label={fill(t('${0} and what is under it'), label())}
            data-entry={props.cell.entry}
            {...REGION_ATTRIBUTES(props.cell.entry, label(), props.actions.grouping()?.kind ?? null)}
            ref={arrange.ref}
        >
            <button
                type="button"
                class="wb-region-head"
                onPointerDown={arrange.press}
                onKeyDown={arrange.key}
                onClick={arrange.open}
            >
                <Picture url={props.cell.picture} class="wb-region-pic" />
                <span class="wb-card-words">
                    <span class="wb-region-name">
                        <Label named={props.cell.label} />
                    </span>
                    <span class="wb-region-text">{gistOf(props.cell)}</span>
                </span>
            </button>
            <div class="wb-region-corner">
                <arrange.Menu />
                <button
                    type="button"
                    class="right_menu_button interactable wb-region-search"
                    title={fill(t('Search in ${0}'), label())}
                    aria-label={fill(t('Search in ${0}'), label())}
                    onClick={() => props.actions.searchIn(props.cell.entry, label())}
                >
                    <Icon name="search" size={15} />
                </button>
            </div>
            <div class="wb-grid">
                <Cells
                    cells={props.cell.region}
                    region={{ entry: props.cell.entry, label: props.cell.label }}
                    actions={props.actions}
                />
            </div>
        </section>
    );
}

function DeletedRegion(props: { cell: PlaceOfDeletedEntryCell; actions: CardActions }) {
    return (
        <Show when={props.cell.region.length > 0} fallback={<DeletedCard />}>
            <section class="wb-region">
                <DeletedCard />
                <div class="wb-grid">
                    <Cells cells={props.cell.region} region={null} actions={props.actions} />
                </div>
            </section>
        </Show>
    );
}

export function Cell(props: { cell: RegionCell; region: Membership; actions: CardActions }) {
    return (
        <Switch>
            <Match when={props.cell.cell === 'entry' && props.cell}>
                {(cell) => (
                    <Show
                        when={(cell() as EntryCell).region.length > 0}
                        fallback={<Card cell={cell() as EntryCell} region={props.region} actions={props.actions} />}
                    >
                        <Region cell={cell() as EntryCell} region={props.region} actions={props.actions} />
                    </Show>
                )}
            </Match>
            <Match when={props.cell.cell === 'placeOfDeletedEntry' && props.cell}>
                {(cell) => <DeletedRegion cell={cell() as PlaceOfDeletedEntryCell} actions={props.actions} />}
            </Match>
            <Match when={props.cell.cell === 'notShownTile' && props.cell}>
                {(cell) => (
                    <MoreTile
                        count={
                            (cell() as Extract<RegionCell, { cell: 'notShownTile' }>)
                                .groupingKindRelationsTargetingRegionEntryNotShown
                        }
                        onOpen={() => {
                            if (props.region !== null) props.actions.open(props.region.entry);
                        }}
                    />
                )}
            </Match>
        </Switch>
    );
}

export function Cells(props: { cells: RegionCell[]; region: Membership; actions: CardActions }) {
    return <For each={props.cells}>{(cell) => <Cell cell={cell} region={props.region} actions={props.actions} />}</For>;
}

function MoreTile(props: { count: number; onOpen: () => void }) {
    const { t } = useUi();
    return (
        <button type="button" class="wb-more" onClick={() => props.onOpen()}>
            {fill(t('+${0} more'), count(props.count))}
        </button>
    );
}
