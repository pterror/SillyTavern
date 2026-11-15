import { afterEach, expect, test } from 'vite-plus/test';
import { createCommands } from '../src/commands.ts';
import type { Overrides } from '../src/commands.ts';

const taken: (() => void)[] = [];
afterEach(() => {
    for (const take of taken.splice(0)) take();
    document.body.replaceChildren();
});

function press(key: string, init: KeyboardEventInit = {}, at: EventTarget = document.body) {
    const event = new KeyboardEvent('keydown', {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true,
        cancelable: true,
        ...init,
    });
    at.dispatchEvent(event);
    return event;
}

test('a registered command runs from its key while it applies, and is listed once by id', () => {
    const commands = createCommands();
    const ran: string[] = [];
    let applies = true;
    taken.push(
        commands.register([
            {
                id: 'chat.send',
                label: 'Send',
                category: 'Chat',
                keys: ['Enter'],
                run: () => void ran.push('send'),
                when: () => applies,
            },
        ]),
        commands.register([{ id: 'chat.send', label: 'Send again', category: 'Chat', run: () => undefined }]),
    );
    expect(press('Enter').defaultPrevented).toBe(true);
    applies = false;
    expect(press('Enter').defaultPrevented).toBe(false);
    expect(ran).toEqual(['send']);
    expect(commands.all().map((command) => command.label)).toEqual(['Send']);
    expect(commands.available().map((command) => command.label)).toEqual(['Send again']);
});

test("the person's bindings replace a command's own, and are kept where the page keeps them", () => {
    const commands = createCommands();
    const ran: string[] = [];
    let saved: Overrides = {};
    const storage = { load: () => saved, save: (next: Overrides) => void (saved = next) };
    commands.keepBindingsIn(storage);
    taken.push(
        commands.register([
            { id: 'chat.stop', label: 'Stop', category: 'Chat', keys: ['Escape'], run: () => void ran.push('stop') },
        ]),
    );
    commands.keepBindingsIn(storage);
    const before = commands.all()[0];
    expect(before?.keys).toEqual(['Escape']);
    commands.keepBindingsIn({ ...storage, load: () => ({ 'chat.stop': { keys: ['ctrl+period'] } }) });
    press('Escape');
    press('.', { code: 'Period', ctrlKey: true });
    expect(ran).toEqual(['stop']);
    expect(commands.all()[0]?.keys).toEqual(['ctrl+period']);
    expect(commands.schema()['chat.stop']?.keys).toEqual(['Escape']);
});

test('a command bound on an element is offered only while focus is inside it', () => {
    const commands = createCommands();
    const field = document.createElement('input');
    const other = document.createElement('button');
    document.body.append(field, other);
    taken.push(
        commands.register(
            [{ id: 'field.confirm', label: 'Confirm', category: 'Fields', keys: ['Enter'], run: () => undefined }],
            { target: field },
        ),
    );
    other.focus();
    expect(commands.available()).toEqual([]);
    field.focus();
    expect(commands.available().map((command) => command.id)).toEqual(['field.confirm']);
});

test('bindings two commands share are reported', () => {
    const commands = createCommands();
    taken.push(
        commands.register([
            { id: 'chat.stop', label: 'Stop', category: 'Chat', keys: ['Escape'], run: () => undefined },
            { id: 'drawer.close', label: 'Close', category: 'Panels', keys: ['Escape'], run: () => undefined },
            { id: 'palette.open', label: 'Commands', category: 'General', keys: ['$mod+k'], run: () => undefined },
        ]),
    );
    expect(commands.conflicts()).toEqual([{ binding: 'keys:escape', ids: ['chat.stop', 'drawer.close'] }]);
});

test('a hidden command runs from its key, and is left out of the schema but not out of the conflicts', () => {
    const commands = createCommands();
    const ran: string[] = [];
    taken.push(
        commands.register([
            { id: 'chat.stop', label: 'Stop', category: 'Chat', keys: ['Escape'], run: () => void ran.push('stop') },
            {
                id: 'sheet.close',
                label: 'Close',
                category: 'General',
                keys: ['Escape'],
                hidden: true,
                run: () => void ran.push('close'),
            },
        ]),
    );
    expect(Object.keys(commands.schema())).toEqual(['chat.stop']);
    expect(commands.conflicts()).toEqual([{ binding: 'keys:escape', ids: ['chat.stop', 'sheet.close'] }]);
    taken.push(
        commands.register([
            {
                id: 'tabs.keep',
                label: 'Keep',
                category: 'Editing',
                keys: ['Home'],
                hidden: true,
                run: () => void ran.push('keep'),
            },
        ]),
    );
    press('Home');
    expect(ran).toEqual(['keep']);
});

test('while paused no command runs from its keys, and it runs again once every pause ends', () => {
    const commands = createCommands();
    let ran = 0;
    taken.push(
        commands.register([
            { id: 'chat.stop', label: 'Stop', category: 'Chat', keys: ['Escape'], run: () => void ran++ },
        ]),
    );
    const first = commands.pause();
    const second = commands.pause();
    press('Escape');
    first();
    first();
    press('Escape');
    expect(ran).toBe(0);
    second();
    press('Escape');
    expect(ran).toBe(1);
});
