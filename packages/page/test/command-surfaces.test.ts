import { afterEach, expect, test, vi } from 'vite-plus/test';
import { commandSurfaces } from '../src/command-surfaces.ts';
import { createCommands } from '../src/commands.ts';
import type { Command } from '../src/commands.ts';
import { createFocusActions } from '../src/focus-actions.ts';

const stops: (() => void)[] = [];
afterEach(() => {
    for (const stop of stops.splice(0).reverse()) stop();
    vi.useRealTimers();
    document.body.replaceChildren();
});

function setup() {
    const commands = createCommands();
    const surfaces = commandSurfaces({
        commands,
        focusActions: createFocusActions(commands, (text) => text),
        holdShowsKeys: () => true,
        t: (text) => text,
    });
    stops.push(() => surfaces.stop());
    return { commands, surfaces };
}

const remove: Command = {
    id: 'remove',
    label: 'Remove',
    category: 'Test',
    className: 'command-danger',
    run: () => undefined,
};

test('menu row classes follow command metadata, including disabled rows and reopening with a new style', () => {
    const { surfaces } = setup();
    surfaces.openMenu(document.body, [{ ...remove, when: () => false }]);
    expect(document.querySelector('[role="menuitem"].command-danger')?.getAttribute('aria-disabled')).toBe('true');
    surfaces.openMenu(document.body, [{ ...remove, className: 'custom-style' }]);
    expect(document.querySelector('[role="menuitem"].custom-style')).not.toBeNull();
    expect(document.querySelector('[role="menuitem"].command-danger')).toBeNull();
});

test('palette row classes follow command metadata too', () => {
    const { commands, surfaces } = setup();
    stops.push(commands.register([remove]));
    surfaces.palette.set(true);
    expect(document.querySelector('[role="option"].command-danger')?.textContent).toContain('Remove');
});

test('moving over a menu row highlights it without waiting for pointer rest', () => {
    vi.useFakeTimers();
    const { surfaces } = setup();
    surfaces.openMenu(document.body, [{ ...remove, id: 'first' }, remove]);
    const rows = document.querySelectorAll('[role="menuitem"]');
    rows[1]!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    vi.advanceTimersByTime(1);
    expect(rows[1]!.hasAttribute('data-active')).toBe(true);
    expect(rows[0]!.hasAttribute('data-active')).toBe(false);
});

test('holding the modifier opens shortcuts after 250 ms and releasing it closes them', () => {
    vi.useFakeTimers();
    setup();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    vi.advanceTimersByTime(249);
    expect(document.querySelector('.commandCheatsheet')?.matches(':popover-open')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(document.querySelector('.commandCheatsheet')?.matches(':popover-open')).toBe(true);
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
    expect(document.querySelector('.commandCheatsheet')?.matches(':popover-open')).toBe(false);
});
