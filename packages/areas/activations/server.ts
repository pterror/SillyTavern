import { actions, VIEW } from './protocol.ts';
import type { Cut, PanelView, Shown } from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { User, ViewContext } from '@st/server-ui';

export type Ports = {
    panel(user: User, message: string): Promise<{ entries: Shown[]; cut: Cut[] } | null>;
};

const OPEN_KEPT = 32;

export function activationsArea(ports: Ports) {
    const open = new Map<string, string>();

    async function read(context: ViewContext): Promise<PanelView> {
        const message = open.get(context.session) ?? null;
        if (message === null) return { message: null, entries: [], cut: [] };
        const panel = await ports.panel(context.user, message);
        return { message, entries: panel?.entries ?? [], cut: panel?.cut ?? [] };
    }

    return defineArea({
        schemas: actions,
        views: { [VIEW]: read },
        gone: (session) => void open.delete(session),
        actions: {
            'activations.open': async (context, { message }) => {
                open.delete(context.session);
                open.set(context.session, message);
                for (const session of open.keys()) {
                    if (open.size <= OPEN_KEPT) break;
                    open.delete(session);
                }
                return { changed: [VIEW] };
            },
            'activations.close': async (context) => {
                open.delete(context.session);
                return { changed: [VIEW] };
            },
        },
    });
}
