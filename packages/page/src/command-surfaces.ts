import { bindingParts } from '@pterror/interact-keybinds/binding-parts';
import { bound } from '@pterror/interact-keybinds/bound';
import { categoryHeaders } from '@pterror/interact-keybinds/category-headers';
import { cheatsheetKeys } from '@pterror/interact-keybinds/cheatsheet-keys';
import { cheatsheetRow } from '@pterror/interact-keybinds/cheatsheet-row';
import { cheatsheetTrigger } from '@pterror/interact-keybinds/cheatsheet-trigger';
import { contextMenu } from '@pterror/interact-keybinds/context-menu';
import { palette } from '@pterror/interact-keybinds/palette';
import { rebindKeys, rebindMouse } from '@pterror/interact-keybinds/rebind-inputs';
import { settings } from '@pterror/interact-keybinds/settings';
import type { Input } from '@pterror/interact-keybinds/settings';
import type { Strings } from '@pterror/interact-keybinds/strings';
import { cell } from '@pterror/interact-list/cell';
import { dismiss } from '@pterror/interact-list/dismiss';
import { groupMount } from '@pterror/interact-list/group-mount';
import { mark } from '@pterror/interact-list/mark';
import { popover } from '@pterror/interact-list/popover';
import { render } from '@pterror/interact-list/render';
import type { Command, Commands } from './commands.ts';
import type { FocusActions } from './focus-actions.ts';
import { keyStrings } from './key-strings.ts';

export type Anchor = { getBoundingClientRect(): { left: number; top: number; right: number; bottom: number } };

export type SurfaceOptions = {
    commands: Commands;
    focusActions: FocusActions;
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
function cheatsheetOver(
    commands: Commands,
    element: HTMLElement,
    open: ReturnType<typeof cell<boolean>>,
    strings: Strings,
) {
    let current = bound(commands.schema(), commands.overrides.get());
    const stopBindings = commands.watch(() => {
        current = bound(commands.schema(), commands.overrides.get());
    });
    const bindings = { get: () => current, watch: commands.watch };
    const keys = cheatsheetKeys({ bindings, open, strings });
    const headers = categoryHeaders({ categoryOf: keys.groupOf, drawn: keys, prefix: 'commandCheatsheet' });
    const rendered = render({
        create: (key) => headers.header(key) ?? document.createElement('div'),
        drawn: headers.drawn,
        facets: [
            cheatsheetRow({
                entryOf: (id) => bindings.get()[id],
                parts: (entry) => bindingParts(entry, undefined, strings),
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
 * keybinds' settings panel in an element, over the commands not hidden: rebinding, conflicts, reset. Made again when
 * the commands change, not when only their bindings do. The page's commands don't run while a binding is recorded.
 */
function keySettingsIn(commands: Commands, element: HTMLElement, strings: Strings): () => void {
    const recorded = (input: Input): Input => ({
        ...input,
        record: (options) => {
            const resume = commands.pause();
            const stop = input.record(options);
            return () => {
                stop();
                resume();
            };
        },
    });
    const inputs = [recorded(rebindKeys({ strings })), recorded(rebindMouse({ strings }))];
    let shown = '';
    let stop: () => void = () => undefined;
    const make = () => {
        const schema = commands.schema();
        const now = JSON.stringify(schema);
        if (now === shown) return;
        shown = now;
        stop();
        stop = settings({ element, inputs, overrides: commands.overrides, schema, strings });
    };
    make();
    const stopWatching = commands.watch(make);
    return () => {
        stopWatching();
        stop();
    };
}

/**
 * The palette, the right-click menu and the cheatsheet over the page's commands, and the commands that open the
 * palette and the cheatsheet
 */
export function commandSurfaces({ commands, focusActions, holdShowsKeys, t }: SurfaceOptions) {
    const strings = keyStrings(t);
    let paletteCommands = new Map<string, Command>();
    let menuCommands = new Map<string, Command>();
    const paletteElement = surface('commandPalette');
    const shown = palette({
        rest: 0,
        commands: () => {
            const list = commands
                .available()
                .filter((command) => command.id !== 'palette.open' && command.hidden !== true);
            paletteCommands = new Map(list.map((command) => [command.id, command]));
            return list;
        },
        row: (id, element) => {
            element.setAttribute('class', paletteCommands.get(id)?.className ?? '');
        },
        element: paletteElement,
        strings,
    });
    const menuElement = surface('commandMenu');
    const menu = contextMenu({
        element: menuElement,
        rest: 0,
        row: (id, element) => {
            element.setAttribute('class', menuCommands.get(id)?.className ?? '');
        },
        strings,
    });
    // Escape is taken here, so what Escape does under the surface (closing a drawer) doesn't also run
    const stopCancels = [
        focusActions.attach(paletteElement, {
            cancel: () => {
                shown.open.set(false);
            },
        }),
        focusActions.attach(menuElement, {
            cancel: () => {
                menu.close();
            },
        }),
    ];

    const sheetElement = surface('commandCheatsheet');
    // A list longer than the window scrolls, so the keyboard can reach it; opening it still moves no focus
    sheetElement.tabIndex = 0;
    sheetElement.setAttribute('role', 'region');
    sheetElement.setAttribute('aria-label', t('Keyboard shortcuts'));
    const sheetOpen = cell(false);
    const stopSheet = cheatsheetOver(commands, sheetElement, sheetOpen, strings);
    // Its trigger listens nowhere while holding the modifier isn't to show it
    const quiet = document.createElement('div');
    let stopTrigger: () => void = () => undefined;
    const makeTrigger = () => {
        stopTrigger();
        stopTrigger = cheatsheetTrigger({
            delay: 250,
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
            menuCommands = new Map(list.map((command) => [command.id, command]));
            menu.openAt(anchor, list);
        },
        /** Shows the key settings in an element, until the returned function is called */
        keySettings: (element: HTMLElement) => keySettingsIn(commands, element, strings),
        /** Takes in a change to whether holding the modifier shows the cheatsheet */
        holdChanged: makeTrigger,
        stop() {
            for (const stopCancel of stopCancels) stopCancel();
            stopCommands();
            stopClose();
            stopTrigger();
            stopSheet();
            shown.stop();
            menu.stop();
        },
    };
}
