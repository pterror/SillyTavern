import { unwrap } from 'solid-js/store';
import type { Accessor, Setter } from 'solid-js';
import type { Client } from '@st/page/client';
import { PEEK_VIEW } from '../protocol.ts';
import type { PanelView } from '../protocol.ts';
import type { Look, OldPage } from './Activations.tsx';

export function activationsCompat(client: Client, setLook: Setter<Look | null>, old: OldPage) {
    let peekView: Accessor<PanelView | undefined> | null = null;
    const held = (message: string) => {
        const now = peekView?.();
        return now && now.message === message ? (structuredClone(unwrap(now)) as PanelView) : null;
    };
    const show = (look: Look | null) => {
        setLook(look);
        old.panelShown(look?.message ?? null);
    };
    const peek = async (message: string): Promise<PanelView | null> => {
        const known = held(message);
        if (known) return known;
        peekView ??= client.view<PanelView>(PEEK_VIEW);
        const answer = await client.send('activations.peek', { message });
        return answer.ok ? held(message) : null;
    };
    return {
        open: (message: string) => {
            show({ message });
        },
        close: () => {
            show(null);
        },
        peek,
    };
}

export type ActivationsCompat = ReturnType<typeof activationsCompat>;
