import { render } from 'solid-js/web';
import { expect, test } from 'vite-plus/test';
import type { Client } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import type { OpenEntryView } from '../protocol.ts';
import { WbProvider } from './context.ts';
import type { Wb } from './context.ts';
import { Keys } from './Keys.tsx';

const ENTRY: OpenEntryView = {
    book: '1',
    entry: '7',
    deleted: false,
    entryKey: '7',
    label: { thing: '7', text: 'Ilse Varro', shownAs: 'name' },
    picture: null,
    title: 'Ilse Varro',
    keys: [
        { text: 'Ilse Varro', isName: true, alsoBringsUp: 0 },
        { text: 'ledger', isName: false, alsoBringsUp: 1 },
    ],
    text: '',
    links: [],
    linksComplete: true,
    relations: [],
    placement: {} as OpenEntryView['placement'],
    placementDiffersFromDefaults: false,
    tokens: 96,
    mentionedIn: { pages: [] },
};

function stand(entry: OpenEntryView) {
    const sent: { type: string; payload: unknown }[] = [];
    const client: Client = {
        send: async () => ({ ok: true }),
        view: () => () => undefined,
        receive: () => {},
        reconnected: async () => {},
        reread: async () => {},
        version: () => 0,
    };
    const wb: Wb = {
        act: async (type, payload) => {
            sent.push({ type, payload });
            return { ok: true };
        },
        layout: () => ({ regionsByNestingLevel: [], cardTextCharacters: 0 }),
        firstRead: () => ({ firstRank: 0, endRank: 1, layout: { regionsByNestingLevel: [], cardTextCharacters: 0 } }),
        pointingAt: () => ({ endRank: 1, layout: { regionsByNestingLevel: [], cardTextCharacters: 0 } }),
        open: () => {},
        say: () => {},
        drag: { press: () => {}, moves: () => false, clickIsDrop: () => false, held: () => null },
    };
    const host = document.createElement('div');
    document.body.append(host);
    render(
        () => (
            <UiProvider value={{ client, t: (text) => text }}>
                <WbProvider value={wb}>
                    <Keys entry={entry} />
                </WbProvider>
            </UiProvider>
        ),
        host,
    );
    return { host, sent };
}

const button = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll('button')].find((found) => found.textContent.includes(label)) as HTMLButtonElement;

test('names are drawn in the entry’s look and triggers plain; a key brought up by others says how many entries', () => {
    const { host } = stand(ENTRY);
    const keys = [...host.querySelectorAll('.wb-key')];
    expect(keys.map((key) => key.getAttribute('aria-label'))).toEqual(['“Ilse Varro”, a name', '“ledger”, a trigger']);
    expect(keys[0]?.querySelector('.named-name.look-7')?.textContent).toBe('Ilse Varro');
    expect(keys[1]?.querySelector('.wb-key-trigger')?.textContent).toBe('ledger');
    expect(keys[1]?.querySelector('.wb-key-more')?.textContent).toBe('· 2 entries');
    expect(host.querySelector('.wb-always')).toBe(null);
});

test('a key shared with other entries asks who they are when opened, and its choices each send one action', () => {
    const { host, sent } = stand(ENTRY);
    button(host, 'ledger').click();
    expect(sent).toEqual([{ type: 'worldbuilding.showKeySharers', payload: { book: '1', entry: '7', key: 'ledger' } }]);
    button(host, 'A name').click();
    expect(sent.at(-1)).toEqual({
        type: 'worldbuilding.setKeyAs',
        payload: { book: '1', entry: '7', key: 'ledger', as: 'name' },
    });
});

test('+ name takes the words typed and adds them as a name on Enter', () => {
    const { host, sent } = stand(ENTRY);
    button(host, '+ name').click();
    const field = host.querySelector('input') as HTMLInputElement;
    field.value = 'the innkeeper';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sent).toEqual([
        { type: 'worldbuilding.addKey', payload: { book: '1', entry: '7', key: 'the innkeeper', as: 'name' } },
    ]);
});
