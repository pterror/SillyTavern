import { createContext, useContext } from 'solid-js';
import type { Client } from './client.ts';

export type Ui = {
    client: Client;
    t: (text: string, key?: string) => string;
};

const UiContext = createContext<Ui>();

export const UiProvider = UiContext.Provider;

export function useUi(): Ui {
    const ui = useContext(UiContext);
    if (!ui) throw new Error('A surface of the new page was mounted outside mount()');
    return ui;
}
