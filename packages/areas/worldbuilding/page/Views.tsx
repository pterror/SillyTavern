import { For, Show, createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useUi } from '@st/page/context';
import { ask } from '@st/page/dialog';
import { ROW_FIELDS, WORLD_SORT } from '../protocol.ts';
import type {
    AxesView,
    RelationKind,
    RowField,
    SavedView,
    SortBy,
    ViewShape,
    ViewSort,
    ViewsView,
} from '../protocol.ts';
import { AxisControl } from './Axes.tsx';
import type { Wb } from './context.ts';
import { dismissOn } from './dismiss.ts';
import { Icon } from './icons.tsx';
import { fill } from './words.ts';

type Shown = Extract<ViewsView, { book: string }>;

const SHAPES: Record<ViewShape, string> = {
    cards: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z',
    rows: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
    board: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z',
    grid: 'M4 4h16v16H4zM4 12h16M12 4v16',
};

// The sorts the Order control offers, upstream's names; a field's sort reads the world ungrouped.
const SORT_CHOICES: { sort: ViewSort; label: string }[] = [
    { sort: WORLD_SORT, label: 'World order' },
    { sort: { by: 'title', descending: false }, label: 'Title A-Z' },
    { sort: { by: 'title', descending: true }, label: 'Title Z-A' },
    { sort: { by: 'depth', descending: false }, label: 'Depth ↗' },
    { sort: { by: 'depth', descending: true }, label: 'Depth ↘' },
    { sort: { by: 'order', descending: false }, label: 'Order ↗' },
    { sort: { by: 'order', descending: true }, label: 'Order ↘' },
    { sort: { by: 'uid', descending: false }, label: 'UID ↗' },
    { sort: { by: 'uid', descending: true }, label: 'UID ↘' },
    { sort: { by: 'probability', descending: false }, label: 'Probability ↗' },
    { sort: { by: 'probability', descending: true }, label: 'Probability ↘' },
    { sort: { by: 'priority', descending: false }, label: 'Priority' },
];

const sortValue = (sort: ViewSort) => `${sort.by}:${sort.descending ? 'desc' : 'asc'}`;

function sortOf(value: string): ViewSort {
    const [by, direction] = value.split(':') as [SortBy, string];
    return { by, descending: direction === 'desc' };
}

export const FIELD_WORDS: Record<RowField, string> = {
    relations: 'Relations',
    names: 'Names',
    triggers: 'Triggers',
    comesIn: 'Status',
    goes: 'Position',
    order: 'Order',
    chance: 'Probability',
    tokens: 'Tokens',
};

function ShapeIcon(props: { shape: ViewShape }) {
    return (
        <svg class="wb-ic" style={{ width: '15px', height: '15px' }} viewBox="0 0 24 24" aria-hidden="true">
            <path d={SHAPES[props.shape]} />
        </svg>
    );
}

export function ViewTabs(props: {
    views: Shown;
    onShow: (view: string) => void;
    onAdd: () => void;
    onRename: (view: string, name: string) => void;
    onDelete: (view: string) => void;
    // Whether the world's entries are drawn as cards or rows, which a tap selects in select mode.
    selectable: boolean;
    selecting: boolean;
    onSelecting: (on: boolean) => void;
}) {
    const { t } = useUi();
    return (
        <div class="wb-vtabs tab-container" aria-label={t('Views')}>
            <For each={props.views.tabs}>
                {(tab) => (
                    <label class="tab-title wb-vt">
                        <input
                            type="radio"
                            class="invisible-radio"
                            name="wb-view-tab"
                            checked={tab.id === props.views.current}
                            onChange={() => {
                                if (tab.id !== props.views.current) props.onShow(tab.id);
                            }}
                        />
                        <span class="wb-vt-words">
                            <ShapeIcon shape={tab.shape} />
                            {tab.name}
                            <Show when={tab.id === props.views.current && props.views.unsaved}>
                                <span class="wb-vdot" title={t('Unsaved changes')} />
                            </Show>
                            <Show when={tab.id === props.views.current}>
                                <ViewMenuButton
                                    name={tab.name}
                                    onRename={(name) => props.onRename(tab.id, name)}
                                    onDelete={() => props.onDelete(tab.id)}
                                />
                            </Show>
                        </span>
                    </label>
                )}
            </For>
            <button type="button" class="menu_button margin0 whitespacenowrap wb-vt-add" onClick={() => props.onAdd()}>
                {t('+ View')}
            </button>
            <Show when={props.selectable}>
                <button
                    type="button"
                    class={['menu_button margin0 whitespacenowrap wb-select-mode', { 'wb-on': props.selecting }]}
                    aria-pressed={props.selecting ? 'true' : 'false'}
                    onClick={() => props.onSelecting(!props.selecting)}
                >
                    {t('Select')}
                </button>
            </Show>
        </div>
    );
}

function ViewMenuButton(props: { name: string; onRename: (name: string) => void; onDelete: () => void }) {
    const { t } = useUi();
    const [open, setOpen] = createSignal(false);
    let button: HTMLButtonElement | undefined;
    let menu: HTMLDivElement | undefined;
    return (
        <span class="wb-vt-more-box">
            <button
                ref={(element) => (button = element)}
                type="button"
                class="right_menu_button interactable wb-vt-more"
                aria-label={fill(t('More for ${0}'), props.name)}
                aria-expanded={open() ? 'true' : 'false'}
                onClick={(event) => {
                    event.preventDefault();
                    setOpen(!open());
                }}
            >
                <Icon name="more" size={15} />
            </button>
            <Show when={open()}>
                {(() => {
                    dismissOn(
                        () => menu,
                        () => setOpen(false),
                        () => button,
                    );
                    const run = (action: () => Promise<void>) => {
                        setOpen(false);
                        void action();
                    };
                    return (
                        <div class="wb-menu list-group wb-vt-menu" role="menu" ref={(element) => (menu = element)}>
                            <button
                                type="button"
                                role="menuitem"
                                class="list-group-item"
                                onClick={() =>
                                    run(async () => {
                                        const name = await ask(
                                            { kind: 'input', message: t('View name'), value: props.name },
                                            t,
                                        );
                                        if (name !== null && name.trim() !== '') props.onRename(name);
                                    })
                                }
                            >
                                {t('Rename…')}
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                class="list-group-item wb-danger"
                                onClick={() =>
                                    run(async () => {
                                        const sure = await ask(
                                            { kind: 'confirm', message: fill(t('Delete view “${0}”?'), props.name) },
                                            t,
                                        );
                                        if (sure) props.onDelete();
                                    })
                                }
                            >
                                {t('Delete')}
                            </button>
                        </div>
                    );
                })()}
            </Show>
        </span>
    );
}

function Control(props: { label: string; children: JSX.Element }) {
    return (
        <label class="wb-vctl">
            <span>{props.label}</span>
            {props.children}
        </label>
    );
}

export function ViewBar(props: {
    views: Shown;
    kinds: RelationKind[];
    axes: Extract<AxesView, { book: string }> | null;
    onChange: (
        change: Partial<Pick<SavedView, 'groupBy' | 'sort' | 'drawing' | 'fields' | 'columns' | 'rows'>>,
    ) => void;
    onApplySort: (numbering: { start: number; step: number; ascending: boolean }) => void;
    onSave: () => void;
    onDiscard: () => void;
    onReset: () => void;
}) {
    const { t } = useUi();
    const shown = () => props.views.shown;
    const tab = () => props.views.tabs.find((one) => one.id === props.views.current);
    return (
        <Show when={shown()}>
            {(view) => (
                <div class="wb-vbar">
                    <AxisControl
                        label={t('Columns')}
                        axis="columns"
                        items={view().columns}
                        headers={props.axes?.columns ?? null}
                        kinds={props.kinds}
                        book={props.views.book}
                        onChange={props.onChange}
                    />
                    <Show when={view().columns.length === 0 || view().rows.length > 0}>
                        <AxisControl
                            label={t('Rows')}
                            axis="rows"
                            items={view().rows}
                            headers={props.axes?.rows ?? null}
                            kinds={props.kinds}
                            book={props.views.book}
                            onChange={props.onChange}
                        />
                    </Show>
                    <Control label={t('Group by')}>
                        <select
                            class="text_pole margin0"
                            aria-label={t('Group by')}
                            value={view().groupBy ?? ''}
                            onChange={(event) =>
                                props.onChange({
                                    groupBy: event.currentTarget.value === '' ? null : event.currentTarget.value,
                                })
                            }
                        >
                            <For each={props.kinds}>{(kind) => <option value={kind.id}>{kind.name}</option>}</For>
                            <option value="">{t('None')}</option>
                        </select>
                    </Control>
                    <Control label={t('Sort')}>
                        <select
                            class="text_pole margin0"
                            aria-label={t('Sort')}
                            value={sortValue(view().groupBy === null ? view().sort : WORLD_SORT)}
                            onChange={(event) => props.onChange({ sort: sortOf(event.currentTarget.value) })}
                        >
                            <For each={SORT_CHOICES}>
                                {(choice) => (
                                    <option
                                        value={sortValue(choice.sort)}
                                        disabled={view().groupBy !== null && choice.sort.by !== 'world'}
                                        title={
                                            view().groupBy !== null && choice.sort.by !== 'world'
                                                ? t('Sort needs grouping off')
                                                : undefined
                                        }
                                    >
                                        {t(choice.label)}
                                    </option>
                                )}
                            </For>
                        </select>
                    </Control>
                    <Show when={view().groupBy === null && view().sort.by !== 'world'}>
                        <button
                            type="button"
                            class="menu_button margin0 whitespacenowrap"
                            title={t('Apply current sorting as Order')}
                            onClick={() =>
                                void (async () => {
                                    const answer = await ask(
                                        {
                                            kind: 'confirm',
                                            message: t('Apply Current Sorting'),
                                            detail: t(
                                                'Assigns Order values to all entries based on their current sort position.',
                                            ),
                                            numbers: [
                                                { id: 'start', label: t('Starting value'), value: 100, min: 0 },
                                                { id: 'step', label: t('Step'), value: 1, min: 1 },
                                            ],
                                            checkbox: { label: t('Ascending order'), checked: false },
                                        },
                                        t,
                                    );
                                    if (answer)
                                        props.onApplySort({
                                            start: answer.numbers['start'] ?? 100,
                                            step: answer.numbers['step'] ?? 1,
                                            ascending: answer.checked,
                                        });
                                })()
                            }
                        >
                            {t('Apply as Order')}
                        </button>
                    </Show>
                    <span class="wb-vseg tab-container" aria-label={t('Layout')}>
                        <label class="tab-title">
                            <input
                                type="radio"
                                class="invisible-radio"
                                name="wb-drawn-as"
                                checked={view().drawing === 'cards'}
                                onChange={() => props.onChange({ drawing: 'cards' })}
                            />
                            <span>{t('Cards')}</span>
                        </label>
                        <label class="tab-title">
                            <input
                                type="radio"
                                class="invisible-radio"
                                name="wb-drawn-as"
                                checked={view().drawing === 'rows'}
                                onChange={() =>
                                    props.onChange(
                                        view().fields.length === 0
                                            ? { drawing: 'rows', fields: [...ROW_FIELDS] }
                                            : { drawing: 'rows' },
                                    )
                                }
                            />
                            <span>{t('Rows')}</span>
                        </label>
                    </span>
                    <Show when={view().drawing === 'rows'}>
                        <Fields chosen={view().fields} onChoose={(fields) => props.onChange({ fields })} />
                    </Show>
                    <Show when={props.views.unsaved || tab()?.changed === true}>
                        <span class="wb-vchg">
                            <Show when={props.views.unsaved}>
                                <button
                                    type="button"
                                    class="menu_button margin0 whitespacenowrap"
                                    onClick={() => props.onSave()}
                                >
                                    {t('Save')}
                                </button>
                                <button
                                    type="button"
                                    class="menu_button margin0 whitespacenowrap"
                                    onClick={() => props.onDiscard()}
                                >
                                    {t('Discard')}
                                </button>
                            </Show>
                            <Show when={!props.views.unsaved && tab()?.changed === true}>
                                <button
                                    type="button"
                                    class="menu_button margin0 whitespacenowrap"
                                    onClick={() => props.onReset()}
                                >
                                    {t('Reset to world version')}
                                </button>
                            </Show>
                        </span>
                    </Show>
                </div>
            )}
        </Show>
    );
}

function Fields(props: { chosen: RowField[]; onChoose: (fields: RowField[]) => void }) {
    const { t } = useUi();
    const [open, setOpen] = createSignal(false);
    let button: HTMLButtonElement | undefined;
    return (
        <span class="wb-fields">
            <button
                type="button"
                class="menu_button margin0 whitespacenowrap"
                aria-expanded={open() ? 'true' : 'false'}
                ref={(element) => (button = element)}
                onClick={() => setOpen(!open())}
            >
                {t('Fields')} ▾
            </button>
            <Show when={open()}>
                <FieldsMenu
                    chosen={props.chosen}
                    onChoose={props.onChoose}
                    onClose={() => setOpen(false)}
                    opener={() => button}
                />
            </Show>
        </span>
    );
}

function FieldsMenu(props: {
    chosen: RowField[];
    onChoose: (fields: RowField[]) => void;
    onClose: () => void;
    opener: () => HTMLElement | undefined;
}) {
    const { t } = useUi();
    let menu: HTMLDivElement | undefined;
    dismissOn(() => menu, props.onClose, props.opener);
    return (
        <div class="wb-menu list-group wb-fields-menu" role="menu" ref={(element) => (menu = element)}>
            <For each={ROW_FIELDS}>
                {(field) => (
                    <label class="list-group-item checkbox_label" role="none">
                        <input
                            type="checkbox"
                            checked={props.chosen.includes(field)}
                            onChange={(event) =>
                                props.onChoose(
                                    ROW_FIELDS.filter((one) =>
                                        one === field ? event.currentTarget.checked : props.chosen.includes(one),
                                    ),
                                )
                            }
                        />
                        {t(FIELD_WORDS[field])}
                    </label>
                )}
            </For>
        </div>
    );
}

// The views a world shows: none until the server says which, so the tabs and bar never appear and then move.
export const viewsOf = (view: ViewsView | undefined, book: string | null): Shown | null =>
    view && view.book !== null && view.book === book ? view : null;

export function viewActions(wb: Wb, book: () => string | null) {
    const overview = () => wb.firstRead();
    const send = (type: string, payload: object = {}) => {
        const shown = book();
        if (shown !== null) void wb.act(type, { book: shown, ...payload });
    };
    return {
        show: (view: string) => {
            send('worldbuilding.showView', { view, overview: overview() });
        },
        add: () => {
            send('worldbuilding.addView', { overview: overview() });
        },
        change: (change: object) => {
            send('worldbuilding.changeView', { change, overview: overview() });
        },
        save: () => {
            send('worldbuilding.saveView');
        },
        discard: () => {
            send('worldbuilding.discardView', { overview: overview() });
        },
        reset: () => {
            send('worldbuilding.resetView', { overview: overview() });
        },
        rename: (view: string, name: string) => {
            send('worldbuilding.renameView', { view, name });
        },
        delete: (view: string) => {
            send('worldbuilding.deleteView', { view, overview: overview() });
        },
        applySort: (numbering: { start: number; step: number; ascending: boolean }) => {
            send('worldbuilding.applySortAsOrder', numbering);
        },
    };
}
