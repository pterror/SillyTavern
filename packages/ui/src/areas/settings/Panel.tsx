import { For, Show, createMemo, createSignal } from 'solid-js';
import { FIELDS, LEVELS, VIEW } from '@st/protocol/settings';
import type { Field, Level, Range, SettingsView } from '@st/protocol/settings';
import { useUi } from '../../context.ts';

// The AI response configuration panel's fields, drawn from their declarations (packages/protocol/src/settings.ts)
// and the server's settings view: each field with its value, the level it comes from (its row's color), and dimmed
// where no level in the range sets it. An edit is an action; the view the server answers redraws it.

/** Whether a field shows for what the view's API, source and backend are now. */
export function isShown(field: Field, api: SettingsView['api']): boolean {
    if (field.api && !field.api.includes(api.main)) return false;
    if (field.family === 'cc' && field.sources && !field.sources.includes(api.source)) return false;
    if (field.family === 'textgen' && field.textgen) {
        const types = 'only' in field.textgen ? field.textgen.only : field.textgen.except;
        const listed = types.includes(api.textgen) || types.includes('all');
        if ('only' in field.textgen ? !listed : listed) return false;
    }
    return true;
}

/** The fields of a family, in order, cut into runs of one group (or none). */
function runsOf(fields: readonly Field[]) {
    const runs: { group: Field['group']; fields: Field[] }[] = [];
    for (const field of fields) {
        const last = runs.at(-1);
        if (last && last.group?.label === field.group?.label) last.fields.push(field);
        else runs.push({ group: field.group, fields: [field] });
    }
    return runs;
}

export function SettingsPanel(props: { family: Field['family'] }) {
    const { client } = useUi();
    const view = client.view<SettingsView>(VIEW);
    const fields = createMemo(() => {
        const api = view()?.api;
        return api ? FIELDS.filter((field) => field.family === props.family && isShown(field, api)) : [];
    });
    const runs = createMemo(() => runsOf(fields()));
    return (
        <div class="settings_panel" attr:data-family={props.family}>
            <For each={runs()}>
                {(run) => (
                    <div class="settings_group" attr:data-group={run.group?.id ?? ''}>
                        <Show when={run.group}>{(group) => <h4 class="settings_group_title">{group().label}</h4>}</Show>
                        <For each={run.fields}>{(field) => <FieldRow field={field} />}</For>
                    </div>
                )}
            </For>
        </div>
    );
}

function FieldRow(props: { field: Field }) {
    const { client, t } = useUi();
    const view = client.view<SettingsView>(VIEW);
    const [refusal, setRefusal] = createSignal<string | null>(null);
    const value = () => view()?.values[props.field.path];
    const level = (): Level | 'unset' | null => {
        const shown = view();
        if (!shown) return null;
        const source = shown.sources[props.field.path];
        if (source) return source;
        // Nothing in the range sets it: the default's, or (a range above the default) unset.
        return shown.range.from === 'default' ? null : 'unset';
    };
    const range = (): Range =>
        view()?.ranges[props.field.id] ?? { min: props.field.min, max: props.field.max, step: props.field.step };
    const settable = () => (view()?.range.to ?? 'user') !== 'default';
    const unsettable = () => {
        const shown = view();
        return !!shown && shown.sources[props.field.path] === shown.range.to;
    };

    /** Sends the edit; refused, the control goes back to the server's value and says why. */
    const set = async (next: unknown, control: { restore: () => void }) => {
        setRefusal(null);
        const result = await client.send('settings.set', { path: props.field.path, value: next });
        if (!result.ok) {
            setRefusal(result.error);
            control.restore();
        }
    };

    return (
        <div
            class="range-block settings_field"
            attr:data-settings-level={level() ?? undefined}
            attr:data-field={props.field.id}
            title={props.field.tip ? t(props.field.tip) : undefined}
        >
            <div class="range-block-title">
                <span>{t(props.field.label)}</span>
                <Show when={unsettable()}>
                    <button
                        type="button"
                        class="settings_unset fa-solid fa-xmark"
                        title={t("Take this level's value away")}
                        onClick={() => void client.send('settings.unset', { path: props.field.path })}
                    />
                </Show>
            </div>
            <Control field={props.field} value={value()} range={range()} disabled={!settable()} onSet={set} />
            <Show when={refusal()}>{(text) => <small class="settings_refusal">{text()}</small>}</Show>
        </div>
    );
}

function Control(props: {
    field: Field;
    value: unknown;
    range: Range;
    disabled: boolean;
    onSet: (value: unknown, control: { restore: () => void }) => void;
}) {
    const { t } = useUi();
    const id = () => props.field.id;
    const asNumber = () => (typeof props.value === 'number' ? props.value : Number(props.value ?? 0));
    // A select's or text's value as its control shows it (a select's numbers are its options' values as text).
    const asText = () =>
        typeof props.value === 'string' ? props.value : typeof props.value === 'number' ? String(props.value) : '';
    // The control's own value back to the server's (an input keeps what was typed until told otherwise).
    const restoring = (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, to: () => string) => ({
        restore: () => (element.value = to()),
    });

    switch (props.field.kind) {
        case 'range':
            return (
                <div class="range-block-range-and-counter">
                    <div class="range-block-range">
                        <input
                            type="range"
                            id={id()}
                            min={props.range.min}
                            max={props.range.max}
                            step={props.range.step}
                            value={asNumber()}
                            disabled={props.disabled}
                            onChange={(event) =>
                                props.onSet(
                                    Number(event.currentTarget.value),
                                    restoring(event.currentTarget, () => String(asNumber())),
                                )
                            }
                        />
                    </div>
                    <div class="range-block-counter">
                        <input
                            type="number"
                            attr:data-for={id()}
                            min={props.range.min}
                            max={props.range.max}
                            step={props.range.step}
                            value={asNumber()}
                            disabled={props.disabled}
                            onChange={(event) =>
                                props.onSet(
                                    Number(event.currentTarget.value),
                                    restoring(event.currentTarget, () => String(asNumber())),
                                )
                            }
                        />
                    </div>
                </div>
            );
        case 'number':
            return (
                <input
                    type="number"
                    class="text_pole"
                    id={id()}
                    min={props.range.min}
                    max={props.range.max}
                    step={props.range.step}
                    value={asNumber()}
                    disabled={props.disabled}
                    onChange={(event) =>
                        props.onSet(
                            Number(event.currentTarget.value),
                            restoring(event.currentTarget, () => String(asNumber())),
                        )
                    }
                />
            );
        case 'checkbox':
            return (
                <label class="checkbox_label">
                    <input
                        type="checkbox"
                        id={id()}
                        checked={props.value === true}
                        disabled={props.disabled}
                        onChange={(event) => {
                            const box = event.currentTarget;
                            props.onSet(box.checked, { restore: () => (box.checked = props.value === true) });
                        }}
                    />
                </label>
            );
        case 'select':
            return (
                <select
                    class="text_pole"
                    id={id()}
                    value={asText()}
                    disabled={props.disabled}
                    onChange={(event) => props.onSet(event.currentTarget.value, restoring(event.currentTarget, asText))}
                >
                    <For each={props.field.options ?? []}>
                        {(option) => <option value={String(option.value)}>{t(option.label)}</option>}
                    </For>
                </select>
            );
        case 'text':
            return (
                <textarea
                    class="text_pole textarea_compact"
                    id={id()}
                    value={asText()}
                    disabled={props.disabled}
                    onChange={(event) => props.onSet(event.currentTarget.value, restoring(event.currentTarget, asText))}
                />
            );
        case 'choice':
            return (
                <div class="settings_choice" id={id()}>
                    <For each={props.field.options ?? []}>
                        {(option, index) => (
                            <label class="checkbox_label">
                                <input
                                    type="radio"
                                    name={id()}
                                    id={props.field.inputs?.[index()]}
                                    checked={props.value === option.value}
                                    disabled={props.disabled}
                                    onChange={(event) => {
                                        const radio = event.currentTarget;
                                        props.onSet(option.value, {
                                            restore: () => (radio.checked = props.value === option.value),
                                        });
                                    }}
                                />
                                <span>{t(option.label)}</span>
                            </label>
                        )}
                    </For>
                </div>
            );
    }
}

/** The levels a tab shows and edits: two handles over the five levels, each labeled with how many fields it sets. */
export function LevelSlider() {
    const { client, t } = useUi();
    const view = client.view<SettingsView>(VIEW);
    const index = (level: Level) => LEVELS.indexOf(level);
    const from = () => index(view()?.range.from ?? 'default');
    const to = () => index(view()?.range.to ?? 'user');
    const move = (which: 'from' | 'to', position: number, input: HTMLInputElement) => {
        const shown = view();
        if (!shown) return;
        let next = { ...shown.range, [which]: LEVELS[position] ?? shown.range[which] };
        if (index(next.from) > index(next.to)) next = { from: next.to, to: next.from };
        void client.send('settings.range', next).then((result) => {
            if (!result.ok) input.value = String(which === 'from' ? from() : to());
        });
    };
    return (
        <div id="settings_level_range" class="settings_level_range">
            <div class="settings_level_track">
                <input
                    type="range"
                    id="settings_level_from"
                    min={0}
                    max={LEVELS.length - 1}
                    step={1}
                    value={from()}
                    onChange={(event) => move('from', Number(event.currentTarget.value), event.currentTarget)}
                />
                <input
                    type="range"
                    id="settings_level_to"
                    min={0}
                    max={LEVELS.length - 1}
                    step={1}
                    value={to()}
                    onChange={(event) => move('to', Number(event.currentTarget.value), event.currentTarget)}
                />
            </div>
            <div class="settings_level_labels">
                <For each={LEVELS}>
                    {(level, position) => (
                        <span
                            class="settings_level_label"
                            attr:data-level={level}
                            classList={{
                                settings_level_in_range: position() >= from() && position() <= to(),
                                settings_level_absent:
                                    (level === 'character' &&
                                        !(view()?.context && 'avatar' in (view()?.context ?? {}))) ||
                                    (level === 'group' && !(view()?.context && 'group' in (view()?.context ?? {}))),
                            }}
                        >
                            {t(level[0]!.toUpperCase() + level.slice(1))}
                            <Show when={level !== 'default' && (view()?.counts[level] ?? 0) > 0}>
                                <small class="settings_level_count">{view()?.counts[level]}</small>
                            </Show>
                        </span>
                    )}
                </For>
            </div>
        </div>
    );
}
