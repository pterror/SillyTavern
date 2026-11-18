import { render } from '@solidjs/web';
import { flush } from 'solid-js';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { UiProvider } from '@st/page/context';
import type { Ui } from '@st/page/context';
import { BrowserRows, BrowserPagination, createBrowser } from './Browser.tsx';
import type { OldPage, Row } from './types.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

const row = (id: string, name: string): Row => ({
    id: `character:${id}`,
    entity: id,
    type: 'character',
    name,
    thing: '123',
    image: '/avatar.png',
    favorite: false,
    assistant: false,
    description: 'Notes',
    auxiliary: '',
    filename: '',
    position: 0,
    count: '',
    members: [],
});
function mount() {
    const browser = createBrowser();
    const old: OldPage = { page: vi.fn(async () => {}), size: vi.fn(async () => {}), tags: vi.fn(), avatar: vi.fn() };
    const host = document.createElement('div');
    document.body.append(host);
    const ui = { t: (text: string) => text } as unknown as Ui;
    const dispose = render(
        () => (
            <UiProvider value={ui}>
                <BrowserPagination browser={browser} old={old} />
                <BrowserRows browser={browser} old={old} />
            </UiProvider>
        ),
        host,
    );
    cleanups.push(() => {
        dispose();
        host.remove();
    });
    const show = (rows: Row[], page = 1) => browser.show({ rows, page, size: 10, total: 40, approximate: false });
    return { browser, old, host, show };
}

test('a fresh answer updates existing rows while preserving bulk selection and stable identity', async () => {
    const s = mount();
    await s.show([row('a.png', 'First'), row('b.png', 'Second')]);
    const first = s.host.querySelector('[data-avatar="a.png"]')!;
    first.classList.add('character_selected');
    await s.show([
        { ...row('b.png', 'Second'), position: 0 },
        { ...row('a.png', 'Renamed'), favorite: true, position: 1 },
    ]);
    expect(s.host.querySelector('[data-avatar="a.png"]')).toBe(first);
    expect(first.classList.contains('character_selected')).toBe(true);
    expect(first.classList.contains('is_fav')).toBe(true);
    expect(first.querySelector('.ch_name')?.textContent).toBe('Renamed');
    expect(first.getAttribute('data-list-position')).toBe('1');
});

test('pagination requests the next page and waits for the repository answer to change the displayed range', async () => {
    const s = mount();
    await s.show([row('a.png', 'First')]);
    s.host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click();
    flush();
    expect(s.old.page).toHaveBeenCalledWith(2);
    expect(s.host.querySelector('.J-paginationjs-nav')?.textContent).toBe('1-10 .. 40');
    await s.show([row('b.png', 'Second')], 2);
    expect(s.host.querySelector('.J-paginationjs-nav')?.textContent).toBe('11-20 .. 40');
});

test('keyboard activation reaches the existing delegated character opener', async () => {
    const s = mount();
    await s.show([row('a.png', 'First')]);
    const character = s.host.querySelector<HTMLElement>('[data-avatar="a.png"]')!;
    const activated = vi.fn();
    s.host.addEventListener('click', activated);
    character.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(activated).toHaveBeenCalledOnce();
});

test('a failed query retains the last answer and reports its error', async () => {
    const s = mount();
    await s.show([row('a.png', 'First')]);
    flush(() => {
        s.browser.loading(false, 'The server is unavailable.');
    });
    expect(s.host.querySelector('[role="alert"]')?.textContent).toBe('The server is unavailable.');
    expect(s.host.querySelector('[data-avatar="a.png"]')).not.toBeNull();
});

test('a background cache refresh keeps the page-size chooser open', async () => {
    const s = mount();
    await s.show([row('a.png', 'First')]);
    const trigger = s.host.querySelector<HTMLButtonElement>('#character-page-size')!;
    trigger.click();
    flush();
    await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'));
    flush(() => {
        s.browser.loading(true);
    });
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
});
