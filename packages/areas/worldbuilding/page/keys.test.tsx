import { render } from 'solid-js/web';
import { expect, test } from 'vite-plus/test';
import type { Client } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import { testCommands } from '@st/page/focus-actions';
import type { OpenEntryView } from '../protocol.ts';
import { WbProvider } from './context.ts';
import type { Wb } from './context.ts';
import { Names, Triggers } from './Keys.tsx';

const ENTRY: OpenEntryView = {
    book: '1',
    entry: '7',
    deleted: false,
    entryKey: '7',
    version: '3',
    label: { thing: '7', text: 'Ilse Varro', shownAs: 'name' },
    picture: null,
    title: 'Ilse Varro',
    keys: [
        { text: 'Ilse Varro', isName: true, alsoBringsUp: 0 },
        { text: 'ledger', isName: false, alsoBringsUp: 1 },
        { text: '/lamp(s|ed)?/i', isName: false, alsoBringsUp: 0 },
    ],
    text: '',
    links: [],
    linksComplete: true,
    relations: [],
    placement: {
        constant: false,
        disable: false,
        keysecondary: [],
        selectiveLogic: 0,
    } as unknown as OpenEntryView['placement'],
    placementDiffersFromDefaults: false,
    tokens: 96,
    characterFilter: { exclude: false, characters: [], tags: [], more: 0 },
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
        edit: async (type, payload) => {
            sent.push({ type, payload });
            return { done: 'saved', text: null };
        },
        layout: () => ({ regionsByNestingLevel: [], cardTextCharacters: 0 }),
        firstRead: () => ({ layout: { regionsByNestingLevel: [], cardTextCharacters: 0 }, ahead: 1 }),
        pointingAt: () => ({ endRank: 1, layout: { regionsByNestingLevel: [], cardTextCharacters: 0 } }),
        open: () => {},
        say: () => {},
        offerUndo: () => {},
        drag: { press: () => {}, moves: () => false, clickIsDrop: () => false, held: () => null },
    };
    const host = document.createElement('div');
    document.body.append(host);
    render(
        () => (
            <UiProvider value={{ client, ...testCommands(), t: (text) => text }}>
                <WbProvider value={wb}>
                    <Names entry={entry} />
                    <Triggers entry={entry} />
                </WbProvider>
            </UiProvider>
        ),
        host,
    );
    return { host, sent };
}

const button = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll('button')].find((found) => found.textContent.includes(label)) as HTMLButtonElement;
const labelled = (host: HTMLElement, label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement;
const type = (field: HTMLInputElement, text: string) => {
    field.value = text;
    field.dispatchEvent(new Event('input'));
};
const press = (field: HTMLElement, key: string) => field.dispatchEvent(new KeyboardEvent('keydown', { key }));

test('names are drawn in the entry’s look under “Also called”, triggers plain under “Triggers”, and a key shared with others says how many', () => {
    const { host } = stand(ENTRY);
    const [names, triggers] = [...host.querySelectorAll('.wb-keys')] as HTMLElement[];
    expect(names?.querySelector('.wb-keys-label')?.textContent).toBe('Also called');
    expect([...(names?.querySelectorAll('.wb-key') ?? [])].map((key) => key.getAttribute('aria-label'))).toEqual([
        '“Ilse Varro”, name',
    ]);
    expect(names?.querySelector('.named-name.look-7')?.textContent).toBe('Ilse Varro');
    expect(triggers?.querySelector('.wb-keys-label')?.textContent).toBe('Triggers');
    expect([...(triggers?.querySelectorAll('.wb-key') ?? [])].map((key) => key.getAttribute('aria-label'))).toEqual([
        '“ledger”, trigger',
        '“/lamp(s|ed)?/i”, trigger',
    ]);
    expect(triggers?.querySelector('.wb-key-more')?.textContent).toBe('· 2 entries');
    expect(triggers?.querySelectorAll('.wb-pattern').length).toBe(1);
    expect(host.querySelector('.wb-always')).toBe(null);
});

test('a key shared with other entries asks who they are when clicked; moving it between names and triggers sends one action', () => {
    const { host, sent } = stand(ENTRY);
    labelled(host, '“ledger”, trigger').click();
    expect(sent).toEqual([{ type: 'worldbuilding.showKeySharers', payload: { book: '1', entry: '7', key: 'ledger' } }]);
    button(host, 'Make it a name').click();
    expect(sent.at(-1)).toEqual({
        type: 'worldbuilding.setKeyAs',
        payload: { book: '1', entry: '7', version: '3', key: 'ledger', as: 'name' },
    });
});

test('a pattern can’t be made a name from its menu', () => {
    const { host } = stand(ENTRY);
    labelled(host, '“/lamp(s|ed)?/i”, trigger').click();
    expect(button(host, 'Make it a name')).toBe(undefined);
    expect(button(host, 'Remove')).not.toBe(undefined);
});

test('“+” on the names takes the words typed and adds them as a name on Enter', () => {
    const { host, sent } = stand(ENTRY);
    labelled(host, 'Add name').click();
    const field = host.querySelector('input') as HTMLInputElement;
    type(field, 'the innkeeper');
    press(field, 'Enter');
    expect(sent.at(-1)).toEqual({
        type: 'worldbuilding.addKeys',
        payload: { book: '1', entry: '7', version: '3', keys: ['the innkeeper'], as: 'name' },
    });
});

test('several keys typed or pasted are added in one action, a comma inside a pattern kept', () => {
    const { host, sent } = stand(ENTRY);
    labelled(host, 'Add trigger').click();
    const field = host.querySelector('input') as HTMLInputElement;
    type(field, 'a, b,\nc, /x{1,2}/i, ledger');
    press(field, 'Enter');
    expect(sent.filter((one) => one.type === 'worldbuilding.addKeys')).toEqual([
        {
            type: 'worldbuilding.addKeys',
            payload: { book: '1', entry: '7', version: '3', keys: ['a', 'b', 'c', '/x{1,2}/i'], as: 'trigger' },
        },
    ]);
});

test('a key is edited in place: Enter renames it, Escape leaves it', () => {
    const { host, sent } = stand(ENTRY);
    labelled(host, '“ledger”, trigger').click();
    sent.length = 0;
    const field = host.querySelector('input') as HTMLInputElement;
    expect(field.value).toBe('ledger');
    type(field, '  ledgers ');
    expect(sent).toEqual([{ type: 'worldbuilding.suggestKeys', payload: { book: '1', typed: 'ledgers ' } }]);
    sent.length = 0;
    press(field, 'Enter');
    expect(sent).toEqual([
        {
            type: 'worldbuilding.renameKey',
            payload: { book: '1', entry: '7', version: '3', key: 'ledger', to: 'ledgers' },
        },
    ]);
    expect(host.querySelector('input')).toBe(null);
    labelled(host, '“ledger”, trigger').click();
    sent.length = 0;
    const again = host.querySelector('input') as HTMLInputElement;
    type(again, 'other');
    sent.length = 0;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(sent).toEqual([]);
    expect(labelled(host, '“ledger”, trigger')).not.toBe(null);
});

test('secondary keys are chips after their logic, edited and added with the placement’s one action', () => {
    const { host, sent } = stand({
        ...ENTRY,
        placement: { ...ENTRY.placement, keysecondary: ['harbour', 'quay'], selectiveLogic: 2 },
    });
    const triggers = host.querySelectorAll('.wb-keys')[1] as HTMLElement;
    expect(triggers.querySelector('.wb-tok')?.textContent).toBe('None of');
    labelled(host, '“harbour”, secondary trigger').click();
    const field = host.querySelector('input') as HTMLInputElement;
    type(field, 'port');
    press(field, 'Enter');
    expect(sent.at(-1)).toEqual({
        type: 'worldbuilding.setPlacement',
        payload: { book: '1', entry: '7', version: '3', fields: { keysecondary: ['port', 'quay'], selective: true } },
    });
    labelled(host, 'Add secondary trigger').click();
    const added = host.querySelector('input') as HTMLInputElement;
    type(added, 'dock, pier');
    press(added, 'Enter');
    expect(sent.at(-1)).toEqual({
        type: 'worldbuilding.setPlacement',
        payload: {
            book: '1',
            entry: '7',
            version: '3',
            fields: { keysecondary: ['harbour', 'quay', 'dock', 'pier'], selective: true },
        },
    });
});

test('without secondary keys the row offers “+ Secondary”; a constant entry says so and can be made normal', () => {
    const { host, sent } = stand(ENTRY);
    expect(button(host, '+ Secondary')).not.toBe(undefined);
    expect(host.querySelector('.wb-tok')).toBe(null);
    host.remove();
    const constant = stand({ ...ENTRY, placement: { ...ENTRY.placement, constant: true } });
    expect(constant.host.querySelector('.wb-always')?.textContent).toBe('Constant · 96 tokens');
    expect(constant.host.querySelectorAll('.wb-triggers .wb-key').length).toBe(0);
    button(constant.host, 'Make normal').click();
    expect(constant.sent).toEqual([
        {
            type: 'worldbuilding.setPlacement',
            payload: { book: '1', entry: '7', version: '3', fields: { constant: false } },
        },
    ]);
    expect(sent).toEqual([]);
});
