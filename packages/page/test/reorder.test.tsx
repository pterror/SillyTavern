import { For, createSignal, flush } from 'solid-js';
import { render } from '@solidjs/web';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { createReorder } from '../src/reorder.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

function mount(move = vi.fn(async (_key: string, _placement: { before: string } | { after: string }) => {})) {
    const host = document.createElement('div');
    document.body.append(host);
    const [keys, setKeys] = createSignal(['a', 'b', 'c']);
    const active = vi.fn();
    let control!: ReturnType<typeof createReorder>;
    const Row = (props: { id: string }) => {
        const row = control.row(props.id);
        const handle = control.handle(props.id);
        return (
            <div
                ref={(element) => {
                    row(element);
                    element.getBoundingClientRect = () => new DOMRect(0, keys().indexOf(props.id) * 40, 100, 40);
                }}
            >
                <button
                    type="button"
                    data-key={props.id}
                    ref={(element) => {
                        handle(element);
                        element.setPointerCapture = vi.fn();
                    }}
                >
                    {props.id}
                </button>
            </div>
        );
    };
    function List() {
        control = createReorder({ keys, move, active });
        return (
            <div
                ref={(element) => {
                    control.list(element);
                    element.setPointerCapture = vi.fn();
                    element.getBoundingClientRect = () => new DOMRect(0, 0, 100, keys().length * 40);
                }}
            >
                <For each={keys()}>{(key) => <Row id={key} />}</For>
            </div>
        );
    }
    const disposeRoot = render(() => <List />, host);
    const dispose = () => {
        disposeRoot();
        host.remove();
    };
    cleanups.push(dispose);
    const button = (key: string) => host.querySelector<HTMLButtonElement>(`[data-key="${key}"]`)!;
    const pointer = (target: EventTarget, type: string, y: number, x = 10) => {
        target.dispatchEvent(
            new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerId: 1,
                button: 0,
                buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
                clientX: x,
                clientY: y,
            }),
        );
        flush();
    };
    return { host, control, keys, setKeys, button, pointer, move, active, dispose, list: host.firstElementChild! };
}

test('dragging sends an anchor intent; DOM order follows only the caller snapshot', async () => {
    const s = mount();
    const c = s.button('c');
    s.pointer(c, 'pointerdown', 100);
    s.pointer(s.list, 'pointermove', 2);
    expect(s.control.target()).toEqual({ key: 'c', target: 'a', after: false });
    expect([...s.host.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['a', 'b', 'c']);
    s.pointer(document, 'pointerup', 2);
    await vi.waitFor(() => expect(s.control.held()).toBeUndefined());
    expect(s.move).toHaveBeenCalledExactlyOnceWith('c', { before: 'a' });
    expect(s.active.mock.calls).toEqual([[true], [false]]);
    flush(() => s.setKeys(['c', 'a', 'b']));
    expect(s.host.querySelector('button')).toBe(c);
});

test('leaving the list clears a valid target, and dropping back in place sends nothing', () => {
    const s = mount();
    s.pointer(s.button('c'), 'pointerdown', 100);
    s.pointer(s.list, 'pointermove', 2);
    s.pointer(s.list, 'pointermove', 2, 200);
    expect(s.control.target()).toBeUndefined();
    s.pointer(document, 'pointerup', 2, 200);
    expect(s.move).not.toHaveBeenCalled();
    s.pointer(s.button('b'), 'pointerdown', 60);
    s.pointer(s.list, 'pointermove', 39);
    s.pointer(document, 'pointerup', 39);
    expect(s.move).not.toHaveBeenCalled();
});

test('removing the dragged row cancels it, and disposal removes the drag listeners', () => {
    const s = mount();
    s.pointer(s.button('c'), 'pointerdown', 100);
    s.pointer(s.list, 'pointermove', 2);
    flush(() => s.setKeys(['a', 'b']));
    expect(s.control.held()).toBeUndefined();
    s.pointer(document, 'pointerup', 2);
    expect(s.move).not.toHaveBeenCalled();
    s.pointer(s.button('b'), 'pointerdown', 60);
    s.pointer(s.list, 'pointermove', 2);
    s.dispose();
    s.pointer(document, 'pointerup', 2);
    expect(s.move).not.toHaveBeenCalled();
    expect(s.active.mock.calls).toEqual([[true], [false], [true], [false]]);
});

test('Escape and pointer cancellation cancel a gesture without saving an order', () => {
    const s = mount();
    for (const cancel of ['Escape', 'pointercancel']) {
        const button = s.button('c');
        s.pointer(button, 'pointerdown', 100);
        s.pointer(s.list, 'pointermove', 2);
        if (cancel === 'Escape') expect(s.control.cancel()).toBe(true);
        else s.pointer(document, cancel, 2);
        s.pointer(document, 'pointerup', 2);
        expect(s.control.held()).toBeUndefined();
    }
    expect(s.move).not.toHaveBeenCalled();
});

test('keyboard moves wait for the action and keep focus; errors and disposal release the pending action', async () => {
    let reject!: (reason: Error) => void;
    const move = vi.fn(
        () =>
            new Promise<void>((_resolve, refuse) => {
                reject = refuse;
            }),
    );
    const s = mount(move);
    const button = s.button('b');
    button.focus();
    s.control.step('b', -1);
    expect(s.move).toHaveBeenCalledExactlyOnceWith('b', { before: 'a' });
    expect(s.control.pending()).toBe(true);
    s.control.step('b', 1);
    expect(s.move).toHaveBeenCalledTimes(1);
    reject(new Error('Move failed'));
    await vi.waitFor(() => expect(s.control.pending()).toBe(false));
    expect(s.control.error()).toBe('Move failed');
    expect(document.activeElement).toBe(button);
    s.control.step('b', 1);
    s.dispose();
    reject(new Error('Closed during move'));
    await Promise.resolve();
    expect(s.active.mock.calls).toEqual([[true], [false], [true], [false]]);
});
