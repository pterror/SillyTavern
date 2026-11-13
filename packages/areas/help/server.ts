import { actions, HOTKEYS_VIEW, PANEL_VIEW } from './protocol.ts';
import type { HotkeysView, PanelView, Topic } from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { ViewContext } from '@st/server-ui';

export type Ports = {
    markdownHotkeys(context: ViewContext): Promise<boolean>;
};

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

const OPEN_KEPT = 32;

export function helpArea(ports: Ports) {
    const open = new Map<string, { topic: Topic; query: string }>();

    const show = (session: string, topic: Topic) => {
        open.delete(session);
        open.set(session, { topic, query: '' });
        for (const old of open.keys()) {
            if (open.size <= OPEN_KEPT) break;
            open.delete(old);
        }
    };

    const notOpen = { refused: 'Help is not open.', changed: [PANEL_VIEW] };

    return defineArea({
        schemas: actions,
        views: {
            [PANEL_VIEW]: async (context): Promise<PanelView> => {
                const panel = open.get(context.session);
                return panel ? { open: true, ...panel } : { open: false };
            },
            [HOTKEYS_VIEW]: async (context): Promise<HotkeysView> => ({
                markdown: await ports.markdownHotkeys(context),
            }),
        },
        followChat: [HOTKEYS_VIEW],
        gone: (session) => void open.delete(session),
        actions: {
            'help.open': async (context, { name }) => {
                show(context.session, topicNamed(name));
                return { changed: [], opensViews: [PANEL_VIEW, HOTKEYS_VIEW] };
            },
            'help.show': async (context, { topic }) => {
                if (!open.has(context.session)) return notOpen;
                show(context.session, topic);
                return { changed: [PANEL_VIEW] };
            },
            'help.search': async (context, { query }) => {
                const panel = open.get(context.session);
                if (!panel) return notOpen;
                panel.query = query;
                return { changed: [PANEL_VIEW] };
            },
            'help.close': async (context) => {
                open.delete(context.session);
                return { changed: [PANEL_VIEW] };
            },
        },
    });
}
