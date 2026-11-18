import { createSignal, omit, onSettled } from 'solid-js';
import { Portal } from '@solidjs/web';
import { Select as InteractSelect } from '@pterror/interact-solid/2';
import { prefixedIds } from '@pterror/interact-core';
import type { PartProps } from '@pterror/interact-solid/interact';

export type SelectOption = { value: string; label: string };

/** The app's theme around interact's select behavior. */
export function Select(props: {
    id: string;
    label: string;
    value: string;
    options: readonly SelectOption[];
    class?: string | undefined;
    disabled?: boolean | undefined;
    onChange: (value: string, refuse: () => void) => void;
}) {
    const automaticIds = prefixedIds(`${props.id}-select`);
    let trigger: HTMLButtonElement | undefined;
    const Trigger = (part: PartProps) => (
        <button
            {...omit(part, 'part', 'children')}
            type="button"
            class={['st-select-trigger', props.class]}
            disabled={props.disabled === true}
            value={props.value}
            ref={(element) => {
                trigger = element;
            }}
        >
            <span class="st-select-value">{part.children}</span>
            <span class="st-select-arrow fa-solid fa-chevron-down" aria-hidden="true" />
        </button>
    );
    const Popover = (part: PartProps) => {
        const [mount, setMount] = createSignal<Element>(document.body);
        onSettled(() => {
            // Keep a popup inside its containing panel, but outside a wrapping label's activation behavior.
            setMount(trigger?.closest('label')?.parentElement ?? trigger?.parentElement ?? document.body);
        });
        return (
            <Portal mount={mount()}>
                <span {...omit(part, 'part')} class="st-floating st-select-popover" />
            </Portal>
        );
    };
    const List = (part: PartProps) => <span {...omit(part, 'part')} class="st-select-list" />;
    const Option = (part: PartProps) => <span {...omit(part, 'part')} class="st-select-option" />;
    const Root = (part: PartProps) => <span {...omit(part, 'part')} class="st-select" />;
    return (
        <InteractSelect
            label={props.label}
            placeholder=""
            rows={8}
            disabled={props.disabled === true}
            items={props.options.map((option) => ({ key: option.value, text: option.label }))}
            value={props.value}
            naming={{
                idOf: (target) =>
                    target.owner.length === 0 && target.part === 'trigger' ? props.id : automaticIds.idOf(target),
            }}
            parts={{ root: Root, trigger: Trigger, popover: Popover, list: List, option: Option }}
            onChange={(value, change) => {
                if (value !== null) props.onChange(String(value), change.refuse);
            }}
        />
    );
}
