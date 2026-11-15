import { bindingParts } from '@pterror/interact-keybinds/binding-parts';
import { bound } from '@pterror/interact-keybinds/bound';
import { categoryHeaders } from '@pterror/interact-keybinds/category-headers';
import { cheatsheetKeys } from '@pterror/interact-keybinds/cheatsheet-keys';
import { cheatsheetRow } from '@pterror/interact-keybinds/cheatsheet-row';
import { cheatsheetTrigger } from '@pterror/interact-keybinds/cheatsheet-trigger';
import { contextMenu } from '@pterror/interact-keybinds/context-menu';
import { palette } from '@pterror/interact-keybinds/palette';
import { cell } from '@pterror/interact-list/cell';
import { dismiss } from '@pterror/interact-list/dismiss';
import { groupMount } from '@pterror/interact-list/group-mount';
import { mark } from '@pterror/interact-list/mark';
import { popover } from '@pterror/interact-list/popover';
import { render } from '@pterror/interact-list/render';
import type { Command, Commands } from './commands.ts';

export type Anchor = { getBoundingClientRect(): { left: number; top: number; right: number; bottom: number } };

export type SurfaceOptions = {
    commands: Commands;
    t: (text: string) => string;
    /** Whether holding Ctrl (Cmd on a Mac) shows the cheatsheet */
    holdShowsKeys: () => boolean;
};

// The class the app frames floating surfaces with (public/style.css)
const FLOATING = 'st-floating';

function surface(name: string): HTMLElement {
    const element = document.createElement('div');
    element.popover = 'manual';
    element.classList.add(FLOATING, name);
    document.body.append(element);
    return element;
}

/**
 * The cheatsheet: every binding in effect by category, those that don't apply now `aria-disabled`, a manual popover
 * centred on the window while `open` holds. It never takes focus, so the page's bindings keep running while it shows
 * (a shortcut pressed with the modifier still held). A press outside or an Escape nothing took closes it.
 */
function cheatsheetOver(commands: Commands, element: HTMLElement, open: ReturnType<typeof cell<boolean>>) {
    let current = bound(commands.schema(), commands.overrides.get());
    const stopBindings = commands.watch(() => {
        current = bound(commands.schema(), commands.overrides.get());
    });
    const bindings = { get: () => current, watch: commands.watch };
    const keys = cheatsheetKeys({ bindings, open });
    const headers = categoryHeaders({ categoryOf: keys.groupOf, drawn: keys, prefix: 'commandCheatsheet' });
    const rendered = render({
        create: (key) => headers.header(key) ?? document.createElement('div'),
        drawn: headers.drawn,
        facets: [
            cheatsheetRow({
                entryOf: (id) => bindings.get()[id],
                parts: (entry) => bindingParts(entry),
                watch: bindings.watch,
            }),
            mark({
                attribute: 'aria-disabled',
                on: 'true',
                test: {
                    has: (key) =>
                        typeof key === 'string' && !commands.available().some((command) => command.id === key),
                    watch: () => () => undefined,
                },
            }),
        ],
        mount: groupMount({ container: element, groupOf: headers.groupOf, labelIdOf: headers.labelIdOf }),
    });
    const viewport = {
        getBoundingClientRect: () => ({ bottom: window.innerHeight, left: 0, right: window.innerWidth, top: 0 }),
    };
    const stops = [
        stopBindings,
        rendered.stop,
        popover({ anchor: viewport, element, open, side: 'center' }),
        dismiss({ elements: [element], to: open.set }),
    ];
    return () => {
        for (const stop of stops) stop();
    };
}

/**
 * The palette, the right-click menu and the cheatsheet over the page's commands, and the commands that open the
 * palette and the cheatsheet
 */
export function commandSurfaces({ commands, holdShowsKeys, t }: SurfaceOptions) {
    const shown = palette({
        commands: () =>
            commands.available().filter((command) => command.id !== 'palette.open' && command.hidden !== true),
        element: surface('commandPalette'),
        label: t('Commands'),
        placeholder: t('Type a command'),
    });
    const menu = contextMenu({ element: surface('commandMenu'), label: t('Actions') });

    const sheetElement = surface('commandCheatsheet');
    const sheetOpen = cell(false);
    const stopSheet = cheatsheetOver(commands, sheetElement, sheetOpen);
    // Its trigger listens nowhere while holding the modifier isn't to show it
    const quiet = document.createElement('div');
    let stopTrigger: () => void = () => undefined;
    const makeTrigger = () => {
        stopTrigger();
        stopTrigger = cheatsheetTrigger({
            open: sheetOpen,
            target: holdShowsKeys() ? globalThis : quiet,
            to: sheetOpen.set,
        });
    };
    makeTrigger();

    const stopCommands = commands.register([
        {
            category: t('General'),
            id: 'palette.open',
            keys: ['$mod+k', '$mod+shift+p'],
            label: t('Command palette'),
            run: () => {
                shown.open.set(true);
            },
            typing: true,
        },
        {
            category: t('General'),
            id: 'keys.show',
            keys: ['shift+slash'],
            label: t('Keyboard shortcuts'),
            run: () => {
                sheetOpen.set(true);
            },
        },
    ]);
    // Before the page's own Escape (a drawer's, a field's): with the cheatsheet open, Escape closes only it
    const stopClose = commands.register(
        [
            {
                category: t('General'),
                hidden: true,
                id: 'keys.hide',
                keys: ['Escape'],
                label: t('Close keyboard shortcuts'),
                run: () => {
                    sheetOpen.set(false);
                },
                typing: true,
                when: () => sheetOpen.get(),
            },
        ],
        { capture: true },
    );

    return {
        palette: shown.open,
        /** Opens the menu with these commands below the anchor; with none that apply it opens nothing */
        openMenu: (anchor: Anchor, list: readonly Command[]) => {
            menu.openAt(anchor, list);
        },
        /** Takes in a change to whether holding the modifier shows the cheatsheet */
        holdChanged: makeTrigger,
        stop() {
            stopCommands();
            stopClose();
            stopTrigger();
            stopSheet();
            shown.stop();
            menu.stop();
        },
    };
}
