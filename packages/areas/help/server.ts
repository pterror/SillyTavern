import { actions, PANEL_VIEW } from './protocol.ts';
import type { PanelView, Topic } from './protocol.ts';
import { defineArea } from '@st/server-ui';

const NAMES: Record<Topic, readonly string[]> = {
    overview: ['help'],
    slash: ['commands', 'slashes', 'slash commands', '1'],
    format: ['formatting', 'formats', 'chat formatting', '2'],
    hotkeys: ['hotkey', '3'],
    macros: ['macro', '4'],
};

export function topicNamed(name: string): Topic {
    const key = name.trim().toLowerCase();
    for (const [topic, names] of Object.entries(NAMES) as [Topic, readonly string[]][]) {
        if (topic === key || names.includes(key)) return topic;
    }
    return 'overview';
}

export function helpArea() {
    /** By session, until its tab is gone. */
    const open = new Map<string, { topic: Topic }>();

    const show = (session: string, topic: Topic) => void open.set(session, { topic });

    const notOpen = { refused: 'Help is not open.', changed: [PANEL_VIEW] };

    return defineArea({
        schemas: actions,
        views: {
            [PANEL_VIEW]: async (context): Promise<PanelView> => {
                const panel = open.get(context.session);
                return panel ? { open: true, ...panel } : { open: false };
            },
        },
        gone: (session) => void open.delete(session),
        actions: {
            'help.open': async (context, { name }) => {
                show(context.session, topicNamed(name));
                return { changed: [], opensViews: [PANEL_VIEW] };
            },
            'help.show': async (context, { topic }) => {
                if (!open.has(context.session)) return notOpen;
                show(context.session, topic);
                return { changed: [PANEL_VIEW] };
            },
            'help.close': async (context) => {
                open.delete(context.session);
                return { changed: [PANEL_VIEW] };
            },
        },
    });
}
