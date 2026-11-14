import { createSignal, onCleanup, onMount } from 'solid-js';
import { PICKED_AT_MOST } from '../protocol.ts';
import type { SelectionView } from '../protocol.ts';
import type { Wb } from './context.ts';

type Selected = Extract<SelectionView, { book: string }>;

export type Picking = {
    isSelected(entry: string): boolean;
    // Whether the checkboxes stay shown: something is selected, or taps select.
    showing(): boolean;
    // Select mode: a tap on an entry selects it instead of opening it.
    selecting(): boolean;
    setSelecting(on: boolean): void;
    // Pressing an entry's checkbox: Shift picks the run from the last one picked; else dragging over other boxes
    // picks the run dragged over, as the first box goes.
    press(entry: string, event: PointerEvent): void;
    enter(entry: string): void;
    // A click on an entry: with Shift picks the run from the last one picked, with Ctrl/Cmd or in select mode toggles
    // it. True when it picked, and the entry isn't to open.
    click(entry: string, event: MouseEvent): boolean;
};

const editable = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    target.closest(
        'input:not([type="checkbox"], [type="radio"], [type="button"]), textarea, select, [contenteditable="true"], .cm-editor',
    ) !== null;

// Picks entries, rows or cards alike, in the order they are drawn (each drawn entry is a `[data-pick]` element in
// `list`): each gesture is one action. While `active`, Ctrl/Cmd+A selects all the matching entries and Escape clears.
export function picking(
    wb: Wb,
    book: () => string,
    selection: () => Selected | null,
    list: () => HTMLElement | undefined,
    active: () => boolean,
): Picking {
    let anchor: string | null = null;
    let run: { from: string; to: string; selected: boolean } | null = null;
    const [selecting, setSelecting] = createSignal(false);
    const isSelected = (entry: string) => {
        const shown = selection();
        if (!shown) return false;
        return shown.base === 'none' ? shown.except.includes(entry) : !shown.except.includes(entry);
    };
    const any = () => {
        const shown = selection();
        return shown !== null && (shown.base === 'matching' || shown.except.length > 0);
    };
    const items = () => [...(list()?.querySelectorAll<HTMLElement>('[data-pick]') ?? [])];
    const between = (from: string, to: string): string[] => {
        const order = [...new Set(items().map((item) => item.dataset['pick'] ?? ''))];
        const [a, b] = [order.indexOf(from), order.indexOf(to)];
        if (a < 0 || b < 0) return [to];
        return order.slice(Math.min(a, b), Math.max(a, b) + 1);
    };
    const mark = () => {
        const picked = new Set(run ? between(run.from, run.to) : []);
        for (const item of items()) item.classList.toggle('wb-run', picked.has(item.dataset['pick'] ?? ''));
    };
    const send = (entries: string[], selected: boolean) => {
        const unique = [...new Set(entries)].slice(0, PICKED_AT_MOST);
        if (unique.length > 0) void wb.act('worldbuilding.select', { book: book(), entries: unique, selected });
    };
    const release = () => {
        if (!run) return;
        const { from, to, selected } = run;
        run = null;
        mark();
        send(between(from, to), selected);
    };
    const keys = (event: KeyboardEvent) => {
        if (!active() || editable(event.target) || document.querySelector('dialog[open]')) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            void wb.act('worldbuilding.selectAllMatching', { book: book() });
        } else if (event.key === 'Escape' && !event.defaultPrevented && (any() || selecting())) {
            setSelecting(false);
            if (any()) void wb.act('worldbuilding.selectNone', { book: book() });
        }
    };
    onMount(() => {
        window.addEventListener('pointerup', release);
        window.addEventListener('keydown', keys);
        onCleanup(() => {
            window.removeEventListener('pointerup', release);
            window.removeEventListener('keydown', keys);
        });
    });
    return {
        isSelected,
        showing: () => any() || selecting(),
        selecting,
        setSelecting,
        press: (entry, event) => {
            event.preventDefault();
            const selected = !isSelected(entry);
            if (event.shiftKey && anchor !== null) {
                send(between(anchor, entry), isSelected(anchor));
                anchor = entry;
                return;
            }
            anchor = entry;
            run = { from: entry, to: entry, selected };
            mark();
        },
        enter: (entry) => {
            if (!run) return;
            run = { ...run, to: entry };
            mark();
        },
        click: (entry, event) => {
            if (event.shiftKey) {
                send(anchor === null ? [entry] : between(anchor, entry), anchor === null || isSelected(anchor));
            } else if (event.ctrlKey || event.metaKey || selecting()) {
                send([entry], !isSelected(entry));
            } else return false;
            anchor = entry;
            event.preventDefault();
            return true;
        },
    };
}
