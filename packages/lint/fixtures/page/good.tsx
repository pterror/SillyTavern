import { createSignal } from 'solid-js';

const LABEL = 'count';

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
        </button>
    );
}
