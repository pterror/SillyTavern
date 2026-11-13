import { Show, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';

// Text drawn as it reads, edited in place when clicked: Enter (a line) or leaving the field keeps it, Escape doesn't.
export function Editable(props: {
    value: string;
    multiline?: boolean;
    label: string;
    class: string;
    onSave: (value: string) => void;
    children: JSX.Element;
}) {
    const [editing, setEditing] = createSignal(false);
    const done = (value: string | null) => {
        setEditing(false);
        if (value !== null && value !== props.value) props.onSave(value);
    };
    return (
        <Show
            when={editing()}
            fallback={
                <div
                    class={props.class}
                    role="button"
                    tabIndex={0}
                    aria-label={props.label}
                    onClick={() => setEditing(true)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') setEditing(true);
                    }}
                >
                    {props.children}
                </div>
            }
        >
            <Field
                value={props.value}
                multiline={props.multiline === true}
                label={props.label}
                class={props.class}
                onDone={done}
            />
        </Show>
    );
}

function Field(props: {
    value: string;
    multiline: boolean;
    label: string;
    class: string;
    onDone: (value: string | null) => void;
}) {
    let field: HTMLInputElement | HTMLTextAreaElement | undefined;
    let finished = false;
    const finish = (value: string | null) => {
        if (finished) return;
        finished = true;
        props.onDone(value);
    };
    const fit = () => {
        if (field instanceof HTMLTextAreaElement) {
            field.style.height = 'auto';
            field.style.height = `${field.scrollHeight}px`;
        }
    };
    onMount(() => {
        fit();
        field?.focus();
    });
    const keys = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            finish(null);
        } else if (event.key === 'Enter' && !props.multiline) finish((event.currentTarget as HTMLInputElement).value);
    };
    return props.multiline ? (
        <textarea
            ref={(element) => (field = element)}
            class={`${props.class} wb-editing`}
            aria-label={props.label}
            value={props.value}
            onInput={fit}
            on:keydown={keys}
            onBlur={(event) => finish(event.currentTarget.value)}
        />
    ) : (
        <input
            ref={(element) => (field = element)}
            class={`${props.class} wb-editing`}
            aria-label={props.label}
            value={props.value}
            on:keydown={keys}
            onBlur={(event) => finish(event.currentTarget.value)}
        />
    );
}
