import { For, Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { useUi } from '@st/page/context';
import { ROW_FIELDS } from '../protocol.ts';
import type { AxesView, RelationKind, RowField, SavedView, ViewShape, ViewsView } from '../protocol.ts';
import { AxisControl } from './Axes.tsx';
import type { Wb } from './context.ts';
import { dismissOn } from './dismiss.ts';

type Shown = Extract<ViewsView, { book: string }>;

const SHAPES: Record<ViewShape, string> = {
    cards: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z',
    rows: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
    board: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z',
    grid: 'M4 4h16v16H4zM4 12h16M12 4v16',
};

export const FIELD_WORDS: Record<RowField, string> = {
    relations: 'Relations',
    keys: 'Brought up by',
    comesIn: 'Comes in',
    goes: 'Goes',
    order: 'Order',
    chance: 'Chance',
    tokens: 'Tokens',
};

function ShapeIcon(props: { shape: ViewShape }) {
    return (
        <svg class="wb-ic" style={{ width: '15px', height: '15px' }} viewBox="0 0 24 24" aria-hidden="true">
            <path d={SHAPES[props.shape]} />
        </svg>
    );
}

export function ViewTabs(props: { views: Shown; onShow: (view: string) => void; onAdd: () => void }) {
    const { t } = useUi();
    return (
        <div class="wb-vtabs" role="tablist" aria-label={t('Views')}>
            <For each={props.views.tabs}>
                {(tab) => (
                    <button
                        type="button"
                        role="tab"
                        class="wb-vt"
                        classList={{ 'wb-vt-cur': tab.id === props.views.current }}
                        aria-selected={tab.id === props.views.current}
                        onClick={() => {
                            if (tab.id !== props.views.current) props.onShow(tab.id);
                        }}
                    >
                        <ShapeIcon shape={tab.shape} />
                        {tab.name}
                        <Show when={tab.id === props.views.current && props.views.unsaved}>
                            <span class="wb-vdot" title={t('Changed')} />
                        </Show>
                    </button>
                )}
            </For>
            <button type="button" class="wb-vt wb-vt-add" onClick={() => props.onAdd()}>
                {t('+ View')}
            </button>
        </div>
    );
}

function Control(props: { label: string; children: JSX.Element }) {
    return (
        <span class="wb-vctl">
            <b>{props.label}</b>
            {props.children}
        </span>
    );
}

export function ViewBar(props: {
    views: Shown;
    kinds: RelationKind[];
    axes: Extract<AxesView, { book: string }> | null;
    onChange: (change: Partial<Pick<SavedView, 'groupBy' | 'drawing' | 'fields' | 'columns' | 'rows'>>) => void;
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
                    <Control label={t('Inside, grouped by')}>
                        <select
                            aria-label={t('Inside, grouped by')}
                            value={view().groupBy ?? ''}
                            onChange={(event) =>
                                props.onChange({
                                    groupBy: event.currentTarget.value === '' ? null : event.currentTarget.value,
                                })
                            }
                        >
                            <For each={props.kinds}>{(kind) => <option value={kind.id}>{kind.name}</option>}</For>
                            <option value="">{t('nothing')}</option>
                        </select>
                    </Control>
                    <Control label={t('Order')}>
                        <select aria-label={t('Order')} value="world">
                            <option value="world">{t('World order')}</option>
                        </select>
                    </Control>
                    <span class="wb-vseg" role="radiogroup" aria-label={t('Drawn as')}>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={view().drawing === 'cards'}
                            classList={{ 'wb-on': view().drawing === 'cards' }}
                            onClick={() => {
                                if (view().drawing !== 'cards') props.onChange({ drawing: 'cards' });
                            }}
                        >
                            {t('Cards')}
                        </button>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={view().drawing === 'rows'}
                            classList={{ 'wb-on': view().drawing === 'rows' }}
                            onClick={() => {
                                if (view().drawing === 'rows') return;
                                props.onChange(
                                    view().fields.length === 0
                                        ? { drawing: 'rows', fields: [...ROW_FIELDS] }
                                        : { drawing: 'rows' },
                                );
                            }}
                        >
                            {t('Rows')}
                        </button>
                    </span>
                    <Show when={view().drawing === 'rows'}>
                        <Fields chosen={view().fields} onChoose={(fields) => props.onChange({ fields })} />
                    </Show>
                    <Show when={props.views.unsaved || tab()?.changed === true}>
                        <span class="wb-vchg">
                            <Show when={props.views.unsaved}>
                                <button type="button" class="wb-vbtn" onClick={() => props.onSave()}>
                                    {t('Save')}
                                </button>
                                <button type="button" class="wb-vbtn wb-quietbtn" onClick={() => props.onDiscard()}>
                                    {t('Discard')}
                                </button>
                            </Show>
                            <Show when={!props.views.unsaved && tab()?.changed === true}>
                                <button type="button" class="wb-vbtn wb-quietbtn" onClick={() => props.onReset()}>
                                    {t('Reset to the world’s')}
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
                class="wb-vctl"
                aria-expanded={open()}
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
        <div class="wb-menu wb-fields-menu" role="menu" ref={(element) => (menu = element)}>
            <For each={ROW_FIELDS}>
                {(field) => (
                    <label class="wb-check">
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
    };
}
