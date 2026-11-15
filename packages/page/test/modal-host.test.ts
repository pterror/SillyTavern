import { afterEach, expect, test } from 'vite-plus/test';
import { hostPopoversInModals } from '../src/layers/popover.ts';

const stops: (() => void)[] = [];
afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    document.body.replaceChildren();
});

function page() {
    stops.push(hostPopoversInModals(document));
    const home = document.createElement('div');
    const before = document.createElement('span');
    const popover = document.createElement('div');
    popover.popover = 'manual';
    const after = document.createElement('span');
    home.append(before, popover, after);
    document.body.append(home);
    return { home, popover };
}

function modal() {
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a popover shown with no modal open stays where it is', () => {
    const { home, popover } = page();
    popover.showPopover();
    expect(popover.parentNode).toBe(home);
});

test('a popover shown while a modal is open is shown inside it, and goes back to its place when it closes', () => {
    const { home, popover } = page();
    const dialog = modal();
    popover.showPopover();
    expect(popover.parentNode).toBe(dialog);
    expect(popover.matches(':popover-open')).toBe(true);
    popover.hidePopover();
    expect(popover.parentNode).toBe(home);
    expect([...home.children].indexOf(popover)).toBe(1);
});

test('it goes into the modal opened last, and one already inside a modal stays where it is', () => {
    const { popover } = page();
    modal();
    const top = modal();
    popover.showPopover();
    expect(popover.parentNode).toBe(top);
    const own = document.createElement('div');
    own.popover = 'manual';
    top.append(own);
    own.showPopover();
    expect(own.parentNode).toBe(top);
});

test('a modal that closes or leaves the page gives the popover back to its place, shown again', async () => {
    const { home, popover } = page();
    const dialog = modal();
    popover.showPopover();
    dialog.close();
    dialog.dispatchEvent(new Event('close'));
    expect(popover.parentNode).toBe(home);
    expect(popover.matches(':popover-open')).toBe(true);

    const gone = modal();
    popover.hidePopover();
    popover.showPopover();
    expect(popover.parentNode).toBe(gone);
    gone.remove();
    await flush();
    expect(popover.parentNode).toBe(home);
    expect(popover.matches(':popover-open')).toBe(true);
});

test('a popover its owner takes out of the modal is not put back', async () => {
    const { home, popover } = page();
    const dialog = modal();
    popover.showPopover();
    popover.remove();
    await flush();
    dialog.close();
    dialog.dispatchEvent(new Event('close'));
    expect(popover.isConnected).toBe(false);
    expect(home.contains(popover)).toBe(false);
});
