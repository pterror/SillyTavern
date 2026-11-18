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
