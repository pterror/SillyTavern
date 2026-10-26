import { createContext, useContext } from 'solid-js';
import type { Client } from './client.ts';

/** What every surface of the new page works with: the client, and the user's language. */
export type Ui = {
    client: Client;
    /** The text in the user's language: the old page's translation under `key`, or under the English text. */
    t: (text: string, key?: string) => string;
};

const UiContext = createContext<Ui>();

/** Gives the surfaces under it the Ui. */
export const UiProvider = UiContext.Provider;

export function useUi(): Ui {
    const ui = useContext(UiContext);
    if (!ui) throw new Error('A surface of the new page was mounted outside mount()');
    return ui;
}
