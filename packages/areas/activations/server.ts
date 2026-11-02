import { actions, PEEK_VIEW, VIEW } from './protocol.ts';
import type { Cut, PanelView, Shown } from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { User, ViewContext } from '@st/server-ui';

export type Ports = {
    panel(user: User, message: string): Promise<{ entries: Shown[]; cut: Cut[] } | null>;
};

const OPEN_KEPT = 32;

export function activationsArea(ports: Ports) {
    const open = new Map<string, string>();
    const peeked = new Map<string, string>();

    const remember = (held: Map<string, string>, session: string, message: string) => {
        held.delete(session);
        held.set(session, message);
        for (const old of held.keys()) {
            if (held.size <= OPEN_KEPT) break;
            held.delete(old);
        }
    };

    const reader =
        (held: Map<string, string>) =>
        async (context: ViewContext): Promise<PanelView> => {
            const message = held.get(context.session) ?? null;
            if (message === null) return { message: null, entries: [], cut: [] };
            const panel = await ports.panel(context.user, message);
            return { message, entries: panel?.entries ?? [], cut: panel?.cut ?? [] };
        };

    return defineArea({
        schemas: actions,
        views: { [VIEW]: reader(open), [PEEK_VIEW]: reader(peeked) },
        gone: (session) => {
            open.delete(session);
            peeked.delete(session);
        },
        actions: {
            'activations.open': async (context, { message }) => {
                remember(open, context.session, message);
                return { changed: [VIEW] };
            },
            'activations.close': async (context) => {
                open.delete(context.session);
                return { changed: [VIEW] };
            },
            'activations.peek': async (context, { message }) => {
                remember(peeked, context.session, message);
                return { changed: [PEEK_VIEW] };
            },
        },
    });
}
