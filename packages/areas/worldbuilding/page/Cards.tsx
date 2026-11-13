import { For, Match, Show, Switch } from 'solid-js';
import { useUi } from '@st/page/context';
import { Name } from '@st/page/name';
import type { EntryCell, Named, PlaceOfDeletedEntryCell, RegionCell } from '../protocol.ts';
import { Icon } from './icons.tsx';
import { count, fill } from './words.ts';

export type CardActions = {
    open(entry: string): void;
    searchIn(entry: string, label: string): void;
};

export function Label(props: { named: Named }) {
    return (
        <Switch>
            <Match when={props.named.shownAs === 'name'}>
                <Name named={props.named} />
            </Match>
            <Match when={props.named.shownAs === 'title'}>
                <span>{props.named.text}</span>
            </Match>
            <Match when={props.named.shownAs === 'opening'}>
                <span class="wb-opening">{props.named.text}</span>
            </Match>
        </Switch>
    );
}

export function Picture(props: { url: string | null; class: string }) {
    return (
        <span
            class={props.class}
            style={props.url === null ? undefined : { 'background-image': `url(${JSON.stringify(props.url)})` }}
            aria-hidden="true"
        />
    );
}

// What a card says under the name: the text's first paragraph, or nothing when the name already is the opening.
export const gistOf = (cell: Pick<EntryCell, 'label' | 'text'>): string =>
    cell.label.shownAs === 'opening' ? '' : (cell.text.split(/\n/u).find((line) => line.trim() !== '') ?? '');

export function Card(props: { cell: EntryCell; actions: CardActions }) {
    return (
        <div class="wb-card">
            <button type="button" class="wb-card-open" onClick={() => props.actions.open(props.cell.entry)}>
                <Picture url={props.cell.picture} class="wb-card-pic" />
                <span class="wb-card-words">
                    <span class="wb-card-name">
                        <Label named={props.cell.label} />
                    </span>
                    <span class="wb-card-text">{gistOf(props.cell)}</span>
                </span>
            </button>
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

export function Region(props: { cell: EntryCell; actions: CardActions }) {
    const { t } = useUi();
    const label = () => props.cell.label.text;
    return (
        <section class="wb-region" aria-label={fill(t('${0} and what is under it'), label())}>
            <button type="button" class="wb-region-head" onClick={() => props.actions.open(props.cell.entry)}>
                <Picture url={props.cell.picture} class="wb-region-pic" />
                <span class="wb-card-words">
                    <span class="wb-region-name">
                        <Label named={props.cell.label} />
                    </span>
                    <span class="wb-region-text">{gistOf(props.cell)}</span>
                </span>
            </button>
            <button
                type="button"
                class="wb-region-search"
                title={fill(t('Search in ${0}'), label())}
                aria-label={fill(t('Search in ${0}'), label())}
                onClick={() => props.actions.searchIn(props.cell.entry, label())}
            >
                <Icon name="search" size={15} />
            </button>
            <div class="wb-grid">
                <Cells cells={props.cell.region} regionEntry={props.cell.entry} actions={props.actions} />
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
                    <Cells cells={props.cell.region} regionEntry={null} actions={props.actions} />
                </div>
            </section>
        </Show>
    );
}

export function Cell(props: { cell: RegionCell; regionEntry: string | null; actions: CardActions }) {
    return (
        <Switch>
            <Match when={props.cell.cell === 'entry' && props.cell}>
                {(cell) => (
                    <Show
                        when={(cell() as EntryCell).region.length > 0}
                        fallback={<Card cell={cell() as EntryCell} actions={props.actions} />}
                    >
                        <Region cell={cell() as EntryCell} actions={props.actions} />
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
                        onOpen={() => props.regionEntry !== null && props.actions.open(props.regionEntry)}
                    />
                )}
            </Match>
        </Switch>
    );
}

export function Cells(props: { cells: RegionCell[]; regionEntry: string | null; actions: CardActions }) {
    return (
        <For each={props.cells}>
            {(cell) => <Cell cell={cell} regionEntry={props.regionEntry} actions={props.actions} />}
        </For>
    );
}

function MoreTile(props: { count: number; onOpen: () => void }) {
    const { t } = useUi();
    return (
        <button type="button" class="wb-more" onClick={() => props.onOpen()}>
            {fill(t('+${0} more'), count(props.count))}
        </button>
    );
}
