import { createSignal } from 'solid-js';
import type { JSX } from '@st/jsx/jsx-runtime';

const LABEL = 'count';

function Show(props: { when: unknown; fallback: () => JSX.Element; children: () => JSX.Element }) {
    return <b>{() => (props.when ? props.children() : props.fallback())}</b>;
}

function Child(props: { onPick: (file: string) => void }) {
    return <i onClick={() => props.onPick('x')} />;
}

export function Good(props: { label: string }) {
    const [count, setCount] = createSignal(0);
    const elements: HTMLButtonElement[] = [];
    return (
        <button
            ref={(element: HTMLButtonElement) => elements.push(element)}
            title={() => props.label}
            aria-label={LABEL}
            onClick={() => setCount(count() + 1)}
        >
            {count} {() => count() * 2} {'text'} {`plain`}
            <Child onPick={(file) => setCount(file.length)} />
            {<b>static</b>}
            <Show when={count} fallback={() => <b />}>
                {() => <p />}
            </Show>
            <>
                <i />
            </>
        </button>
    );
}
