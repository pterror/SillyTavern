import { For, Show, createRenderEffect, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { FIELDS, VIEW, samplerSelectOf, zenOf } from '../protocol.ts';
import type { Field, Level, Range, SamplerSelect, SettingsView } from '../protocol.ts';
import { useUi } from '@st/page/context';

// The AI response configuration panel's controls, each bound to a field's declaration (packages/protocol/src/
// settings.ts) and its value in the server's settings view. The sections lay them out as the old markup did; an edit
// is an action, and the view the server answers redraws the control.

const byId = new Map(FIELDS.map((field) => [field.id, field]));

/** Whether something shown for these text generation backends (or all but them) shows for this one. */
export function forBackend(rule: Field['textgen'], backend: string): boolean {
    if (rule === undefined) return true;
    const types = 'only' in rule ? rule.only : rule.except;
    const listed = types.includes(backend) || types.includes('all');
    return 'only' in rule ? listed : !listed;
}

/**
 * What the sampler select says of something hidden by these sampler names: shown or not when the user chose the
 * samplers ("prioritize manual", with a list), else nothing (its backend decides).
 */
export function bySamplerSelect(names: readonly string[] | undefined, select: SamplerSelect): boolean | undefined {
    if (names === undefined || !select.manual || select.shown.length === 0) return undefined;
    return names.some((name) => select.shown.includes(name));
}

/**
 * Whether a field shows for what the view's API, source and backend are now; the user's chosen samplers decide over
 * the backend, as the old page's sampler select did.
 */
export function isShown(field: Field, api: SettingsView['api'], samplers?: SamplerSelect): boolean {
    if (field.api && !field.api.includes(api.main)) return false;
    if (field.family === 'cc' && field.sources && !field.sources.includes(api.source)) return false;
    if (field.family === 'textgen') {
        const chosen = samplers ? bySamplerSelect(field.samplers, samplers) : undefined;
        return chosen ?? forBackend(field.textgen, api.textgen);
    }
    return true;
}

/** A field's state as its controls show it, and its edits. */
export function useField(id: string) {
    const field = byId.get(id);
    if (!field) throw new Error(`No settings field ${id}`);
    const { client } = useUi();
    const view = client.view<SettingsView>(VIEW);
    const [refusal, setRefusal] = createSignal<string | null>(null);
    const value = () => view()?.values[field.path];
    const range = (): Range => view()?.ranges[field.id] ?? { min: field.min, max: field.max, step: field.step };
    return {
        field,
        value,
        /** The value as a number (a control's), whatever it's stored as. */
        number: () => {
            const current = value();
            return typeof current === 'number' ? current : Number(current ?? 0);
        },
        /** The value as a control's text (a select's numbers are its options' values as text). */
        text: () => {
            const current = value();
            return typeof current === 'string' ? current : typeof current === 'number' ? String(current) : '';
        },
        shown: () => {
            const shown = view();
            return !!shown && isShown(field, shown.api, samplerSelectOf(shown));
        },
        /** Zen sliders on. */
        zen: () => view()?.zen === true,
        /** The level the value comes from; 'unset' where a range above the defaults sets nothing. */
        level: (): Level | 'unset' | undefined => {
            const shown = view();
            if (!shown) return undefined;
            return shown.sources[field.path] ?? (shown.range.from === 'default' ? undefined : 'unset');
        },
        range,
        /** Not editable: no view yet, or a range that ends at the defaults. */
        disabled: () => (view()?.range.to ?? 'default') === 'default',
        /** A chat's level is edited, and it sets this field: its value can be taken away. */
        unsettable: () => {
            const shown = view();
            return (
                !!shown &&
                ['group', 'character'].includes(shown.range.to) &&
                shown.sources[field.path] === shown.range.to
            );
        },
        refusal,
        /** Sends an edit; refused, `restore` puts the control back to the server's value, and the refusal shows. */
        set: async (next: unknown, restore: () => void) => {
            setRefusal(null);
            const result = await client.send('settings.set', { path: field.path, value: next });
            if (!result.ok) {
                setRefusal(result.error);
                restore();
            }
        },
        unset: () => void client.send('settings.unset', { path: field.path }),
        reset: () => void client.send('settings.reset', { path: field.path }),
    };
}

export type FieldState = ReturnType<typeof useField>;

/**
 * A field's block: drawn only while the field shows, colored by the level its value comes from, with why an edit was
 * refused under it.
 */
export function FieldBlock(props: {
    id: string;
    class?: string;
    /** The block's own id, where the old markup had one (its CSS selects it). */
    blockId?: string;
    children: (field: FieldState) => JSX.Element;
}) {
    const state = useField(props.id);
    return (
        <Show when={state.shown()}>
            <div
                id={props.blockId}
                class={props.class ?? 'range-block'}
                attr:data-field={props.id}
                attr:data-settings-level={state.level()}
            >
                {props.children(state)}
                <Show when={state.refusal()}>{(text) => <small class="settings_refusal">{text()}</small>}</Show>
            </div>
        </Show>
    );
}

/** The button that takes a chat level's value of a field away (shown only where there's one to take). */
export function UnsetButton(props: { field: FieldState }) {
    const { t } = useUi();
    return (
        <Show when={props.field.unsettable()}>
            <button
                type="button"
                class="settings_unset fa-solid fa-xmark"
                title={t("Take this chat's value away")}
                onClick={() => props.field.unset()}
            />
        </Show>
    );
}

/**
 * Keeps a number input on its field: its range, then its value, set together whenever either changes. Set apart
 * (attributes compared one by one), an input whose min rose past its value clamped it, and the same value wasn't set
 * again once the min came back down.
 */
function numeric(field: FieldState) {
    return (input: HTMLInputElement) => {
        createRenderEffect(() => {
            const { min, max, step } = field.range();
            for (const [name, bound] of [
                ['min', min],
                ['max', max],
                ['step', step],
            ] as const) {
                if (bound === undefined) input.removeAttribute(name);
                else input.setAttribute(name, String(bound));
            }
            input.value = String(field.number());
        });
    };
}

/** A number input stepped by the mouse wheel while it's focused, as the old page's were (dom-handlers.js). */
function wheelStep(field: FieldState, input: HTMLInputElement, event: WheelEvent) {
    if (document.activeElement !== input) return;
    event.preventDefault();
    // A step of 'any' or none is 1, as the browser's own arrows take it.
    const step = input.step === '' || input.step === 'any' ? 1 : Number(input.step);
    const { min, max } = field.range();
    let next = Number(input.value) + (event.deltaY < 0 ? step : -step);
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    // As many decimals as the step has, so 0.1 + 0.2 doesn't send 0.30000000000000004.
    const decimals = (String(step).split('.')[1] ?? '').length;
    void field.set(Number(next.toFixed(decimals)), () => (input.value = String(field.number())));
}

/** A slider with its number box, as the old range blocks (the box's id is the old counter's). */
/**
 * A slider with its number box, as the old range blocks (the box's id is the old counter's); a zen slider instead
 * with zen sliders on. `look` is the old markup's: a range block's, or text generation's neo-range classes.
 */
export function Slider(props: {
    field: FieldState;
    counterId: string;
    look?: 'block' | 'neo' | 'neo-wide';
    unlocked?: boolean;
}) {
    return (
        <Show
            when={props.field.zen()}
            fallback={<PlainSlider field={props.field} counterId={props.counterId} look={props.look} />}
        >
            <ZenSlider field={props.field} unlocked={props.unlocked === true} />
        </Show>
    );
}

function PlainSlider(props: { field: FieldState; counterId: string; look: 'block' | 'neo' | 'neo-wide' | undefined }) {
    const field = () => props.field;
    const send = (input: HTMLInputElement) =>
        void field().set(Number(input.value), () => (input.value = String(field().number())));
    const counter = () => (
        <input
            class="neo-range-input"
            type="number"
            id={props.counterId}
            attr:data-for={field().field.id}
            ref={numeric(field())}
            disabled={field().disabled()}
            onChange={(event) => send(event.currentTarget)}
            onWheel={(event) => wheelStep(field(), event.currentTarget, event)}
        />
    );
    return (
        <Show
            when={props.look === 'neo' || props.look === 'neo-wide'}
            fallback={<BlockSlider field={props.field} counterId={props.counterId} />}
        >
            <input
                class="neo-range-slider"
                type="range"
                id={field().field.id}
                ref={numeric(field())}
                disabled={field().disabled()}
                onChange={(event) => send(event.currentTarget)}
            />
            <Show when={props.look === 'neo-wide'} fallback={counter()}>
                <div attr:data-randomization-disabled="true" class="wide100p">
                    {counter()}
                </div>
            </Show>
        </Show>
    );
}

function BlockSlider(props: { field: FieldState; counterId: string }) {
    const field = () => props.field;
    const send = (input: HTMLInputElement) =>
        void field().set(Number(input.value), () => (input.value = String(field().number())));
    return (
        <div class="range-block-range-and-counter">
            <div class="range-block-range">
                <input
                    type="range"
                    id={field().field.id}
                    ref={numeric(field())}
                    disabled={field().disabled()}
                    onChange={(event) => send(event.currentTarget)}
                />
            </div>
            <div class="range-block-counter">
                <input
                    type="number"
                    id={props.counterId}
                    attr:data-for={field().field.id}
                    ref={numeric(field())}
                    disabled={field().disabled()}
                    onChange={(event) => send(event.currentTarget)}
                    onWheel={(event) => wheelStep(field(), event.currentTarget, event)}
                />
            </div>
        </div>
    );
}

export function NumberBox(props: { field: FieldState; class?: string }) {
    const field = () => props.field;
    return (
        <input
            type="number"
            class={props.class ?? 'text_pole'}
            id={field().field.id}
            ref={numeric(field())}
            disabled={field().disabled()}
            onChange={(event) => {
                const input = event.currentTarget;
                void field().set(Number(input.value), () => (input.value = String(field().number())));
            }}
            onWheel={(event) => wheelStep(field(), event.currentTarget, event)}
        />
    );
}

export function Checkbox(props: { field: FieldState }) {
    const field = () => props.field;
    return (
        <input
            type="checkbox"
            id={field().field.id}
            checked={field().value() === true}
            disabled={field().disabled()}
            onChange={(event) => {
                const box = event.currentTarget;
                void field().set(box.checked, () => (box.checked = field().value() === true));
            }}
        />
    );
}

/** A select of the field's options; their labels are translated by key where the old markup had one. */
export function Select(props: {
    field: FieldState;
    class?: string;
    keys?: Record<string, string>;
    /** Off for a reason besides the field's own (another field's value). */
    disabled?: boolean;
}) {
    const { t } = useUi();
    const field = () => props.field;
    return (
        <select
            class={props.class}
            id={field().field.id}
            value={field().text()}
            disabled={field().disabled() || props.disabled === true}
            onChange={(event) => {
                const select = event.currentTarget;
                const option = field().field.options?.find((o) => String(o.value) === select.value);
                void field().set(option ? option.value : select.value, () => (select.value = field().text()));
            }}
        >
            <For each={field().field.options ?? []}>
                {(option) => (
                    <option value={String(option.value)} selected={String(option.value) === field().text()}>
                        {t(option.label, props.keys?.[String(option.value)])}
                    </option>
                )}
            </For>
        </select>
    );
}

/** A text area; an edit is sent when it's left (the maximized editor sends its own). */
export function TextArea(props: {
    field: FieldState;
    class?: string;
    rows?: number;
    placeholder?: string;
    name?: string | undefined;
}) {
    const field = () => props.field;
    return (
        <textarea
            id={field().field.id}
            class={props.class ?? 'text_pole textarea_compact autoSetHeight'}
            name={props.name}
            rows={props.rows ?? 3}
            placeholder={props.placeholder ?? '—'}
            value={field().text()}
            disabled={field().disabled()}
            onChange={(event) => {
                const area = event.currentTarget;
                void field().set(area.value, () => (area.value = field().text()));
            }}
        />
    );
}

/** One radio of a choice field, under its old id. */
export function Radio(props: { field: FieldState; index: number; name: string }) {
    const field = () => props.field;
    const option = () => field().field.options?.[props.index];
    return (
        <input
            type="radio"
            id={field().field.inputs?.[props.index]}
            name={props.name}
            value={String(option()?.value ?? '')}
            checked={field().value() === option()?.value}
            disabled={field().disabled()}
            onChange={(event) => {
                const radio = event.currentTarget;
                void field().set(option()?.value, () => (radio.checked = field().value() === option()?.value));
            }}
        />
    );
}

/**
 * A zen slider (the old page's CreateZenSliders): a track whose handle shows the value (Off at the field's off
 * value), dragged across `steps` stops or through named values, or typed into. The field's old id stays on a hidden
 * range input holding the value, for extensions that read it.
 */
function ZenSlider(props: { field: FieldState; unlocked: boolean }) {
    const { t } = useUi();
    const field = () => props.field;
    const zen = () => zenOf(field().field.id);
    const values = () => (props.unlocked ? zen().unlockedValues : undefined) ?? zen().values;
    /** Where the handle is while it's dragged (the value isn't sent until it's let go). */
    const [dragged, setDragged] = createSignal<number | null>(null);
    const range = () => {
        const named = values();
        if (named) return { min: 0, max: named.length - 1, step: 1 };
        const { min = 0, max = 1 } = field().range();
        return { min, max, step: (max - min) / zen().steps };
    };
    /** The handle's position for a value: its index among named values, else the value. */
    const positionOf = (value: number) => {
        const named = values();
        if (!named) return value;
        const index = named.indexOf(value);
        if (index !== -1) return index;
        const standIn = zen().standIn;
        return standIn === undefined ? 0 : Math.max(0, named.indexOf(standIn));
    };
    const valueAt = (position: number) => values()?.[position] ?? position;
    const position = () => dragged() ?? positionOf(field().number());
    const fraction = () => {
        const { min, max } = range();
        return max === min ? 0 : (position() - min) / (max - min);
    };
    const text = () => {
        const value = valueAt(position());
        if (value === zen().off) return t('Off');
        if (zen().all !== undefined && value === zen().all) return t('All');
        return values() ? String(value) : value.toFixed(zen().decimals);
    };
    const snap = (track: HTMLElement, clientX: number) => {
        const rect = track.getBoundingClientRect();
        const { min, max, step } = range();
        const raw = min + Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * (max - min);
        return Math.min(max, Math.max(min, min + Math.round((raw - min) / step) * step));
    };
    const commit = (value: number) => {
        const decimals = values() ? 0 : zen().decimals;
        void field().set(Number(value.toFixed(decimals)), () => setDragged(null));
    };
    return (
        <>
            <input type="range" id={field().field.id} ref={numeric(field())} hidden />
            <div
                id={`${field().field.id}_zenslider`}
                class="ui-slider ui-corner-all ui-slider-horizontal ui-widget ui-widget-content"
                style={{ width: '100%' }}
                onPointerDown={(event) => {
                    if (field().disabled() || event.target !== event.currentTarget) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDragged(snap(event.currentTarget, event.clientX));
                }}
                onPointerMove={(event) => {
                    if (dragged() !== null) setDragged(snap(event.currentTarget, event.clientX));
                }}
                onPointerUp={() => {
                    const at = dragged();
                    if (at === null) return;
                    setDragged(null);
                    commit(valueAt(at));
                }}
            >
                <span
                    class="ui-slider-handle ui-corner-all ui-state-default"
                    tabindex="0"
                    contenteditable={values() === undefined && !field().disabled()}
                    style={{
                        left: `${fraction() * 100}%`,
                        'margin-left': `${-fraction() * 50}px`,
                        color: valueAt(position()) === zen().off ? 'rgba(128,128,128,0.5)' : '',
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            event.currentTarget.blur();
                        }
                    }}
                    onBlur={(event) => {
                        if (values() !== undefined) return;
                        const typed = Number.parseFloat(event.currentTarget.textContent);
                        const handle = event.currentTarget;
                        if (Number.isFinite(typed) && typed !== field().number()) {
                            void field().set(typed, () => (handle.textContent = text()));
                        } else handle.textContent = text();
                    }}
                >
                    {text()}
                </span>
            </div>
        </>
    );
}

/**
 * A text area holding JSON: what's typed is sent parsed, when it's left (empty is nothing). Text that isn't JSON
 * isn't sent, and stays as typed with why.
 */
export function JsonArea(props: { field: FieldState; class?: string; rows?: number; placeholder?: string }) {
    const { t } = useUi();
    const field = () => props.field;
    const [invalid, setInvalid] = createSignal(false);
    const shownText = () => {
        const value = field().value();
        return value === null || value === undefined ? '' : JSON.stringify(value, null, 2);
    };
    return (
        <>
            <textarea
                id={field().field.id}
                class={props.class ?? 'text_pole textarea_compact monospace'}
                rows={props.rows ?? 4}
                placeholder={props.placeholder}
                value={shownText()}
                disabled={field().disabled()}
                onChange={(event) => {
                    const text = event.currentTarget.value.trim();
                    let parsed: unknown = null;
                    if (text !== '') {
                        try {
                            parsed = JSON.parse(text);
                        } catch {
                            setInvalid(true);
                            return;
                        }
                    }
                    setInvalid(false);
                    // Refused, what was typed stays to be fixed: the refusal says why.
                    void field().set(parsed, () => {});
                }}
            />
            <Show when={invalid()}>
                <small class="settings_refusal">{t('Not valid JSON.')}</small>
            </Show>
        </>
    );
}
