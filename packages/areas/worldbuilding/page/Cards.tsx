import { StatusDot, StatusControl } from './Status.tsx';
import { For, Match, Show, Switch, createSignal, onCleanup } from 'solid-js';
import type { Command } from '@st/page/commands';
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
import { OnOff } from './OnOff.tsx';
import { goesWords, triggerWords, triggersOf } from './facts.ts';
import { TriggerLine } from './Keys.tsx';
import { count, fill } from './words.ts';
import type { Picking } from './picking.ts';

export type CardActions = {
    open(entry: string): void;
    searchIn(entry: string, label: string): void;
    // The kind the cards are grouped by: what their menus and drags change. Null: grouped by nothing.
    grouping(): Grouping | null;
    // The world the cards are in.
    book(): string | null;
    // The list is drawn in the world's own order: a top-level card can be dragged to another place in it.
    worldOrder?(): boolean;
    // Pointing at a card shows its hover card.
    hover?: { enter(entry: string, element: HTMLElement): void; leave(event: MouseEvent): void; hide(): void };
    // The cards can be selected, as the world's rows are.
    pick?: Picking;
};

// Moving a card one place back or on among the cards of its region, which it can't be when they aren't grouped.
type Mover = { applies: () => boolean; move: (back: boolean) => void };

const movers = new WeakMap<Element, Mover>();
const focusedMover = () => (document.activeElement ? movers.get(document.activeElement) : undefined);

// Alt+arrows on a card's button, registered once for all cards: each button gives its own Mover.
export function cardMoveCommands(t: (text: string) => string): Command[] {
    const moving = (id: string, label: string, keys: string[], back: boolean): Command => ({
        id,
        label,
        category: t('Worldbuilding'),
        keys,
        when: () => focusedMover()?.applies() === true,
        run: () => focusedMover()?.move(back),
    });
    return [
        moving('worldbuilding.moveBack', t('Move card back'), ['alt+ArrowLeft', 'alt+ArrowUp'], true),
        moving('worldbuilding.moveOn', t('Move card forward'), ['alt+ArrowRight', 'alt+ArrowDown'], false),
    ];
}

// A card's menu, its drag and Alt+arrows, which move it among the cards of its region.
function arranging(props: { entry: string; label: Named; region: Membership; actions: CardActions }) {
    const wb = useWb();
    const [menu, setMenu] = createSignal(false);
    let root: HTMLElement | undefined;
    const press = (event: PointerEvent) => {
        const grouping = props.actions.grouping();
        const book = props.actions.book();
        const reorders = props.region === null && props.actions.worldOrder?.() === true ? book : null;
        if (!grouping && reorders === null) return;
        if (!root || (event.target as Element).closest('.wb-card-more, .wb-region-search')) return;
        wb.drag.press(event, {
            entry: props.entry,
            name: props.label.text,
            grouping,
            region: props.region,
            element: root,
            ...(reorders === null ? {} : { reorders }),
        });
    };
    const placed = () => {
        const grouping = props.actions.grouping();
        const grid = root?.parentElement?.closest('.wb-grid');
        return grouping && props.region && root && grid ? { grouping, region: props.region, grid, card: root } : null;
    };
    const reorder = (button: HTMLElement, back: boolean) => {
        const at = placed();
        if (!at) return;
        const { grouping, region, grid, card } = at;
        const cells = [...grid.querySelectorAll<HTMLElement>(':scope > [data-entry]')];
        const index = cells.findIndex((cell) => cell.contains(card));
        const entryAt = (to: number) => cells[to]?.dataset['entry'] ?? null;
        const slot = back
            ? { after: entryAt(index - 2), before: entryAt(index - 1) }
            : { after: entryAt(index + 1), before: entryAt(index + 2) };
        if ((back ? slot.before : slot.after) === null) return;
        void wb
            .act('worldbuilding.moveRelation', {
                book: grouping.book,
                entry: props.entry,
                kind: grouping.kind,
                target: region.entry,
                newTarget: region.entry,
                ...slot,
                loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
            })
            .then(() => {
                const moved = grid.querySelector<HTMLElement>(
                    `:scope > [data-entry="${props.entry}"] :is(.wb-card-open, .wb-region-head)`,
                );
                (moved ?? button).focus();
            });
    };
    const keyed = (button: HTMLElement) => {
        movers.set(button, { applies: () => placed() !== null, move: (back) => reorder(button, back) });
        onCleanup(() => movers.delete(button));
    };
    const open = (event: MouseEvent) => {
        if (wb.drag.clickIsDrop() || props.actions.pick?.click(props.entry, event) === true) return;
        props.actions.open(props.entry);
    };
    const enter = (event: MouseEvent) => {
        if (!menu()) props.actions.hover?.enter(props.entry, event.currentTarget as HTMLElement);
    };
    const leave = (event: MouseEvent) => props.actions.hover?.leave(event);
    const Menu = () => (
        <Show when={props.actions.book()}>
            {(book) => (
                <CardMenuButton
                    entry={props.entry}
                    label={props.label}
                    book={book()}
                    grouping={props.actions.grouping()}
                    region={props.region}
                    open={menu()}
                    onOpen={(open) => {
                        if (open) props.actions.hover?.hide();
                        setMenu(open);
                    }}
                />
            )}
        </Show>
    );
    return { menu, Menu, press, keyed, open, enter, leave, ref: (element: HTMLElement) => (root = element) };
}

// A card's checkbox, shown while it is pointed at or anything is selected.
function PickBox(props: { entry: string; label: Named; pick: Picking }) {
    const { t } = useUi();
    return (
        <input
            type="checkbox"
            class="wb-cb wb-card-cb"
            checked={props.pick.isSelected(props.entry)}
            aria-label={fill(t('Select ${0}'), props.label.text)}
            onPointerDown={(event) => props.pick.press(props.entry, event)}
            onClick={(event) => event.preventDefault()}
        />
    );
}

const picked = (actions: CardActions, entry: string) => actions.pick?.isSelected(entry) === true;

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
            classList={{
                'wb-card-menu-open': arrange.menu(),
                'wb-card-off': props.cell.facts?.comesIn === 'never',
                'wb-sel': picked(props.actions, props.cell.entry),
                'wb-picking': props.actions.pick?.showing() === true,
            }}
            data-entry={props.cell.entry}
            data-pick={props.actions.pick ? props.cell.entry : undefined}
            ref={arrange.ref}
            onMouseEnter={arrange.enter}
            onMouseLeave={arrange.leave}
            onPointerEnter={() => props.actions.pick?.enter(props.cell.entry)}
        >
            <button
                type="button"
                class="wb-card-open"
                onPointerDown={arrange.press}
                ref={arrange.keyed}
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
            <Facts cell={props.cell} actions={props.actions} />
            <arrange.Menu />
            <Show when={props.actions.pick}>
                {(pick) => <PickBox entry={props.cell.entry} label={props.cell.label} pick={pick()} />}
            </Show>
        </div>
    );
}

// How the entry comes into the prompt, at a glance: on or off, what brings it up, and where it goes.
function Facts(props: { cell: EntryCell; actions: CardActions }) {
    const { t } = useUi();
    return (
        <Show when={props.cell.facts}>
            {(facts) => (
                <div class="wb-card-facts">
                    <Show when={props.actions.book()} fallback={<StatusDot status={facts().comesIn} />}>
                        {(book) => (
                            <>
                                <OnOff
                                    book={book()}
                                    entry={props.cell.entry}
                                    name={props.cell.label.text}
                                    facts={facts()}
                                />
                                <StatusControl
                                    book={book()}
                                    entry={props.cell.entry}
                                    name={props.cell.label.text}
                                    facts={facts()}
                                />
                            </>
                        )}
                    </Show>
                    <span
                        class="wb-card-triggers"
                        title={triggerWords(triggersOf(props.cell.keys, props.cell.names), facts(), t)}
                    >
                        <TriggerLine
                            book={props.actions.book() ?? ''}
                            entry={props.cell.entry}
                            keys={props.cell.keys}
                            names={props.cell.names}
                            facts={facts()}
                            constantInstead
                        />
                    </span>
                    <span class="wb-card-goes">{goesWords(facts(), t)}</span>
                </div>
            )}
        </Show>
    );
}

function DeletedCard() {
    const { t } = useUi();
    return (
        <div class="wb-card wb-card-deleted">
            <span class="wb-card-open">
                <span class="wb-card-pic" aria-hidden="true" />
                <span class="wb-card-words">
                    <span class="wb-card-name wb-opening">{t('Deleted entry')}</span>
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
            classList={{
                'wb-card-menu-open': arrange.menu(),
                'wb-card-off': props.cell.facts?.comesIn === 'never',
                'wb-sel': picked(props.actions, props.cell.entry),
                'wb-picking': props.actions.pick?.showing() === true,
            }}
            aria-label={fill(t('${0} and its contents'), label())}
            data-entry={props.cell.entry}
            data-pick={props.actions.pick ? props.cell.entry : undefined}
            {...REGION_ATTRIBUTES(props.cell.entry, label(), props.actions.grouping()?.kind ?? null)}
            ref={arrange.ref}
        >
            <div
                class="wb-region-top"
                onMouseEnter={arrange.enter}
                onMouseLeave={arrange.leave}
                onPointerEnter={() => props.actions.pick?.enter(props.cell.entry)}
            >
                <Show when={props.actions.pick}>
                    {(pick) => <PickBox entry={props.cell.entry} label={props.cell.label} pick={pick()} />}
                </Show>
                <button
                    type="button"
                    class="wb-region-head"
                    onPointerDown={arrange.press}
                    ref={arrange.keyed}
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
                <Facts cell={props.cell} actions={props.actions} />
            </div>
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
