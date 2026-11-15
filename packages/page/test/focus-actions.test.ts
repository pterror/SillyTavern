import { afterEach, expect, test } from 'vite-plus/test';
import { testCommands } from '../src/focus-actions.ts';

afterEach(() => {
    document.body.replaceChildren();
});

function press(key: string, at: Element) {
    const event = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
    at.dispatchEvent(event);
    return event;
}

test("Enter and Escape run the focused field's own Confirm and Cancel, found from the field outward", () => {
    const { commands, focusActions } = testCommands();
    const form = document.createElement('div');
    const field = document.createElement('input');
    form.append(field);
    document.body.append(form);
    const ran: string[] = [];
    focusActions.attach(form, { cancel: () => void ran.push('cancel') });
    const detach = focusActions.attach(field, { confirm: () => void ran.push('confirm') });
    field.focus();
    expect(commands.available().map((command) => command.id)).toEqual(['focus.confirm', 'focus.cancel']);
    expect(press('Enter', field).defaultPrevented).toBe(true);
    press('Escape', field);
    expect(ran).toEqual(['confirm', 'cancel']);
    detach();
    expect(press('Enter', field).defaultPrevented).toBe(false);
});

test("an element's actions apply only while its `when` holds, and an action returning false leaves the key", () => {
    const { focusActions } = testCommands();
    const field = document.createElement('input');
    document.body.append(field);
    let applies = false;
    focusActions.attach(field, { confirm: () => false, cancel: () => undefined, when: () => applies });
    field.focus();
    expect(press('Escape', field).defaultPrevented).toBe(false);
    applies = true;
    expect(press('Escape', field).defaultPrevented).toBe(true);
    expect(press('Enter', field).defaultPrevented).toBe(false);
});
