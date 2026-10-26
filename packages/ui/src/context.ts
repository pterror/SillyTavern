import { createContext, useContext } from 'solid-js';
import type { Client } from './client.ts';
import type { Child } from './solid.ts';

/** What every surface of the new page works with: the client, and the user's language. */
export type Ui = {
    client: Client;
    /** The text in the user's language (the old page's translations, keyed by the English text). */
    t: (text: string) => string;
};

const UiContext = createContext<Ui>();

/** Gives the surfaces under it the Ui (Solid's provider, typed for h: see solid.ts). */
export const UiProvider = UiContext.Provider as unknown as (props: { value: Ui; children: Child }) => Child;

export function useUi(): Ui {
    const ui = useContext(UiContext);
    if (!ui) throw new Error('A surface of the new page was mounted outside mount()');
    return ui;
}
