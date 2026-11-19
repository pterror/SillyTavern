import { render } from '@solidjs/web';
import { afterEach, expect, test } from 'vite-plus/test';
import { UiProvider } from '@st/page/context';
import type { Ui } from '@st/page/context';
import { Maintenance } from './Maintenance.tsx';
import type { MaintenanceView } from './Maintenance.tsx';

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});
function mount(view: MaintenanceView, t = (text: string) => text) {
    const host = document.createElement('div');
    document.body.append(host);
    const ui = { t } as unknown as Ui;
    const dispose = render(
        () => (
            <UiProvider value={ui}>
                <Maintenance view={view} />
            </UiProvider>
        ),
        host,
    );
    cleanups.push(() => {
        dispose();
        host.remove();
    });
    return host;
}

test('prune counts are inserted into the translated confirmation', () => {
    const host = mount({ kind: 'prune', count: 501 }, (text) =>
        text === 'Prune ${0} tags' ? 'Remove ${0} unused tags' : text,
    );
    expect(host.querySelector('h3')?.textContent).toBe('Remove 501 unused tags');
    expect(host.textContent).toContain('Are you sure you want to remove all unused tags?');
});

test('restore warning names and errors render literally and retain every report line', () => {
    const lines = ['Tag "<img src=x onerror=alert(1)>" already exists.', 'Tag map key <missing>: nothing assigned.'];
    const host = mount({ kind: 'restoreReport', lines });
    expect(host.querySelector('samp')?.textContent).toBe(lines.join('\n'));
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('missing')).toBeNull();
});
