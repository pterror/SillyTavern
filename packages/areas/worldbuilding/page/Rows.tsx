import { For, Match, Show, Switch, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { useUi } from '@st/page/context';
import { ask } from '@st/page/dialog';
import { LOOP_CHECK_VISITS_PER_WRITE, SELECTION_COUNTED_UP_TO } from '../protocol.ts';
import type {
    BulkAction,
    Deleted,
    EntryCell,
    Placement,
    RegionCell,
    RelationKind,
    EntryFacts,
    RowField,
    SelectionView,
} from '../protocol.ts';
import { Label, Picture } from './Label.tsx';
import { useWb } from './context.ts';
import type { Wb } from './context.ts';
import { dismissOn } from './dismiss.ts';
import { WorldChoice } from './WorldChoice.tsx';
import { TargetPicker } from './Picker.tsx';
import { WHERES } from './Placement.tsx';
import { FIELD_WORDS } from './Views.tsx';
import { OnOff } from './OnOff.tsx';
import { goesWords, triggersOf } from './facts.ts';
import { KeyChips } from './KeyChips.tsx';
import { TriggerLine } from './Keys.tsx';
import { count, fill } from './words.ts';
import type { Picking } from './picking.ts';

export const ROW_HEIGHT = 40;

const WIDTHS: Record<RowField, string> = {
    relations: '190px',
    names: '190px',
    triggers: 'minmax(180px,1fr)',
    comesIn: '130px',
    goes: '230px',
    order: '60px',
    chance: '64px',
    tokens: '64px',
};

const NUMERIC = new Set<RowField>(['order', 'chance', 'tokens']);

const COMES: { comes: EntryFacts['comesIn']; words: string; change: Partial<Placement> }[] = [
    { comes: 'broughtUp', words: 'Normal', change: { constant: false, disable: false } },
    { comes: 'always', words: 'Constant', change: { constant: true, disable: false } },
    { comes: 'never', words: 'Disabled', change: { constant: false, disable: true } },
];

export const columnsOf = (fields: RowField[]): string =>
    ['58px', '36px', '230px', ...fields.map((field) => WIDTHS[field])].join(' ');

type Selected = Extract<SelectionView, { book: string }>;

export type RowsContext = {
    book: string;
    fields: RowField[];
    selection: Selected | null;
    pick: Picking;
    // The world whose own order the rows are drawn in: each top-level row has a grip that moves it there.
    reorders: string | null;
    open: (entry: string) => void;
};

export function RowsHead(props: { fields: RowField[]; selection: Selected | null; book: string }) {
    const { t } = useUi();
    const wb = useWb();
    const all = () => props.selection?.base === 'matching';
    return (
        <div class="wb-tr wb-th" style={{ 'grid-template-columns': columnsOf(props.fields) }}>
            <span class="wb-tr-pick">
                <input
                    type="checkbox"
                    class="wb-cb"
                    checked={all()}
                    aria-label={t('Select all matching')}
                    onClick={(event) => {
                        // The server's selection decides whether it is checked.
                        event.preventDefault();
                        void wb.act(all() ? 'worldbuilding.selectNone' : 'worldbuilding.selectAllMatching', {
                            book: props.book,
                        });
                    }}
                />
            </span>
            <span class="wb-th-on">{t('On')}</span>
            <span>{t('Name')}</span>
            <For each={props.fields}>
                {(field) => <span classList={{ 'wb-num': NUMERIC.has(field) }}>{t(FIELD_WORDS[field])}</span>}
            </For>
        </div>
    );
}

export function EntryRows(props: { cell: RegionCell; depth: number; context: RowsContext }) {
    const { t } = useUi();
    return (
        <Switch>
            <Match when={props.cell.cell === 'entry' && props.cell}>
                {(cell) => (
                    <>
                        <Row cell={cell() as EntryCell} depth={props.depth} context={props.context} />
                        <For each={(cell() as EntryCell).region}>
                            {(inner) => <EntryRows cell={inner} depth={props.depth + 1} context={props.context} />}
                        </For>
                    </>
                )}
            </Match>
            <Match when={props.cell.cell === 'notShownTile' && props.cell}>
                {(cell) => (
                    <div class="wb-tr wb-tr-more" style={{ 'padding-left': `${16 + props.depth * 20}px` }}>
                        <span />
                        <span class="wb-dim">
                            {fill(
                                t('+${0} more'),
                                count(
                                    (cell() as Extract<RegionCell, { cell: 'notShownTile' }>)
                                        .groupingKindRelationsTargetingRegionEntryNotShown,
                                ),
                            )}
                        </span>
                    </div>
                )}
            </Match>
        </Switch>
    );
}

function Row(props: { cell: EntryCell; depth: number; context: RowsContext }) {
    const { t } = useUi();
    const wb = useWb();
    const selected = () => props.context.pick.isSelected(props.cell.entry);
    const facts = () => props.cell.facts;
    const relations = () =>
        props.cell.relations
            .filter((relation) => relation.inUse && relation.target !== null)
            .map((relation) => `${relation.kindName ?? ''}: ${relation.target?.text ?? ''}`)
            .join(', ');
    const cellOf = (field: RowField): JSX.Element => {
        const shown = facts();
        switch (field) {
            case 'relations':
                return <span title={relations()}>{relations() === '' ? '—' : relations()}</span>;
            case 'names':
                return (
                    <span class="wb-row-keys" title={props.cell.names.join(', ')}>
                        <KeyChips
                            book={props.context.book}
                            entry={props.cell.entry}
                            version={shown?.version ?? null}
                            kind="name"
                            chips={props.cell.names.map((text) => ({ text }))}
                            compact
                        />
                    </span>
                );
            case 'triggers':
                return (
                    <span class="wb-row-keys" title={triggersOf(props.cell.keys, props.cell.names).join(', ')}>
                        <TriggerLine
                            book={props.context.book}
                            entry={props.cell.entry}
                            keys={props.cell.keys}
                            names={props.cell.names}
                            facts={shown}
                        />
                    </span>
                );
            case 'comesIn':
                return shown ? (
                    <ComesCell book={props.context.book} entry={props.cell.entry} facts={shown} />
                ) : (
                    <span />
                );
            case 'goes':
                return shown ? <GoesCell book={props.context.book} entry={props.cell.entry} facts={shown} /> : <span />;
            case 'order':
                return shown ? (
                    <NumberCell
                        book={props.context.book}
                        entry={props.cell.entry}
                        version={shown.version}
                        value={shown.order}
                        label={t('Order')}
                        set={(order) => ({ order })}
                    />
                ) : (
                    <span />
                );
            case 'chance':
                return shown ? (
                    <NumberCell
                        book={props.context.book}
                        entry={props.cell.entry}
                        version={shown.version}
                        value={shown.chance}
                        label={t('Probability')}
                        suffix="%"
                        set={(chance) => ({ probability: Math.max(0, Math.min(100, chance)), useProbability: true })}
                    />
                ) : (
                    <span />
                );
            case 'tokens':
                return <span class="wb-num">{shown?.tokens === null || !shown ? '' : count(shown.tokens)}</span>;
        }
    };
    return (
        <div
            class="wb-tr"
            classList={{ 'wb-tr-sel': selected(), 'wb-tr-off': facts()?.comesIn === 'never' }}
            data-entry={props.cell.entry}
            data-pick={props.cell.entry}
            style={{ 'grid-template-columns': columnsOf(props.context.fields) }}
            onPointerEnter={() => props.context.pick.enter(props.cell.entry)}
        >
            <span class="wb-tr-pick">
                <Show when={props.depth === 0 && props.context.reorders}>
                    {(book) => (
                        <button
                            type="button"
                            class="wb-grip fa-solid fa-grip-vertical"
                            title={t('Drag to reorder')}
                            aria-label={fill(t('Reorder ${0}'), props.cell.label.text)}
                            onPointerDown={(event) => {
                                const row = (event.target as Element).closest<HTMLElement>('.wb-top-row');
                                event.preventDefault();
                                if (row)
                                    wb.drag.press(event, {
                                        entry: props.cell.entry,
                                        name: props.cell.label.text,
                                        grouping: null,
                                        region: null,
                                        element: row,
                                        reorders: book(),
                                    });
                            }}
                        />
                    )}
                </Show>
                <input
                    type="checkbox"
                    class="wb-cb"
                    checked={selected()}
                    aria-label={fill(t('Select ${0}'), props.cell.label.text)}
                    onPointerDown={(event) => props.context.pick.press(props.cell.entry, event)}
                    onClick={(event) => event.preventDefault()}
                />
            </span>
            <span>
                <Show when={facts()}>
                    {(shown) => (
                        <OnOff
                            book={props.context.book}
                            entry={props.cell.entry}
                            name={props.cell.label.text}
                            facts={shown()}
                        />
                    )}
                </Show>
            </span>
            <button
                type="button"
                class="wb-nmc"
                style={{ 'padding-left': `${props.depth * 20}px` }}
                onClick={(event) => {
                    if (!props.context.pick.click(props.cell.entry, event)) props.context.open(props.cell.entry);
                }}
            >
                <Picture url={props.cell.picture} class="wb-pk" />
                <Label named={props.cell.label} />
            </button>
            <For each={props.context.fields}>{(field) => cellOf(field)}</For>
        </div>
    );
}

function setPlacement(wb: Wb, book: string, entry: string, version: string, fields: Partial<Placement>) {
    void wb.edit('worldbuilding.setPlacement', { book, entry, version, fields });
}

function ComesCell(props: { book: string; entry: string; facts: EntryFacts }) {
    const { t } = useUi();
    const wb = useWb();
    const [editing, setEditing] = createSignal(false);
    const words = () => t(COMES.find((one) => one.comes === props.facts.comesIn)?.words ?? '');
    return (
        <span>
            <Show
                when={editing()}
                fallback={
                    <button type="button" class="wb-cell" onClick={() => setEditing(true)}>
                        {words()}
                    </button>
                }
            >
                <select
                    class="wb-cell-edit text_pole margin0"
                    aria-label={t('Status')}
                    value={props.facts.comesIn}
                    ref={(element) => queueMicrotask(() => element.focus())}
                    onBlur={() => setEditing(false)}
                    onChange={(event) => {
                        setEditing(false);
                        const chosen = COMES.find((one) => one.comes === event.currentTarget.value);
                        if (chosen) setPlacement(wb, props.book, props.entry, props.facts.version, chosen.change);
                    }}
                >
                    <For each={COMES}>{(one) => <option value={one.comes}>{t(one.words)}</option>}</For>
                </select>
            </Show>
        </span>
    );
}

function GoesCell(props: { book: string; entry: string; facts: EntryFacts }) {
    const { t } = useUi();
    const wb = useWb();
    const [editing, setEditing] = createSignal(false);
    return (
        <span>
            <Show
                when={editing()}
                fallback={
                    <button type="button" class="wb-cell" onClick={() => setEditing(true)}>
                        {goesWords(props.facts, t)}
                    </button>
                }
            >
                <select
                    class="wb-cell-edit text_pole margin0"
                    aria-label={t('Position')}
                    value={props.facts.position}
                    ref={(element) => queueMicrotask(() => element.focus())}
                    onBlur={() => setEditing(false)}
                    onChange={(event) => {
                        setEditing(false);
                        setPlacement(wb, props.book, props.entry, props.facts.version, {
                            position: Number(event.currentTarget.value) as Placement['position'],
                        });
                    }}
                >
                    <For each={WHERES}>{(where) => <option value={where.position}>{t(where.words)}</option>}</For>
                </select>
            </Show>
        </span>
    );
}

function NumberCell(props: {
    book: string;
    entry: string;
    version: string;
    value: number | null;
    label: string;
    suffix?: string;
    set: (value: number) => Partial<Placement>;
}) {
    const { focusActions } = useUi();
    const wb = useWb();
    const [editing, setEditing] = createSignal(false);
    return (
        <span class="wb-num">
            <Show
                when={editing()}
                fallback={
                    <button type="button" class="wb-cell wb-num" onClick={() => setEditing(true)}>
                        {props.value === null ? '' : `${props.value}${props.suffix ?? ''}`}
                    </button>
                }
            >
                <input
                    class="wb-cell-edit wb-num text_pole margin0"
                    type="number"
                    aria-label={props.label}
                    value={props.value ?? ''}
                    ref={(element) => {
                        queueMicrotask(() => element.select());
                        onCleanup(
                            focusActions.attach(element, {
                                cancel: () => void setEditing(false),
                                confirm: () => {
                                    const value = Number(element.value);
                                    setEditing(false);
                                    if (Number.isFinite(value) && element.value.trim() !== '')
                                        setPlacement(wb, props.book, props.entry, props.version, props.set(value));
                                },
                            }),
                        );
                    }}
                    onBlur={() => setEditing(false)}
                />
            </Show>
        </span>
    );
}

const isCapped = (selection: Selected): boolean =>
    selection.matchingCapped || (selection.matching ?? 0) >= SELECTION_COUNTED_UP_TO;

export function selectedWords(selection: Selected, t: (text: string) => string): string {
    if (selection.base === 'none') return fill(t('${0} selected'), count(selection.except.length));
    const all = isCapped(selection)
        ? `${count(SELECTION_COUNTED_UP_TO)}+`
        : count((selection.matching ?? 0) + selection.except.length);
    return selection.except.length === 0
        ? fill(t('All ${0} matching'), all)
        : fill(t('All ${0} matching except ${1}'), all, count(selection.except.length));
}

// How many entries the selection is, in words, and whether it is one.
const selectedCount = (selection: Selected): { words: string; one: boolean } => {
    if (selection.base === 'matching' && isCapped(selection))
        return { words: `${count(SELECTION_COUNTED_UP_TO)}+`, one: false };
    const selected = selection.base === 'none' ? selection.except.length : (selection.matching ?? 0);
    return { words: count(selected), one: selected === 1 };
};

export function deleteQuestion(selection: Selected, t: (text: string) => string): string {
    const { words, one } = selectedCount(selection);
    return fill(t(one ? 'Delete ${0} entry?' : 'Delete ${0} entries?'), words);
}

const deletedWords = (selection: Selected, t: (text: string) => string): string => {
    const { words, one: single } = selectedCount(selection);
    return fill(t(single ? 'Deleted ${0} entry' : 'Deleted ${0} entries'), words);
};

export const hasSelection = (selection: Selected | null): selection is Selected =>
    selection !== null && (selection.base === 'matching' || selection.except.length > 0);

type Menu = 'set' | 'moveTo' | 'alsoPutIn' | 'copyToWorld' | 'moveToWorld' | null;

export function BulkBar(props: { selection: Selected; kinds: RelationKind[]; groupBy: string | null }) {
    const { t } = useUi();
    const wb = useWb();
    const [menu, setMenu] = createSignal<Menu>(null);
    const kind = () => props.groupBy ?? props.kinds[0]?.id ?? null;
    const run = async (action: BulkAction) => {
        setMenu(null);
        // Worded before the action clears the selection.
        const many = deletedWords(props.selection, t);
        const done = await wb.act('worldbuilding.bulk', {
            book: props.selection.book,
            action,
            loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
        });
        const answer = done.ok ? (done.answer as Deleted | undefined) : undefined;
        if (!answer) return;
        const { book, set, one } = answer.deleted;
        const words = one ? fill(t('Deleted ${0}'), one.text) : many;
        wb.offerUndo(words, () => void wb.act('worldbuilding.undoDelete', { book, set }));
    };
    return (
        <div class="st-floating wb-bulk">
            <b>{selectedWords(props.selection, t)}</b>
            <span class="wb-bulk-slot">
                <button
                    type="button"
                    class="menu_button margin0 whitespacenowrap"
                    onClick={() => setMenu(menu() === 'set' ? null : 'set')}
                >
                    {t('Set')} ▾
                </button>
                <Show when={menu() === 'set'}>
                    <SetMenu
                        onSet={(set) => void run({ set })}
                        onFillTitles={() => void run({ fillTitles: true })}
                        onClose={() => setMenu(null)}
                    />
                </Show>
            </span>
            <Show when={kind()}>
                {(chosen) => (
                    <>
                        <span class="wb-bulk-slot">
                            <button
                                type="button"
                                class="menu_button margin0 whitespacenowrap"
                                onClick={() => setMenu(menu() === 'moveTo' ? null : 'moveTo')}
                            >
                                {t('Move to…')}
                            </button>
                            <Show when={menu() === 'moveTo'}>
                                <BulkPicker
                                    heading={t('Move the selected to')}
                                    book={props.selection.book}
                                    kind={chosen()}
                                    onPick={(target) => void run({ moveTo: { kind: chosen(), target } })}
                                    onClose={() => setMenu(null)}
                                />
                            </Show>
                        </span>
                        <span class="wb-bulk-slot">
                            <button
                                type="button"
                                class="menu_button margin0 whitespacenowrap"
                                onClick={() => setMenu(menu() === 'alsoPutIn' ? null : 'alsoPutIn')}
                            >
                                {t('Add to…')}
                            </button>
                            <Show when={menu() === 'alsoPutIn'}>
                                <BulkPicker
                                    heading={t('Add selected to')}
                                    book={props.selection.book}
                                    kind={chosen()}
                                    onPick={(target) => void run({ alsoPutIn: { kind: chosen(), target } })}
                                    onClose={() => setMenu(null)}
                                />
                            </Show>
                        </span>
                    </>
                )}
            </Show>
            <For each={TRANSFERS}>
                {(transfer) => (
                    <span class="wb-bulk-slot">
                        <button
                            type="button"
                            class="menu_button margin0 whitespacenowrap"
                            onClick={() => setMenu(menu() === transfer.menu ? null : transfer.menu)}
                        >
                            {t(transfer.button)}
                        </button>
                        <Show when={menu() === transfer.menu}>
                            <WorldMenu
                                heading={t(transfer.heading)}
                                from={props.selection.book}
                                onPick={(toBook) =>
                                    void run(
                                        transfer.menu === 'copyToWorld'
                                            ? { copyToWorld: toBook }
                                            : { moveToWorld: toBook },
                                    )
                                }
                                onClose={() => setMenu(null)}
                            />
                        </Show>
                    </span>
                )}
            </For>
            <button
                type="button"
                class="menu_button margin0 whitespacenowrap"
                onClick={() =>
                    void (async () => {
                        const sure = await ask(
                            {
                                kind: 'confirm',
                                message: deleteQuestion(props.selection, t),
                                detail: t('You can undo it.'),
                            },
                            t,
                        );
                        if (sure) void run({ delete: true });
                    })()
                }
            >
                {t('Delete')}
            </button>
            <span class="wb-fill" />
            <button
                type="button"
                class="menu_button margin0 whitespacenowrap wb-bulk-clear"
                onClick={() => void wb.act('worldbuilding.selectNone', { book: props.selection.book })}
            >
                {t('Clear selection')}
            </button>
        </div>
    );
}

function SetMenu(props: { onSet: (set: Partial<Placement>) => void; onFillTitles: () => void; onClose: () => void }) {
    const { t } = useUi();
    let menu: HTMLDivElement | undefined;
    dismissOn(() => menu, props.onClose);
    return (
        <div class="wb-menu list-group wb-bulk-menu" role="menu" ref={(element) => (menu = element)}>
            <div class="wb-menu-head">{t('Status')}</div>
            <For each={COMES}>
                {(one) => (
                    <button
                        class="list-group-item"
                        type="button"
                        role="menuitem"
                        onClick={() => props.onSet(one.change)}
                    >
                        {t(one.words)}
                    </button>
                )}
            </For>
            <hr />
            <div class="wb-menu-head">{t('Position')}</div>
            <For each={WHERES}>
                {(where) => (
                    <button
                        class="list-group-item"
                        type="button"
                        role="menuitem"
                        onClick={() => props.onSet({ position: where.position })}
                    >
                        {t(where.words)}
                    </button>
                )}
            </For>
            <hr />
            <button class="list-group-item" type="button" role="menuitem" onClick={() => props.onFillTitles()}>
                {t('Fill empty titles from keys')}
            </button>
        </div>
    );
}

const TRANSFERS = [
    { menu: 'copyToWorld', button: 'Copy to world…', heading: 'Copy the selected to' },
    { menu: 'moveToWorld', button: 'Move to world…', heading: 'Move the selected to' },
] as const;

function WorldMenu(props: { heading: string; from: string; onPick: (book: string) => void; onClose: () => void }) {
    let menu: HTMLDivElement | undefined;
    dismissOn(() => menu, props.onClose);
    return (
        <div class="wb-menu list-group wb-bulk-menu" role="menu" ref={(element) => (menu = element)}>
            <WorldChoice heading={props.heading} from={props.from} onPick={props.onPick} />
        </div>
    );
}

function BulkPicker(props: {
    heading: string;
    book: string;
    kind: string;
    onPick: (target: string) => void;
    onClose: () => void;
}) {
    let holder: HTMLDivElement | undefined;
    dismissOn(() => holder, props.onClose, undefined, { framed: false });
    return (
        <div ref={(element) => (holder = element)}>
            <TargetPicker
                heading={props.heading}
                book={props.book}
                kind={props.kind}
                leaveOut={[]}
                class="wb-bulk-pick st-floating"
                onPick={props.onPick}
            />
        </div>
    );
}
