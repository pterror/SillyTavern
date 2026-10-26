import { For, Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { FIELDS, VIEW } from '@st/protocol/settings';
import type { Field, Level, Range, SettingsView } from '@st/protocol/settings';
import { useUi } from '../../context.ts';

// The AI response configuration panel's controls, each bound to a field's declaration (packages/protocol/src/
// settings.ts) and its value in the server's settings view. The sections lay them out as the old markup did; an edit
// is an action, and the view the server answers redraws the control.

const byId = new Map(FIELDS.map((field) => [field.id, field]));

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

/** A field's state as its controls show it, and its edits. */
export function useField(id: string) {
    const field = byId.get(id);
    if (!field) throw new Error(`No settings field ${id}`);
    const { client } = useUi();
    const view = client.view<SettingsView>(VIEW);
    const [refusal, setRefusal] = createSignal<string | null>(null);
    const value = () => view()?.values[field.path];
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
            return !!shown && isShown(field, shown.api);
        },
        /** The level the value comes from; 'unset' where a range above the defaults sets nothing. */
        level: (): Level | 'unset' | undefined => {
            const shown = view();
            if (!shown) return undefined;
            return shown.sources[field.path] ?? (shown.range.from === 'default' ? undefined : 'unset');
        },
        range: (): Range => view()?.ranges[field.id] ?? { min: field.min, max: field.max, step: field.step },
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
export function Slider(props: { field: FieldState; counterId: string }) {
    const field = () => props.field;
    const send = (input: HTMLInputElement) =>
        void field().set(Number(input.value), () => (input.value = String(field().number())));
    return (
        <div class="range-block-range-and-counter">
            <div class="range-block-range">
                <input
                    type="range"
                    id={field().field.id}
                    min={field().range().min}
                    max={field().range().max}
                    step={field().range().step}
                    value={field().number()}
                    disabled={field().disabled()}
                    onChange={(event) => send(event.currentTarget)}
                />
            </div>
            <div class="range-block-counter">
                <input
                    type="number"
                    id={props.counterId}
                    attr:data-for={field().field.id}
                    min={field().range().min}
                    max={field().range().max}
                    step={field().range().step}
                    value={field().number()}
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
            min={field().range().min}
            max={field().range().max}
            step={field().range().step}
            value={field().number()}
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
