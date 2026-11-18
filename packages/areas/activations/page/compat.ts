import { snapshot } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import type { Client } from '@st/page/client';
import { PEEK_VIEW } from '../protocol.ts';
import type { PanelView } from '../protocol.ts';
import type { Look } from './Activations.tsx';

export function activationsCompat(client: Client, setLook: Setter<Look | null>) {
    let peekView: Accessor<PanelView | undefined> | null = null;
    const held = (message: string) => {
        const now = peekView?.();
        return now && now.message === message ? (structuredClone(snapshot(now)) as PanelView) : null;
    };
    const peek = async (message: string): Promise<PanelView | null> => {
        peekView ??= client.view<PanelView>(PEEK_VIEW);
        const answer = await client.send('activations.peek', { message });
        return answer.ok ? held(message) : null;
    };
    return {
        open: (message: string, anchor?: HTMLElement) => {
            setLook(anchor ? { message, anchor } : { message });
        },
        close: () => {
            setLook(null);
        },
        peek,
    };
}

export type ActivationsCompat = ReturnType<typeof activationsCompat>;
