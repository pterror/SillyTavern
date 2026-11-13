import { actions, PEEK_VIEW, VIEW } from './protocol.ts';
import type { Cut, Label, PanelView, Shown } from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { User, ViewContext } from '@st/server-ui';
import type { Looks } from '@st/protocol/looks';

export type Ports = {
    panel(user: User, message: string): Promise<{ entries: Shown[]; cut: Cut[] } | null>;
    looksOf(context: ViewContext, view: string, things: string[]): Promise<Looks>;
};

const thingsOf = (labels: Label[]): string[] => labels.flatMap((label) => (label.thing === null ? [] : [label.thing]));

export function activationsArea(ports: Ports) {
    /** By session, until its tab is gone. */
    const open = new Map<string, string>();
    const peeked = new Map<string, string>();

    const reader =
        (held: Map<string, string>, view: string) =>
        async (context: ViewContext): Promise<PanelView> => {
            const message = held.get(context.session) ?? null;
            const panel = message === null ? null : await ports.panel(context.user, message);
            const entries = panel?.entries ?? [];
            const cut = panel?.cut ?? [];
            const drawn = thingsOf([...entries, ...cut].flatMap((e) => [e.label, e.world]));
            return { message, entries, cut, looks: await ports.looksOf(context, view, drawn) };
        };

    return defineArea({
        schemas: actions,
        views: { [VIEW]: reader(open, VIEW), [PEEK_VIEW]: reader(peeked, PEEK_VIEW) },
        gone: (session) => {
            open.delete(session);
            peeked.delete(session);
        },
        actions: {
            'activations.open': async (context, { message }) => {
                open.set(context.session, message);
                return { changed: [VIEW] };
            },
            'activations.close': async (context) => {
                open.delete(context.session);
                return { changed: [VIEW] };
            },
            'activations.peek': async (context, { message }) => {
                peeked.set(context.session, message);
                return { changed: [PEEK_VIEW] };
            },
        },
    });
}
