import { actions, VIEW } from './protocol.ts';
import type { Entry, ListView, Message, Of } from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { ViewContext } from '@st/server-ui';

// An entry as the store lists it: `group` names a group's places for `tips`, null for where a chat is; `tips` how many
// places the group has, the shown one among them.
export type Listed = Omit<Entry, 'others' | 'tips'> & { group: string | null; tips: number };

export type Ports = {
    // A page of entries, the latest activity first, after the page `before` named the `next` of. Null when `of` is
    // `chat` and the tab shows none.
    entries(
        context: ViewContext,
        of: Of,
        before: string | null,
        limit: number,
    ): Promise<{ entries: Listed[]; next: string | null } | null>;
    // A page of a group's places, the latest first, the shown one among them.
    tips(
        context: ViewContext,
        group: string,
        before: string | null,
        limit: number,
    ): Promise<{ tips: Message[]; next: string | null }>;
};

export const PAGE = 50;
export const TIPS_PAGE = 50;

type Look = {
    root: string;
    of: Of;
    pages: number;
    // By entry id, the pages of its places read.
    expanded: Map<string, number>;
};

export function recentHistoryArea(ports: Ports) {
    const looks = new Map<string, Look>();

    const tipsOf = async (context: ViewContext, listed: Listed, pages: number): Promise<Entry['tips']> => {
        if (listed.group === null) return null;
        const messages: Message[] = [];
        let before: string | null = null;
        for (let page = 0; page < pages; page++) {
            const read = await ports.tips(context, listed.group, before, TIPS_PAGE);
            messages.push(...read.tips.filter((tip) => tip.nodeId !== listed.message.nodeId));
            before = read.next;
            if (before === null) break;
        }
        return { messages, more: before !== null };
    };

    async function* readList(context: ViewContext): AsyncGenerator<ListView, void, undefined> {
        const look = looks.get(context.session);
        if (!look) {
            yield { of: null, entries: [], more: false, chatOpen: context.chat !== null };
            return;
        }
        const entries: Entry[] = [];
        let before: string | null = null;
        for (let page = 0; page < look.pages; page++) {
            const read = await ports.entries(context, look.of, before, PAGE);
            if (read === null) break;
            for (const listed of read.entries) {
                const { group, tips, ...shown } = listed;
                const pages = group === null ? undefined : look.expanded.get(listed.id);
                entries.push({
                    ...shown,
                    others: Math.max(0, tips - 1),
                    tips: pages === undefined ? null : await tipsOf(context, listed, pages),
                });
            }
            before = read.next;
            if (before === null) break;
            if (page + 1 < look.pages)
                yield { of: look.of, entries: [...entries], more: true, chatOpen: context.chat !== null };
        }
        yield { of: look.of, entries, more: before !== null, chatOpen: context.chat !== null };
    }

    const area = defineArea({
        schemas: actions,
        views: { [VIEW]: readList },
        gone: (session) => void looks.delete(session),
        actions: {
            'recentHistory.open': async ({ user, session }, { of }) => {
                const before = looks.get(session);
                looks.set(session, {
                    root: user.directories.root,
                    of,
                    pages: 1,
                    expanded: before?.of === of ? before.expanded : new Map(),
                });
                return { changed: [VIEW], opensViews: [VIEW] };
            },
            'recentHistory.more': async ({ session }) => {
                const look = looks.get(session);
                if (!look) return { refused: 'Recent history is not open.', changed: [VIEW] };
                look.pages++;
                return { changed: [VIEW] };
            },
            'recentHistory.expand': async ({ session }, { id, open }) => {
                const look = looks.get(session);
                if (!look) return { refused: 'Recent history is not open.', changed: [VIEW] };
                if (open) look.expanded.set(id, look.expanded.get(id) ?? 1);
                else look.expanded.delete(id);
                return { changed: [VIEW] };
            },
            'recentHistory.moreTips': async ({ session }, { id }) => {
                const look = looks.get(session);
                const pages = look?.expanded.get(id);
                if (!look || pages === undefined) return { refused: 'That group is not expanded.', changed: [VIEW] };
                look.expanded.set(id, pages + 1);
                return { changed: [VIEW] };
            },
            'recentHistory.close': async ({ session }) => {
                looks.delete(session);
                return { changed: [VIEW] };
            },
        },
    });

    return {
        area,
        showing: (root: string): boolean => [...looks.values()].some((look) => look.root === root),
    };
}
