import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { Portal } from '@solidjs/web';
import type { JSX } from '@solidjs/web';
import { move } from '@pterror/interact-list/move';
import { arrayStep } from '@pterror/interact-list/array-step';
import { float } from './layers/popover.ts';
import { useUi } from './context.ts';
import { elementSetup } from './element.ts';

export type Suggestion = { value: string; label: string };

function Suggestions(props: {
    anchor: HTMLInputElement;
    id: string;
    options: readonly Suggestion[];
    active: string | undefined;
    close: () => void;
    activate: (value: string) => void;
    choose: (value: string) => void;
    renderItem: (value: string) => JSX.Element;
    status: string;
}) {
    let menu: HTMLDivElement | undefined;
    float(() => menu, { anchor: () => props.anchor, also: () => [props.anchor], close: props.close });
    createEffect(
        () => props.active,
        () => {
            menu?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
        },
    );
    return (
        <Portal>
            <div
                ref={(element) => {
                    menu = element;
                }}
                class="st-autocomplete-menu"
            >
                <div id={props.id} role="listbox" aria-label={props.anchor.getAttribute('aria-label') ?? ''}>
                    <For each={props.options}>
                        {(option) => (
                            <div
                                id={`${props.id}-${encodeURIComponent(option.value)}`}
                                role="option"
                                aria-selected={props.active === option.value ? 'true' : 'false'}
                                class="st-select-option"
                                onPointerMove={() => props.activate(option.value)}
                                onPointerDown={(event) => event.preventDefault()}
                                onClick={() => props.choose(option.value)}
                            >
                                {props.renderItem(option.value)}
                            </div>
                        )}
                    </For>
                </div>
                <Show when={props.status !== ''}>
                    <div role="status">{props.status}</div>
                </Show>
            </div>
        </Portal>
    );
}

/** An editable combobox: Solid draws the options; interact owns movement and floating/dismissal behavior. */
export function Autocomplete(props: {
    id: string;
    label: string;
    placeholder: string;
    class?: string;
    maxLength?: number | undefined;
    value: string;
    options: readonly Suggestion[];
    open: boolean;
    status: string;
    onInput: (value: string) => void;
    onOpen: (open: boolean) => void;
    onChoose: (value: string) => void;
    renderItem?: (value: string) => JSX.Element;
}) {
    const { focusActions } = useUi();
    const [active, setActive] = createSignal<string | undefined>(undefined);
    let input: HTMLInputElement | undefined;
    let alive = true;
    onCleanup(() => {
        alive = false;
    });
    const listId = `${props.id}-suggestions`;
    const movement = move<string>({
        from: active,
        step: arrayStep(() => props.options.map((option) => option.value)),
        to: (value) => {
            if (alive && props.open && props.options.some((option) => option.value === value)) setActive(value);
        },
    });
    createEffect(
        () => props.options,
        () => {
            setActive(undefined);
        },
    );
    const choose = (value: string) => {
        props.onChoose(value);
        setActive(undefined);
    };
    return (
        <>
            <input
                id={props.id}
                ref={elementSetup((element) => {
                    input = element;
                    const detach = focusActions.attach(element, {
                        confirm: () => {
                            if (!props.open) return false;
                            const value = active() ?? props.options[0]?.value;
                            if (value !== undefined) choose(value);
                        },
                        next: () => {
                            props.onOpen(true);
                            void movement.by(1);
                        },
                        previous: () => {
                            props.onOpen(true);
                            void movement.by(-1);
                        },
                        cancel: () => {
                            if (!props.open) return false;
                            props.onOpen(false);
                            setActive(undefined);
                        },
                    });
                    return () => {
                        detach();
                    };
                })}
                type="text"
                class={props.class}
                maxlength={props.maxLength}
                placeholder={props.placeholder}
                value={props.value}
                role="combobox"
                aria-label={props.label}
                aria-autocomplete="list"
                aria-haspopup="listbox"
                aria-expanded={props.open ? 'true' : 'false'}
                aria-controls={props.open ? listId : undefined}
                aria-activedescendant={
                    props.open && active() !== undefined && props.options.some((option) => option.value === active())
                        ? `${listId}-${encodeURIComponent(active()!)}`
                        : undefined
                }
                autocomplete="off"
                onFocus={() => props.onOpen(true)}
                onBlur={() => props.onOpen(false)}
                onInput={(event) => {
                    setActive(undefined);
                    props.onInput(event.currentTarget.value);
                }}
            />
            <Show when={props.open && input !== undefined}>
                <Suggestions
                    anchor={input!}
                    id={listId}
                    options={props.options}
                    active={active()}
                    status={props.status}
                    close={() => {
                        props.onOpen(false);
                    }}
                    activate={setActive}
                    choose={choose}
                    renderItem={(value) =>
                        props.renderItem === undefined
                            ? (props.options.find((option) => option.value === value)?.label ?? '')
                            : props.renderItem(value)
                    }
                />
            </Show>
        </>
    );
}
