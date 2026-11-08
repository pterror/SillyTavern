import { actions, OVERVIEW_VIEW } from './protocol.ts';
import type { Landed, OverviewView } from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { User, ViewContext } from '@st/server-ui';

export type Grouping = { book: string; relation: string | null };

export type Step = { from: string | null; by: number } | { from: string; to: 'parent' | 'child' };

export type Ports = {
    overview(
        user: User,
        query: Grouping & { from: number; to: number; active: string | null },
    ): Promise<Omit<OverviewView, 'book' | 'relation'> | null>;
    move(user: User, query: Grouping & Step): Promise<Landed | null>;
};

type Shown = Grouping & { from: number; to: number; active: string | null };

const KEPT = 32;

const empty: OverviewView = { book: null, relation: null, count: 0, from: 0, items: [], active: null };

export function around(rank: number, from: number, to: number): { from: number; to: number } {
    if (rank >= from && rank < to) return { from, to };
    const at = Math.max(0, rank - Math.floor((to - from) / 2));
    return { from: at, to: at + (to - from) };
}

export function worldbuildingArea(ports: Ports) {
    const shown = new Map<string, Shown>();

    const keep = (session: string, s: Shown) => {
        shown.delete(session);
        shown.set(session, s);
        for (const old of shown.keys()) {
            if (shown.size <= KEPT) break;
            shown.delete(old);
        }
    };

    return defineArea({
        schemas: actions,
        views: {
            [OVERVIEW_VIEW]: async (context: ViewContext): Promise<OverviewView> => {
                const s = shown.get(context.session);
                if (!s) return empty;
                const read = await ports.overview(context.user, s);
                return read ? { book: s.book, relation: s.relation, ...read } : empty;
            },
        },
        gone: (session) => {
            shown.delete(session);
        },
        actions: {
            'worldbuilding.open': async (context, { book, relation, from, to, around: key }) => {
                let s: Shown = { book, relation, from, to, active: null };
                if (key !== null) {
                    const landed = await ports.move(context.user, { book, relation, from: key, by: 0 });
                    if (landed) s = { ...s, ...around(landed.rank, from, to), active: landed.key };
                }
                keep(context.session, s);
                return { changed: [], opens: [OVERVIEW_VIEW] };
            },
            'worldbuilding.window': async (context, { from, to }) => {
                const s = shown.get(context.session);
                if (!s) return { refused: 'No world is shown.' };
                keep(context.session, { ...s, from, to });
                return { changed: [OVERVIEW_VIEW] };
            },
            'worldbuilding.move': async (context, step) => {
                const s = shown.get(context.session);
                if (!s) return { refused: 'No world is shown.' };
                const landed = await ports.move(context.user, { book: s.book, relation: s.relation, ...step });
                if (!landed) return { refused: 'That is no longer shown.', changed: [OVERVIEW_VIEW] };
                keep(context.session, { ...s, ...around(landed.rank, s.from, s.to), active: landed.key });
                return { changed: [OVERVIEW_VIEW] };
            },
        },
    });
}
