import { createContext, useContext } from 'solid-js';
import type { Client } from './client.ts';
import type { Commands } from './commands.ts';
import type { FocusActions } from './focus-actions.ts';

export type Ui = {
    client: Client;
    commands: Commands;
    focusActions: FocusActions;
    t: (text: string, key?: string) => string;
};

const UiContext = createContext<Ui>();

export const UiProvider = UiContext;

export function useUi(): Ui {
    return useContext(UiContext);
}
