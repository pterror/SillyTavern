import { actions, FROM_VIEW, ISSUES_VIEW, SIZES_VIEW, TO_VIEW } from './protocol.ts';
import type { FromView, IssuesView, SizesView, ToView } from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { User, ViewContext } from '@st/server-ui';

export type Ports = {
    from(user: User, book: string, entry: string, cursor: string | null): Promise<Omit<FromView, 'entry'> | null>;
    to(user: User, book: string, entry: string, cursor: string | null): Promise<Omit<ToView, 'entry'> | null>;
    issues(user: User, book: string, cursor: number | null): Promise<Omit<IssuesView, 'book'> | null>;
    sizes(user: User, book: string, entries: string[]): Promise<Omit<SizesView, 'book'> | null>;
};

type Shown = {
    book: string;
    entry: string | null;
    from: string | null;
    to: string | null;
    issues: number | null;
    sizes: string[];
};

const KEPT = 32;

export function referencesArea(ports: Ports) {
    const shown = new Map<string, Shown>();

    const keep = (session: string, s: Shown) => {
        shown.delete(session);
        shown.set(session, s);
        for (const old of shown.keys()) {
            if (shown.size <= KEPT) break;
            shown.delete(old);
        }
    };

    const emptyFrom: FromView = { entry: null, references: [], unresolved: [], next: null };
    const emptyTo: ToView = { entry: null, references: [], unlinked: [], scanned: false, unresolved: [], next: null };

    return defineArea({
        schemas: actions,
        views: {
            [FROM_VIEW]: async (context: ViewContext): Promise<FromView> => {
                const s = shown.get(context.session);
                if (!s || s.entry === null) return emptyFrom;
                const page = await ports.from(context.user, s.book, s.entry, s.from);
                return page ? { entry: s.entry, ...page } : emptyFrom;
            },
            [TO_VIEW]: async (context: ViewContext): Promise<ToView> => {
                const s = shown.get(context.session);
                if (!s || s.entry === null) return emptyTo;
                const page = await ports.to(context.user, s.book, s.entry, s.to);
                return page ? { entry: s.entry, ...page } : emptyTo;
            },
            [ISSUES_VIEW]: async (context: ViewContext): Promise<IssuesView> => {
                const s = shown.get(context.session);
                if (!s) return { book: null, issues: [], next: null };
                const page = await ports.issues(context.user, s.book, s.issues);
                return page ? { book: s.book, ...page } : { book: null, issues: [], next: null };
            },
            [SIZES_VIEW]: async (context: ViewContext): Promise<SizesView> => {
                const s = shown.get(context.session);
                const none: SizesView = { book: null, bytes: 0, hash: '0', entries: 0, of: [] };
                if (!s) return none;
                const sizes = await ports.sizes(context.user, s.book, s.sizes);
                return sizes ? { book: s.book, ...sizes } : none;
            },
        },
        gone: (session) => {
            shown.delete(session);
        },
        actions: {
            'references.show': async (context, { book, entry }) => {
                keep(context.session, {
                    book,
                    entry,
                    from: null,
                    to: null,
                    issues: null,
                    sizes: entry === null ? [] : [entry],
                });
                return { changed: [FROM_VIEW, TO_VIEW, ISSUES_VIEW, SIZES_VIEW] };
            },
            'references.page': async (context, { list, cursor }) => {
                const s = shown.get(context.session);
                if (!s) return { refused: 'Nothing is shown.' };
                if (list === 'issues') {
                    if (cursor !== null && typeof cursor !== 'number')
                        return { refused: 'An issues page starts at a position.' };
                    keep(context.session, { ...s, issues: cursor });
                    return { changed: [ISSUES_VIEW] };
                }
                if (cursor !== null && typeof cursor !== 'string')
                    return { refused: 'A references page starts at a cursor.' };
                keep(context.session, { ...s, [list]: cursor });
                return { changed: [list === 'from' ? FROM_VIEW : TO_VIEW] };
            },
            'references.sizes': async (context, { entries }) => {
                const s = shown.get(context.session);
                if (!s) return { refused: 'Nothing is shown.' };
                keep(context.session, { ...s, sizes: entries });
                return { changed: [SIZES_VIEW] };
            },
        },
    });
}
