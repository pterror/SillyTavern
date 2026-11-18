import { render } from '@solidjs/web';
import { expect, test } from 'vite-plus/test';
import type { Client } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import { testCommands } from '@st/page/focus-actions';
import type { CharacterFilterShown } from '../protocol.ts';
import { CharacterFilterSentence } from './CharacterFilter.tsx';

const client: Client = {
    send: async () => ({ ok: true }),
    view: () => () => undefined,
    receive: () => {},
    reconnected: async () => {},
    reread: async () => {},
    version: () => 0,
};

test("a filter's tag is drawn by the name renderer, by its thing; one this user has no tag for by its key", () => {
    const filter: CharacterFilterShown = {
        exclude: false,
        characters: [],
        tags: [
            { key: 'a1', named: { thing: '42', text: 'Rogue', shownAs: 'name' } },
            { key: 'gone-key', named: null },
        ],
        more: 0,
    };
    const host = document.createElement('div');
    document.body.append(host);
    const dispose = render(
        () => (
            <UiProvider value={{ client, ...testCommands(), t: (text) => text }}>
                <CharacterFilterSentence filter={filter} adding={false} onChange={() => {}} onAdding={() => {}} />
            </UiProvider>
        ),
        host,
    );
    const chips = [...host.querySelectorAll('.wb-filter-item .wb-key-trigger')];
    expect(chips.map((chip) => chip.textContent)).toEqual(['Tag: Rogue', 'Tag: gone-key']);
    const name = chips[0]?.querySelector('.named');
    expect(name?.getAttribute('data-thing')).toBe('42');
    expect(name?.classList.contains('look-42')).toBe(true);
    expect(chips[1]?.querySelector('.named')).toBeNull();
    dispose();
    host.remove();
});
