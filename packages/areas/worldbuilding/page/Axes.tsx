import { For, Show, createSignal } from 'solid-js';
import { useUi } from '@st/page/context';
import { LOOP_CHECK_VISITS_PER_WRITE } from '../protocol.ts';
import type { AxesView, AxisCell, AxisHeader, AxisItem, CellCard, RelationKind } from '../protocol.ts';
import { useWb } from './context.ts';
import { dismissOn } from './dismiss.ts';
import type { CellAt, CellsDrag } from './Drag.tsx';
import type { CardActions } from './Cards.tsx';
import { Label, Picture } from './Label.tsx';
import { OnOff } from './OnOff.tsx';
import { goesWords, triggerWords } from './facts.ts';
import { TargetPicker } from './Picker.tsx';
import { count, fill } from './words.ts';

type Shown = Extract<AxesView, { book: string }>;

const sameCell = (one: CellAt, other: CellAt) => one.column === other.column && one.row === other.row;

const shownCount = (header: { count: number; capped: boolean }) => `${count(header.count)}${header.capped ? '+' : ''}`;

export function ItemValue(props: { header: AxisHeader }) {
    const { t } = useUi();
    return (
        <Show
            when={typeof props.header.item.is === 'object'}
            fallback={<b class="wb-ax-word">{props.header.item.is === 'any' ? t('any') : t('none')}</b>}
        >
            <Show when={props.header.target} fallback={<span class="wb-dim">{t('Deleted entry')}</span>}>
                {(target) => <Label named={target()} />}
            </Show>
        </Show>
    );
}

function Kind(props: { header: AxisHeader }) {
    return <span class="wb-ax-kind">{props.header.kindName ?? ''}:</span>;
}

const anyDepth = (item: AxisItem) => typeof item.is === 'object' && item.is.depth === 'anyDepth';

// An entry with members is drawn as its region, headed by its own card when it is in the cell and by a small head when
// it is drawn only for where its members are.
// What every card of the cells shares: the world, the drag that moves them between cells, and their hover card.
type CardsAt = { book: string; drag: CellsDrag | null; hover: CardActions['hover'] };

function CellCards(props: { cards: CellCard[]; cell: AxisCell; at: CardsAt }) {
    return <For each={props.cards}>{(card) => <CellEntry card={card} cell={props.cell} at={props.at} />}</For>;
}

function SmallCard(props: { card: CellCard; cell: AxisCell; at: CardsAt }) {
    const { t } = useUi();
    const wb = useWb();
    let root: HTMLDivElement | undefined;
    const gist = () =>
        props.card.label.shownAs === 'opening'
            ? ''
            : (props.card.text.split(/\n/u).find((line) => line.trim() !== '') ?? '');
    return (
        <div
            class="wb-ec"
            classList={{ 'wb-card-off': props.card.facts?.comesIn === 'never' }}
            data-entry={props.card.entry}
            ref={(element) => (root = element)}
            onMouseEnter={(event) => props.at.hover?.enter(props.card.entry, event.currentTarget)}
            onMouseLeave={(event) => props.at.hover?.leave(event)}
        >
            <button
                type="button"
                class="wb-ec-open"
                onPointerDown={(event) => {
                    if (props.at.drag === null || !root) return;
                    wb.drag.press(event, {
                        entry: props.card.entry,
                        name: props.card.label.text,
                        grouping: null,
                        region: null,
                        element: root,
                        cells: { ...props.at.drag, from: { column: props.cell.column, row: props.cell.row } },
                    });
                }}
                onClick={() => {
                    if (!wb.drag.clickIsDrop()) wb.open(props.card.entry);
                }}
            >
                <Picture url={props.card.picture} class="wb-ec-pic" />
                <span class="wb-ec-words">
                    <span class="wb-ec-name">
                        <Label named={props.card.label} />
                    </span>
                    <span class="wb-ec-text">{gist()}</span>
                </span>
            </button>
            <Show when={props.card.facts}>
                {(facts) => (
                    <div class="wb-card-facts">
                        <OnOff
                            book={props.at.book}
                            entry={props.card.entry}
                            name={props.card.label.text}
                            facts={facts()}
                        />
                        <span class="wb-card-triggers" title={triggerWords(props.card.keys, facts(), t)}>
                            {triggerWords(props.card.keys, facts(), t)}
                        </span>
                        <span class="wb-card-goes">{goesWords(facts(), t)}</span>
                    </div>
                )}
            </Show>
        </div>
    );
}

function CellEntry(props: { card: CellCard; cell: AxisCell; at: CardsAt }) {
    const wb = useWb();
    return (
        <Show
            when={props.card.region.length > 0}
            fallback={<SmallCard card={props.card} cell={props.cell} at={props.at} />}
        >
            <div class="wb-rg" data-entry={props.card.entry}>
                <Show
                    when={props.card.inCell}
                    fallback={
                        <button type="button" class="wb-rgh" onClick={() => wb.open(props.card.entry)}>
                            <Picture url={props.card.picture} class="wb-rgh-pic" />
                            <span class="wb-ec-name">
                                <Label named={props.card.label} />
                            </span>
                        </button>
                    }
                >
                    <SmallCard card={props.card} cell={props.cell} at={props.at} />
                </Show>
                <CellCards cards={props.card.region} cell={props.cell} at={props.at} />
            </div>
        </Show>
    );
}

function CellBody(props: { cell: AxisCell; drag: CellsDrag | null; book: string; hover: CardActions['hover'] }) {
    const { t } = useUi();
    const wb = useWb();
    const drawn = () => {
        let hits = 0;
        const walk = (cards: CellCard[]) => {
            for (const card of cards) {
                if (card.inCell) hits++;
                walk(card.region);
            }
        };
        walk(props.cell.entries);
        return hits;
    };
    return (
        <>
            <div class="wb-grid wb-cell-cards">
                <CellCards
                    cards={props.cell.entries}
                    cell={props.cell}
                    at={{ book: props.book, drag: props.drag, hover: props.hover }}
                />
            </div>
            <Show when={props.cell.more}>
                <button
                    type="button"
                    class="wb-more wb-cell-more"
                    onClick={() =>
                        void wb.act('worldbuilding.showMoreInCell', {
                            book: props.book,
                            column: props.cell.column,
                            row: props.cell.row,
                        })
                    }
                >
                    {fill(
                        t('+${0} more'),
                        `${count(Math.max(0, props.cell.count - drawn()))}${props.cell.capped ? '+' : ''}`,
                    )}
                </button>
            </Show>
        </>
    );
}

const cellAttributes = (cell: AxisCell) => ({ 'data-cell': `${cell.column ?? ''}:${cell.row ?? ''}` });

export function Axes(props: { axes: Shown; onChange: AxesChange; hover: CardActions['hover'] }) {
    const { t } = useUi();
    const wb = useWb();
    const columns = () => props.axes.columns;
    const rows = () => props.axes.rows;
    const headerOf = (axis: AxisHeader[], at: number | null) => (at === null ? null : (axis[at] ?? null));
    const toggle = (axis: 'columns' | 'rows', at: number) => () => {
        props.onChange({
            [axis]: props.axes[axis].map((header, i) => (i === at ? withDepthToggled(header.item) : header.item)),
        });
    };
    const drops = () => [...columns(), ...rows()].some((header) => header.drops);
    const crossing = (from: CellAt, to: CellAt) => {
        const crossed = [
            { axis: columns(), from: from.column, to: to.column },
            { axis: rows(), from: from.row, to: to.row },
        ].filter((one) => one.from !== one.to);
        if (crossed.length === 0) return null;
        const said = [];
        for (const one of crossed) {
            const was = headerOf(one.axis, one.from);
            const now = headerOf(one.axis, one.to);
            if (now?.drops !== true || !was) return null;
            const before = was.drops ? (was.target?.text ?? null) : null;
            said.push({ kind: now.kindName ?? '', from: before, to: now.target?.text ?? '', keeps: before !== null });
        }
        return said;
    };
    const drag: CellsDrag = {
        label(from, to, alt) {
            const said = crossing(from, to);
            if (!said) return null;
            return {
                kind: said.map((one) => one.kind).join(' · '),
                change: said
                    .map((one) =>
                        alt
                            ? fill(t('Add to ${0}'), one.to)
                            : one.from === null
                              ? `→ ${one.to}`
                              : `${one.from} → ${one.to}`,
                    )
                    .join(' · '),
                keepBoth: !alt && said.some((one) => one.keeps),
            };
        },
        drop(entry, from, to, keepBoth, slot) {
            if (sameCell(from, to) && slot.after === null && slot.before === null) return;
            void wb.act('worldbuilding.moveBetweenCells', {
                book: props.axes.book,
                entry,
                from,
                to,
                keepBoth,
                ...slot,
                loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
            });
        },
        from: { column: null, row: null },
    };
    const cellAt = (column: number | null, row: number | null) =>
        props.axes.cells.find((cell) => cell.column === column && cell.row === row);
    return (
        <Show
            when={rows().length > 0}
            fallback={
                <div
                    class="wb-board"
                    style={{ 'grid-template-columns': `repeat(${columns().length}, minmax(0, 1fr))` }}
                >
                    <For each={columns()}>
                        {(header, at) => (
                            <Show when={cellAt(at(), null)}>
                                {(cell) => (
                                    <section class="wb-bcol" {...cellAttributes(cell())}>
                                        <div class="wb-bh">
                                            <span class="wb-bhn">
                                                <Kind header={header} /> <ItemValue header={header} />
                                                <Show when={anyDepth(header.item)}>
                                                    {' '}
                                                    <DepthPill onToggle={toggle('columns', at())} />
                                                </Show>
                                            </span>
                                            <span class="wb-bct">{shownCount(cell())}</span>
                                        </div>
                                        <CellBody
                                            cell={cell()}
                                            drag={drops() ? drag : null}
                                            book={props.axes.book}
                                            hover={props.hover}
                                        />
                                    </section>
                                )}
                            </Show>
                        )}
                    </For>
                </div>
            }
        >
            <div
                class="wb-grid2"
                style={{
                    'grid-template-columns': `230px repeat(${Math.max(1, columns().length)}, minmax(0, 1fr))`,
                }}
            >
                <Show when={columns().length > 0}>
                    <div />
                    <For each={columns()}>
                        {(header, at) => (
                            <div class="wb-gch">
                                <Kind header={header} /> <ItemValue header={header} />
                                <Show when={anyDepth(header.item)}>
                                    <DepthPill onToggle={toggle('columns', at())} />
                                </Show>
                                <span class="wb-bct">{shownCount(header)}</span>
                            </div>
                        )}
                    </For>
                </Show>
                <For each={rows()}>
                    {(header, row) => (
                        <>
                            <div class="wb-grh">
                                <Kind header={header} /> <ItemValue header={header} />
                                <Show when={anyDepth(header.item)}>
                                    <DepthPill onToggle={toggle('rows', row())} />
                                </Show>
                                <span class="wb-bct">{shownCount(header)}</span>
                            </div>
                            <For each={columns().length > 0 ? columns().map((_, at) => at) : [null]}>
                                {(column) => (
                                    <Show when={cellAt(column, row())}>
                                        {(cell) => (
                                            <div class="wb-gcell" {...cellAttributes(cell())}>
                                                <CellBody
                                                    cell={cell()}
                                                    drag={drops() ? drag : null}
                                                    book={props.axes.book}
                                                    hover={props.hover}
                                                />
                                            </div>
                                        )}
                                    </Show>
                                )}
                            </For>
                        </>
                    )}
                </For>
            </div>
        </Show>
    );
}

export type AxesChange = (change: { columns?: AxisItem[]; rows?: AxisItem[] }) => void;

function DepthPill(props: { onToggle: () => void }) {
    const { t } = useUi();
    return (
        <button
            type="button"
            class="tag wb-dep"
            title={t('Click to include only direct members')}
            onClick={() => props.onToggle()}
        >
            {t('any depth')}
        </button>
    );
}

const withDepthToggled = (item: AxisItem): AxisItem =>
    typeof item.is === 'object'
        ? { ...item, is: { ...item.is, depth: item.is.depth === 'directly' ? 'anyDepth' : 'directly' } }
        : item;

export function AxisControl(props: {
    label: string;
    axis: 'columns' | 'rows';
    items: AxisItem[];
    headers: AxisHeader[] | null;
    kinds: RelationKind[];
    book: string;
    onChange: AxesChange;
}) {
    const { t } = useUi();
    const [adding, setAdding] = createSignal(false);
    let plus: HTMLButtonElement | undefined;
    const kindName = (kind: string) => props.kinds.find((one) => one.id === kind)?.name ?? '';
    const chipWords = (item: AxisItem, at: number) => {
        if (typeof item.is !== 'object') return `${kindName(item.kind)}: ${item.is === 'any' ? t('any') : t('none')}`;
        const target = props.headers?.[at]?.target?.text ?? '…';
        return `${kindName(item.kind)}: ${target}${item.is.depth === 'anyDepth' ? ` · ${t('any depth')}` : ''}`;
    };
    const set = (items: AxisItem[]) => {
        props.onChange({ [props.axis]: items });
    };
    return (
        <span class="wb-ax-ctl">
            <span>{props.label}</span>
            <For each={props.items}>
                {(item, at) => (
                    <span class="tag wb-pill">
                        <button
                            type="button"
                            class="wb-pill-words"
                            title={
                                typeof item.is === 'object'
                                    ? t('Click to switch between direct members and any depth')
                                    : undefined
                            }
                            disabled={typeof item.is !== 'object'}
                            onClick={() => set(props.items.map((one, i) => (i === at() ? withDepthToggled(one) : one)))}
                        >
                            {chipWords(item, at())}
                        </button>
                        <button
                            type="button"
                            class="wb-pill-x"
                            aria-label={fill(t('Remove ${0}'), chipWords(item, at()))}
                            onClick={() => set(props.items.filter((_, i) => i !== at()))}
                        >
                            ×
                        </button>
                    </span>
                )}
            </For>
            <span class="wb-ax-add">
                <button
                    type="button"
                    class="menu_button margin0 whitespacenowrap wb-padd"
                    ref={(element) => (plus = element)}
                    aria-label={fill(t('Add to ${0}'), props.label)}
                    aria-expanded={adding()}
                    onClick={() => setAdding(!adding())}
                >
                    +
                </button>
                <Show when={adding()}>
                    <AddItem
                        kinds={props.kinds}
                        book={props.book}
                        opener={() => plus}
                        onClose={() => setAdding(false)}
                        onAdd={(item) => {
                            setAdding(false);
                            set([...props.items, item]);
                        }}
                    />
                </Show>
            </span>
        </span>
    );
}

function AddItem(props: {
    kinds: RelationKind[];
    book: string;
    opener: () => HTMLElement | undefined;
    onClose: () => void;
    onAdd: (item: AxisItem) => void;
}) {
    const { t } = useUi();
    const [kind, setKind] = createSignal<RelationKind | null>(null);
    let menu: HTMLDivElement | undefined;
    dismissOn(() => menu, props.onClose, props.opener);
    return (
        <div class="wb-menu list-group wb-ax-menu" role="menu" ref={(element) => (menu = element)}>
            <Show
                when={kind()}
                fallback={
                    <Show
                        when={props.kinds.length > 0}
                        fallback={<p class="wb-quiet wb-ax-none">{t('No relations yet.')}</p>}
                    >
                        <For each={props.kinds}>
                            {(one) => (
                                <button
                                    class="list-group-item"
                                    type="button"
                                    role="menuitem"
                                    onClick={() => setKind(one)}
                                >
                                    {one.name}…
                                </button>
                            )}
                        </For>
                    </Show>
                }
            >
                {(chosen) => (
                    <>
                        <button
                            class="list-group-item"
                            type="button"
                            role="menuitem"
                            onClick={() => props.onAdd({ kind: chosen().id, is: 'any' })}
                        >
                            {chosen().name}: {t('any')}
                        </button>
                        <button
                            class="list-group-item"
                            type="button"
                            role="menuitem"
                            onClick={() => props.onAdd({ kind: chosen().id, is: 'none' })}
                        >
                            {chosen().name}: {t('none')}
                        </button>
                        <hr />
                        <TargetPicker
                            heading={fill(t('${0}: choose entry'), chosen().name)}
                            book={props.book}
                            kind={null}
                            leaveOut={[]}
                            class="wb-ax-pick"
                            onPick={(target) => props.onAdd({ kind: chosen().id, is: { target, depth: 'directly' } })}
                        />
                    </>
                )}
            </Show>
        </div>
    );
}
