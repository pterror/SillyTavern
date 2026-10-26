import { Show, createMemo, createSignal } from 'solid-js';

function Child(props: { name: string; onPick: (name: string) => void }) {
    const shout = createMemo(() => props.name.toUpperCase());
    return <i onClick={() => props.onPick(props.name)}>{shout()}</i>;
}

export function Good(props: { label: string }) {
    const [count, setCount] = createSignal(0);
    return (
        <button title={props.label} onClick={() => setCount(count() + 1)}>
            {count()} {count() * 2}
            <Show when={count() > 0} fallback={<b />}>
                <Child name={props.label} onPick={(name) => setCount(name.length)} />
            </Show>
        </button>
    );
}
