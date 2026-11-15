import { cheatsheet } from '@pterror/interact-keybinds/cheatsheet';
import { contextMenu } from '@pterror/interact-keybinds/context-menu';
import { palette } from '@pterror/interact-keybinds/palette';
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
 * The palette, the right-click menu and the cheatsheet over the page's commands, and the commands that open the
 * palette and the cheatsheet
 */
export function commandSurfaces({ commands, holdShowsKeys, t }: SurfaceOptions) {
    const shown = palette({
        commands: () => commands.available().filter((command) => command.id !== 'palette.open'),
        element: surface('commandPalette'),
        label: t('Commands'),
        placeholder: t('Type a command'),
    });
    const menu = contextMenu({ element: surface('commandMenu'), label: t('Actions') });

    const sheetElement = surface('commandCheatsheet');
    // Its trigger listens nowhere while holding the modifier isn't to show it
    const quiet = document.createElement('div');
    let sheet: ReturnType<typeof cheatsheet> | undefined;
    const makeSheet = () => {
        sheet?.stop();
        sheetElement.replaceChildren();
        sheet = cheatsheet({
            applies: (id) => commands.available().some((command) => command.id === id),
            element: sheetElement,
            overrides: commands.overrides,
            schema: commands.schema(),
            target: holdShowsKeys() ? globalThis : quiet,
        });
    };
    makeSheet();
    const stopWatching = commands.watch(makeSheet);

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
                sheet?.open.set(true);
            },
        },
    ]);

    return {
        palette: shown.open,
        /** Opens the menu with these commands below the anchor; with none that apply it opens nothing */
        openMenu: (anchor: Anchor, list: readonly Command[]) => {
            menu.openAt(anchor, list);
        },
        /** Takes in a change to whether holding the modifier shows the cheatsheet */
        holdChanged: makeSheet,
        stop() {
            stopCommands();
            stopWatching();
            sheet?.stop();
            shown.stop();
            menu.stop();
        },
    };
}
