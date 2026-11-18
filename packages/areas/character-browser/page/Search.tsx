import { For, Show, createEffect, createMemo, createSignal, onCleanup, onSettled } from 'solid-js';
import { useUi } from '@st/page/context';
import { Select } from '@st/page/select';
import { Name } from '@st/page/name';
import { elementSetup } from '@st/page/element';
import { Floating } from './Floating.tsx';
import type { Bound, Condition, Controls, ControlPorts, FilterView, Tag } from './controls.ts';

type Props = { controls: Controls; old: ControlPorts };
type Popup = { anchor: HTMLElement } & (
    | { kind: 'field'; index: number | null }
    | { kind: 'tag'; replace: string | null; included: boolean }
    | { kind: 'range'; field: string }
);

export function SortPicker(props: Props) {
    const { t } = useUi();
    return (
        <Show when={props.controls.search()}>
            {(state) => (
                <>
                    <Select
                        id="character_sort_order"
                        class="text_pole textarea_compact"
                        label={t('Characters sorting order')}
                        value={state().sort}
                        options={props.old.sorts
                            .filter((sort) => !sort.search || state().searchSort)
                            .map((sort) => ({ value: sort.value, label: t(sort.label) }))}
                        onChange={(value, refuse) => {
                            refuse();
                            props.old.sort(value);
                        }}
                    />
                    <Show when={state().random}>
                        <button
                            id="charListRandomReroll"
                            type="button"
                            class="right_menu_button fa-fw fa-solid fa-shuffle"
                            title={t('Get a new random order')}
                            onClick={() => {
                                props.old.reroll();
                            }}
                        />
                    </Show>
                </>
            )}
        </Show>
    );
}

export function Search(props: Props) {
    const { t, commands } = useUi();
    const [draft, setDraft] = createSignal<FilterView | null>(null);
    const [popup, setPopup] = createSignal<Popup | null>(null);
    const [editing, setEditing] = createSignal<{ index: number; condition: Condition; fresh: boolean } | null>(null);
    const [knownTags, setKnownTags] = createSignal<Record<string, Tag & { deleted?: boolean }>>({});
    let input: HTMLInputElement | undefined;
    const view = (): FilterView | null => draft() ?? props.controls.search()?.view ?? null;
    createEffect(
        () => props.controls.search(),
        (state) => {
            if (state && document.activeElement !== input && editing() === null) setDraft(null);
        },
    );
    const change = (next: FilterView, typing = false) => {
        setDraft(next);
        props.old.change(next, typing);
    };
    const patch = (next: Partial<FilterView>, typing = false) => {
        const current = view();
        if (current) change({ ...current, ...next }, typing);
    };
    createEffect(
        () => view()?.tags,
        (tags) => {
            if (!tags) return;
            const ids = [...tags.include, ...tags.exclude];
            if (ids.length === 0) return;
            let active = true;
            void props.old.tagNames(ids).then((answer) => {
                if (active && answer)
                    setKnownTags((current) => ({
                        ...current,
                        ...Object.fromEntries(answer.map((tag) => [tag.id, tag])),
                    }));
            });
            return () => {
                active = false;
            };
        },
    );
    const shownTags = createMemo(() => {
        const seen = new Set<string>();
        const first = (id: string) => {
            const canonical = knownTags()[id]?.shownAs ?? id;
            if (seen.has(canonical)) return false;
            seen.add(canonical);
            return true;
        };
        return {
            include: (view()?.tags.include ?? []).filter(first),
            exclude: (view()?.tags.exclude ?? []).filter(first),
        };
    });
    const remember = (tag: Tag) => {
        setKnownTags((current) => ({ ...current, [tag.id]: tag }));
    };
    const finish = (keep: boolean, value: string) => {
        const edit = editing();
        if (!edit) return;
        setEditing(null);
        const conditions = [...(view()?.conditions ?? [])];
        if (keep && value.trim() !== '') {
            const condition = { ...edit.condition, value: value.trim() };
            if (edit.fresh) conditions.push(condition);
            else conditions[edit.index] = condition;
        } else if (!edit.fresh && keep) conditions.splice(edit.index, 1);
        patch({ conditions });
    };
    const chooseField = (field: string, at: Popup & { kind: 'field' }) => {
        if (field === '@fav') {
            patch({ fav: view()?.fav ?? true });
            setPopup(null);
            return;
        }
        if (field === '@tag') {
            setPopup({ anchor: at.anchor, kind: 'tag', replace: null, included: true });
            return;
        }
        if (field.startsWith('@range:')) {
            setPopup({ anchor: at.anchor, kind: 'range', field: field.slice(7) });
            return;
        }
        setPopup(null);
        const conditions = [...(view()?.conditions ?? [])];
        if (at.index !== null && conditions[at.index]) {
            conditions[at.index] = { ...conditions[at.index]!, field };
            patch({ conditions });
        } else setEditing({ index: conditions.length, condition: { field, op: 'contains', value: '' }, fresh: true });
    };
    const remove = (index: number) => {
        patch({ conditions: view()?.conditions.filter((_, at) => index !== at) ?? [] });
    };
    const condition = (item: Condition, index: number, fresh = false) => (
        <span class="search_pill" data-field={item.field} data-op={item.op}>
            <button
                type="button"
                class="search_pill_label view_pill_part"
                title={t('Change the field')}
                onClick={(event) => setPopup({ kind: 'field', anchor: event.currentTarget, index })}
            >
                {t(props.old.fields.find((field) => field.value === item.field)?.label ?? item.field)}
            </button>
            <button
                type="button"
                class="view_pill_op view_pill_part"
                title={t('Switch between contains and does not contain')}
                onClick={() => {
                    const conditions = [...(view()?.conditions ?? [])];
                    conditions[index] = { ...item, op: item.op === 'contains' ? 'not_contains' : 'contains' };
                    patch({ conditions });
                }}
            >
                {item.op === 'contains' ? t('contains') : t("doesn't contain")}
            </button>
            <Show
                when={editing()?.index === index}
                fallback={
                    <button
                        type="button"
                        class="search_pill_value view_pill_part"
                        title={t('Edit the value')}
                        onClick={() => setEditing({ index, condition: item, fresh })}
                    >
                        {item.value}
                    </button>
                }
            >
                <input
                    class="view_pill_value_input"
                    value={item.value}
                    ref={elementSetup((element) => {
                        element.focus();
                        element.select();
                    })}
                    onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== 'Escape') return;
                        event.preventDefault();
                        event.stopPropagation();
                        finish(event.key === 'Enter', event.currentTarget.value);
                        input?.focus();
                    }}
                    onBlur={(event) => {
                        finish(true, event.currentTarget.value);
                    }}
                />
            </Show>
            <button
                type="button"
                class="fa-solid fa-xmark search_pill_remove"
                title={t('Remove filter')}
                onClick={() => {
                    if (fresh) setEditing(null);
                    else remove(index);
                }}
            />
        </span>
    );
    const tagPill = (id: string, included: boolean) => {
        const tag = () => knownTags()[id];
        return (
            <span class="search_pill view_tag_pill" data-tag-id={id} data-op={included ? 'has' : 'not_has'}>
                <span class="search_pill_label">{t('Tag')}</span>
                <button
                    type="button"
                    class="view_pill_op view_pill_part"
                    title={t('Switch between showing and leaving out this tag')}
                    onClick={() => {
                        const tags = view()?.tags;
                        if (tags)
                            patch({
                                tags: {
                                    ...tags,
                                    include: included
                                        ? tags.include.filter((value) => value !== id)
                                        : [...tags.include, id],
                                    exclude: included
                                        ? [...tags.exclude, id]
                                        : tags.exclude.filter((value) => value !== id),
                                },
                            });
                    }}
                >
                    {included ? t('is on it') : t("isn't on it")}
                </button>
                <button
                    type="button"
                    class="search_pill_value view_pill_part"
                    title={t('Pick another tag')}
                    onClick={(event) => setPopup({ kind: 'tag', anchor: event.currentTarget, replace: id, included })}
                >
                    <Show
                        when={tag()?.thing}
                        fallback={tag()?.deleted === true ? t('(deleted tag)') : (tag()?.name ?? '…')}
                    >
                        {(thing) => <Name named={{ thing: thing(), text: tag()?.name ?? '', shownAs: 'name' }} />}
                    </Show>
                </button>
                <button
                    type="button"
                    class="fa-solid fa-xmark search_pill_remove"
                    title={t('Remove filter')}
                    onClick={() => {
                        const tags = view()?.tags;
                        if (tags)
                            patch({
                                tags: {
                                    ...tags,
                                    include: tags.include.filter((value) => value !== id),
                                    exclude: tags.exclude.filter((value) => value !== id),
                                },
                            });
                    }}
                />
            </span>
        );
    };
    onSettled(() => {
        if (!input) return;
        return commands.register(
            [
                {
                    id: 'characterSearch.pullBackFilter',
                    label: t('Edit the last filter as text'),
                    category: t('Characters'),
                    keys: ['Backspace'],
                    typing: true,
                    when: () =>
                        document.activeElement === input && input.value === '' && (view()?.conditions.length ?? 0) > 0,
                    run: () => {
                        const conditions = [...(view()?.conditions ?? [])];
                        const last = conditions.pop();
                        if (last)
                            patch(
                                {
                                    conditions,
                                    text: `${last.op === 'not_contains' ? '-' : ''}${last.field}:${last.value}`,
                                },
                                true,
                            );
                    },
                },
            ],
            { target: input },
        );
    });
    const guide = () =>
        [
            t('Type words to search everything.'),
            t('Type field:word and a space to search one field, for example creator:alice.'),
            t('Put a minus in front to leave those out: -tag:horror.'),
            t('Use quotes to keep words together: tag:"slow burn".'),
            t("Click a filter's parts to change them, or + to add one."),
            '',
            t('Fields you can type:'),
            ...props.old.fields.map((field) => `${t(field.label)}: ${[field.value, ...field.aliases].join(', ')}`),
        ].join('\n');
    return (
        <>
            <div id="character_search_pills">
                <For each={shownTags().include}>
                    {(id, index) => (
                        <>
                            <Show when={index() > 0}>
                                <button
                                    type="button"
                                    class="view_pill_joiner view_pill_part"
                                    onClick={() => {
                                        const tags = view()?.tags;
                                        if (tags) patch({ tags: { ...tags, mode: tags.mode === 'or' ? 'and' : 'or' } });
                                    }}
                                >
                                    {view()?.tags.mode === 'or' ? t('or') : t('and')}
                                </button>
                            </Show>
                            {tagPill(id, true)}
                        </>
                    )}
                </For>
                <For each={shownTags().exclude}>{(id) => tagPill(id, false)}</For>
                <Show when={typeof view()?.fav === 'boolean'}>
                    <span class="search_pill view_fav_pill" data-fav={String(view()?.fav)}>
                        <span class="search_pill_label">{t('Favorite')}</span>
                        <button
                            type="button"
                            class="search_pill_value view_pill_part"
                            onClick={() => {
                                patch({ fav: view()?.fav !== true });
                            }}
                        >
                            {view()?.fav === true ? t('yes') : t('no')}
                        </button>
                        <button
                            type="button"
                            class="fa-solid fa-xmark search_pill_remove"
                            title={t('Remove filter')}
                            onClick={() => {
                                patch({ fav: undefined });
                            }}
                        />
                    </span>
                </Show>
                <For each={Object.entries(view()?.ranges ?? {})}>
                    {([field, bound]) => (
                        <span class="search_pill view_range_pill" data-range={field}>
                            <span class="search_pill_label">
                                {t(props.old.ranges.find((range) => range.field === field)?.label ?? field)}
                            </span>
                            <button
                                type="button"
                                class="search_pill_value view_pill_part"
                                onClick={(event) => setPopup({ kind: 'range', field, anchor: event.currentTarget })}
                            >
                                {describeRange(
                                    bound,
                                    props.old.ranges.find((range) => range.field === field)?.unit ?? 'count',
                                    t,
                                )}
                            </button>
                            <button
                                type="button"
                                class="fa-solid fa-xmark search_pill_remove"
                                title={t('Remove filter')}
                                onClick={() => {
                                    const ranges = { ...view()?.ranges };
                                    delete ranges[field];
                                    patch({ ranges });
                                }}
                            />
                        </span>
                    )}
                </For>
                <For each={view()?.conditions ?? []}>{(item, index) => condition(item, index())}</For>
                <Show when={editing()?.fresh === true ? editing() : null}>
                    {(edit) => condition(edit().condition, edit().index, true)}
                </Show>
                <button
                    type="button"
                    class="search_pill view_pill_add"
                    title={t('Add a filter')}
                    onClick={(event) => setPopup({ kind: 'field', index: null, anchor: event.currentTarget })}
                >
                    <i class="fa-solid fa-plus" />
                </button>
            </div>
            <input
                id="character_search_bar"
                type="search"
                placeholder={t('Search... (try tag:foo)')}
                value={view()?.text ?? ''}
                ref={(element) => {
                    input = element;
                }}
                onInput={(event) => {
                    const text = event.currentTarget.value;
                    const token = props.old.token(text);
                    if (token)
                        patch({ text: token.text, conditions: [...(view()?.conditions ?? []), token.condition] }, true);
                    else patch({ text }, true);
                }}
            />
            <i
                id="character_search_guide"
                class="fa-solid fa-circle-info"
                role="note"
                tabindex={0}
                title={guide()}
                aria-label={guide()}
            />
            <Show when={popup()}>
                {(at) => (
                    <Floating
                        anchor={at().anchor}
                        close={() => setPopup(null)}
                        class={at().kind === 'range' ? 'view_range_editor' : ''}
                    >
                        <Show when={at().kind === 'field'}>
                            <FieldPicker
                                fields={props.old.fields}
                                ranges={props.old.ranges}
                                special={(at() as Popup & { kind: 'field' }).index === null}
                                pick={(field) => chooseField(field, at() as Popup & { kind: 'field' })}
                            />
                        </Show>
                        <Show when={at().kind === 'tag'}>
                            <TagPicker
                                read={(term) => props.old.searchTags(term)}
                                pick={(tag) => {
                                    const p = at() as Popup & { kind: 'tag' };
                                    const tags = view()?.tags;
                                    if (tags) {
                                        remember(tag);
                                        const replace = (ids: string[]) => [
                                            ...new Set(ids.map((id) => (id === p.replace ? tag.id : id))),
                                        ];
                                        patch({
                                            tags:
                                                p.replace === null
                                                    ? {
                                                          ...tags,
                                                          include: [...new Set([...tags.include, tag.id])],
                                                          exclude: tags.exclude.filter((id) => id !== tag.id),
                                                      }
                                                    : {
                                                          ...tags,
                                                          include: p.included ? replace(tags.include) : tags.include,
                                                          exclude: p.included ? tags.exclude : replace(tags.exclude),
                                                      },
                                        });
                                    }
                                    setPopup(null);
                                }}
                            />
                        </Show>
                        <Show when={at().kind === 'range'}>
                            <RangeEditor
                                unit={
                                    props.old.ranges.find(
                                        (range) => range.field === (at() as Popup & { kind: 'range' }).field,
                                    )?.unit ?? 'count'
                                }
                                bound={view()?.ranges?.[(at() as Popup & { kind: 'range' }).field] ?? {}}
                                apply={(bound) => {
                                    const field = (at() as Popup & { kind: 'range' }).field;
                                    const ranges = { ...view()?.ranges };
                                    delete ranges[field];
                                    if (Object.keys(bound).length > 0) ranges[field] = bound;
                                    patch({ ranges });
                                    setPopup(null);
                                }}
                            />
                        </Show>
                    </Floating>
                )}
            </Show>
        </>
    );
}

function FieldPicker(props: {
    fields: ControlPorts['fields'];
    ranges: ControlPorts['ranges'];
    special: boolean;
    pick: (field: string) => void;
}) {
    const { t } = useUi();
    const [term, setTerm] = createSignal('');
    const entries = () =>
        [
            ...(props.special
                ? [
                      { value: '@tag', label: 'Tag' },
                      { value: '@fav', label: 'Favorite' },
                      ...props.ranges.map((range) => ({ value: `@range:${range.field}`, label: range.label })),
                  ]
                : []),
            ...props.fields,
        ].filter((field) => `${field.value} ${t(field.label)}`.toLowerCase().includes(term().toLowerCase()));
    return (
        <>
            <input
                type="search"
                class="text_pole textarea_compact"
                placeholder={t('Find a field')}
                value={term()}
                onInput={(event) => setTerm(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && entries()[0]) {
                        event.preventDefault();
                        event.stopPropagation();
                        props.pick(entries()[0]!.value);
                    }
                }}
            />
            <div class="view_pill_field_list">
                <For each={entries()}>
                    {(field) => (
                        <button
                            type="button"
                            class="view_pill_field_option"
                            data-field={field.value}
                            onClick={() => props.pick(field.value)}
                        >
                            {t(field.label)}
                        </button>
                    )}
                </For>
            </div>
        </>
    );
}

function TagPicker(props: { read: (term: string) => Promise<Tag[] | null>; pick: (tag: Tag) => void }) {
    const { t } = useUi();
    const [term, setTerm] = createSignal('');
    const [tags, setTags] = createSignal<Tag[]>([]);
    const [error, setError] = createSignal('');
    let request = 0;
    onCleanup(() => {
        request++;
    });
    createEffect(term, (value) => {
        const id = ++request;
        void props.read(value.trim()).then((found) => {
            if (id !== request) return;
            setTags(found ?? []);
            setError(found === null ? t('Tags could not be loaded.') : '');
        });
    });
    return (
        <>
            <input
                type="search"
                class="text_pole textarea_compact"
                placeholder={t('Find a tag')}
                value={term()}
                onInput={(event) => setTerm(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && tags()[0]) {
                        event.preventDefault();
                        event.stopPropagation();
                        props.pick(tags()[0]!);
                    }
                }}
            />
            <div class="view_pill_field_list">
                <For each={tags()}>
                    {(tag) => (
                        <button
                            type="button"
                            class="view_pill_field_option"
                            data-tag-id={tag.id}
                            onClick={() => props.pick(tag)}
                        >
                            <Show when={tag.thing} fallback={tag.name}>
                                {(thing) => <Name named={{ thing: thing(), text: tag.name, shownAs: 'name' }} />}
                            </Show>
                        </button>
                    )}
                </For>
                <Show when={tags().length === 0}>{error() !== '' ? error() : t('No tag has that name.')}</Show>
            </div>
        </>
    );
}

const dateText = (ms: number) => {
    const date = new Date(ms);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
function describeRange(bound: Bound, unit: string, t: (text: string) => string) {
    const value = (n: number) =>
        unit === 'date'
            ? new Date(n).toLocaleDateString()
            : unit === 'kb'
              ? `${Math.round(n / 1024)} ${t('KB')}`
              : `${n} ${t('characters')}`;
    if (bound.min !== undefined && bound.max !== undefined)
        return `${t('between')} ${value(bound.min)} ${t('and')} ${value(bound.max)}`;
    if (bound.min !== undefined) return `${t(unit === 'date' ? 'on or after' : 'at least')} ${value(bound.min)}`;
    if (bound.max !== undefined) return `${t(unit === 'date' ? 'on or before' : 'at most')} ${value(bound.max)}`;
    return t('any');
}
function RangeEditor(props: { unit: 'date' | 'kb' | 'count'; bound: Bound; apply: (bound: Bound) => void }) {
    const { t } = useUi();
    const text = (value: number | undefined) =>
        value === undefined
            ? ''
            : props.unit === 'date'
              ? dateText(value)
              : String(props.unit === 'kb' ? Math.round(value / 1024) : value);
    const [from, setFrom] = createSignal(text(props.bound.min));
    const [to, setTo] = createSignal(text(props.bound.max));
    const read = (value: string, end: boolean) => {
        if (value === '') return undefined;
        if (props.unit === 'date') {
            const [year, month, day] = value.split('-').map(Number);
            return new Date(year!, month! - 1, day!, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0).getTime();
        }
        const n = Number(value);
        return Number.isFinite(n) ? n * (props.unit === 'kb' ? 1024 : 1) : undefined;
    };
    const apply = () => {
        const min = read(from(), false),
            max = read(to(), true);
        props.apply({ ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) });
    };
    return (
        <div
            onKeyDown={(event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    apply();
                }
            }}
        >
            <For each={['min', 'max'] as const}>
                {(end) => (
                    <label class="view_range_row">
                        <span>
                            {t(end === 'min' ? 'From' : 'To')}
                            {props.unit === 'kb' ? t(' (KB)') : props.unit === 'count' ? t(' (characters)') : ''}
                        </span>
                        <input
                            class="text_pole textarea_compact"
                            type={props.unit === 'date' ? 'date' : 'number'}
                            data-end={end}
                            min={props.unit === 'date' ? undefined : 0}
                            value={end === 'min' ? from() : to()}
                            onInput={(event) => {
                                if (end === 'min') setFrom(event.currentTarget.value);
                                else setTo(event.currentTarget.value);
                            }}
                        />
                    </label>
                )}
            </For>
            <button type="button" class="menu_button" onClick={apply}>
                {t('Apply')}
            </button>
        </div>
    );
}
