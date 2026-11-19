import { Show, createSignal, flush } from 'solid-js';
import { render } from '@solidjs/web';
import { expect, test, vi } from 'vite-plus/test';
import { UiProvider } from '../src/context.ts';
import type { Ui } from '../src/context.ts';
import { createClient } from '../src/client.ts';
import { testCommands } from '../src/focus-actions.ts';
import { float } from '../src/layers/popover.ts';

test.each([false, true])('a floating element opens only while connected (connected: %s)', (connected) => {
    const host = document.createElement('div');
    document.body.append(host);
    const detached = document.createElement('div');
    const show = vi.spyOn(detached, 'showPopover');
    const Probe = () => {
        float(() => detached, { anchor: () => undefined, close: () => {} });
        return connected ? detached : null;
    };
    const ui: Ui = { ...testCommands(), client: createClient({ headers: () => ({}) }), t: (text) => text };
    const dispose = render(
        () => (
            <UiProvider value={ui}>
                <Probe />
            </UiProvider>
        ),
        host,
    );
    try {
        expect(show).toHaveBeenCalledTimes(connected ? 1 : 0);
    } finally {
        dispose();
        host.remove();
    }
});

test('Escape is consumed when a close callback returns the signal setter’s false value', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const [open, setOpen] = createSignal(true);
    let anchor: HTMLInputElement | undefined;
    const Probe = () => {
        let shown: HTMLDivElement | undefined;
        float(() => shown, { anchor: () => anchor, close: () => setOpen(false) });
        return (
            <div
                ref={(element) => {
                    shown = element;
                }}
            >
                Suggestions
            </div>
        );
    };
    const ui: Ui = { ...testCommands(), client: createClient({ headers: () => ({}) }), t: (text) => text };
    const closeParent = vi.fn();
    const unregister = ui.commands.register([
        {
            id: 'parent.close',
            label: 'Close parent',
            category: 'Panels',
            keys: ['Escape'],
            typing: true,
            run: closeParent,
        },
    ]);
    const dispose = render(
        () => (
            <UiProvider value={ui}>
                <input
                    ref={(element) => {
                        anchor = element;
                    }}
                />
                <Show when={open()}>
                    <Probe />
                </Show>
            </UiProvider>
        ),
        host,
    );
    try {
        anchor!.focus();
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        anchor!.dispatchEvent(event);
        flush();
        expect(open()).toBe(false);
        expect(event.defaultPrevented).toBe(true);
        expect(closeParent).not.toHaveBeenCalled();
    } finally {
        dispose();
        unregister();
        host.remove();
    }
});
