import { render } from 'solid-js/web';
import { expect, test } from 'vite-plus/test';
import { UiProvider } from '@st/page/context';
import { testCommands } from '@st/page/focus-actions';
import type { Client } from '@st/page/client';
import type { EntryFacts } from '../protocol.ts';
import { WbProvider } from './context.ts';
import type { Wb } from './context.ts';
import { StatusDot, StatusLegend, StatusControl, statusOf } from './Status.tsx';

test('status gives disabled and constant precedence over vector search', () => {
    expect(statusOf({ disable: true, constant: true, vectorized: true })).toBe('never');
    expect(statusOf({ disable: false, constant: true, vectorized: true })).toBe('always');
    expect(statusOf({ disable: false, constant: false, vectorized: true })).toBe('found');
    expect(statusOf({ disable: false, constant: false, vectorized: false })).toBe('broughtUp');
});

test('the card dot names its status and the legend explains all four patterns', () => {
    const host = document.createElement('div');
    const dispose = render(
        () => (
            <UiProvider value={{ client: {} as Client, ...testCommands(), t: (text) => text }}>
                <StatusDot status="found" />
                <StatusLegend />
            </UiProvider>
        ),
        host,
    );
    expect(host.querySelector('.wb-status-found')?.getAttribute('aria-label')).toBe(
        'Vectorized: Activated by vector search',
    );
    expect(host.querySelectorAll('.wb-status-legend .wb-status-dot')).toHaveLength(4);
    expect(host.querySelector('.wb-status-legend')?.textContent).toBe('KeywordConstantVectorizedDisabled');
    dispose();
});

test('the overview dot changes status without opening the card and preserves the mode when disabling', () => {
    const sent: unknown[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    let cardClicks = 0;
    const wb = {
        edit: async (type: string, payload: unknown) => {
            sent.push({ type, payload });
            return { done: 'saved', text: null };
        },
    } as Wb;
    const facts = { version: '9', comesIn: 'found' } as EntryFacts;
    const dispose = render(
        () => (
            <UiProvider value={{ client: {} as Client, ...testCommands(), t: (text) => text }}>
                <WbProvider value={wb}>
                    <div onClick={() => cardClicks++}>
                        <StatusControl book="1" entry="2" name="Lamp" facts={facts} />
                    </div>
                </WbProvider>
            </UiProvider>
        ),
        host,
    );
    try {
        const opener = host.querySelector<HTMLButtonElement>('.wb-status-control')!;
        opener.click();
        expect(opener.getAttribute('aria-expanded')).toBe('true');
        expect(host.querySelectorAll('.wb-status-option')).toHaveLength(4);
        expect(host.querySelector('.wb-status-option[aria-pressed="true"]')?.textContent).toContain('Vectorized');
        host.querySelectorAll<HTMLButtonElement>('.wb-status-option')[1]!.click();
        expect(sent[0]).toEqual({
            type: 'worldbuilding.setPlacement',
            payload: {
                book: '1',
                entry: '2',
                version: '9',
                fields: { disable: false, constant: true, vectorized: false },
            },
        });
        expect(host.querySelector('.wb-status-picker')).toBeNull();
        expect(document.activeElement).toBe(opener);
        opener.click();
        host.querySelectorAll<HTMLButtonElement>('.wb-status-option')[3]!.click();
        expect(sent[1]).toEqual({
            type: 'worldbuilding.setPlacement',
            payload: { book: '1', entry: '2', version: '9', fields: { disable: true } },
        });
        expect(cardClicks).toBe(0);
    } finally {
        dispose();
        host.remove();
    }
});
