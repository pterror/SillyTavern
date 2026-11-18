import { render } from '@solidjs/web';
import { expect, test } from 'vite-plus/test';
import type { Client } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import { testCommands } from '@st/page/focus-actions';
import type { HoverCard } from '../protocol.ts';
import { EntryContent } from './EntryContent.tsx';

const client: Client = {
    send: async () => ({ ok: true }),
    view: () => () => undefined,
    receive: () => {},
    reconnected: async () => {},
    reread: async () => {},
    version: () => 0,
};

test('entry previews include aliases, trigger keys, a distinct title, and the complete multiline body', () => {
    const text = `${'Long entry text. '.repeat(100)}\n\nFinal paragraph.`;
    const entry: HoverCard = {
        book: '1',
        entry: '7',
        label: { thing: '7', text: 'Ilse', shownAs: 'name' },
        title: 'Keeper of the lamp',
        picture: null,
        keys: [
            { text: 'Ilse', isName: true, alsoBringsUp: 0 },
            { text: 'ledger', isName: false, alsoBringsUp: 0 },
        ],
        placement: null,
        text,
        relations: [],
        moreRelations: 0,
        textCut: false,
        broughtUpBy: null,
    };
    const host = document.createElement('div');
    const dispose = render(
        () => (
            <UiProvider value={{ client, ...testCommands(), t: (text) => text }}>
                <EntryContent entry={entry} />
            </UiProvider>
        ),
        host,
    );
    expect(host.querySelector('.wb-entry-caption')?.textContent).toBe('Keeper of the lamp');
    expect(host.textContent).toContain('Also calledIlse');
    expect(host.textContent).toContain('Triggersledger');
    expect(host.querySelector('.wb-entry-readonly')?.textContent).toBe(text);
    expect(host.querySelector('input, textarea, button')).toBeNull();
    dispose();
});
