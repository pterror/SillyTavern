import { actions, LAST_CHANGE_VIEW, OVERVIEW_VIEW, RELATION_KINDS_VIEW } from './protocol.ts';
import type {
    LastChangeView,
    OverviewLayout,
    OverviewView,
    RelationKind,
    RelationKindsView,
    StepLanding,
} from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { ActionContext, ActionResult, User, ViewContext } from '@st/server-ui';

export type Who = { user: User; session: string };

export type Grouping = { book: string; groupBy: string | null };

export type ShownOverview = Grouping & {
    firstRank: number;
    endRank: number;
    layout: OverviewLayout;
    stepLandedOn: string | null;
};

export type OverviewStep = { from: string | null; by: number } | { from: string; to: 'parent' | 'firstChild' };

export type RelationChange = { entry: string; kind: string; target: string } & (
    | { change: 'add'; weak: boolean; after: string | null; before: string | null }
    | { change: 'move'; newTarget: string; after: string | null; before: string | null }
    | { change: 'remove' }
    | { change: 'setWeak'; weak: boolean }
);

export type RelationChangeAnswer = { refused: string } | { unreached: string[] | null } | 'missing';

export type Ports = {
    readOverview(user: User, query: ShownOverview): Promise<Omit<OverviewView, 'book' | 'groupBy'> | null>;
    stepOverview(user: User, query: Grouping & { layout: OverviewLayout } & OverviewStep): Promise<StepLanding | null>;
    readRelationKinds(user: User, book: string): Promise<RelationKind[] | null>;
    createRelationKind(who: Who, book: string, name: string): Promise<string | null>;
    renameRelationKind(who: Who, book: string, kind: string, name: string): Promise<'ok' | 'missing' | 'no kind'>;
    changeRelation(
        who: Who,
        book: string,
        change: RelationChange,
        loopCheckLimit: number,
    ): Promise<RelationChangeAnswer>;
};

const SESSIONS_REMEMBERED = 32;

const NO_OVERVIEW: OverviewView = {
    book: null,
    groupBy: null,
    topLevelCount: 0,
    firstRank: 0,
    entries: [],
    stepLanding: null,
};

const NOTHING_CHANGED: LastChangeView = { createdKind: null, unreachedLoop: null };

const NO_WORLD_SHOWN = 'No world is shown.';
const WORLD_GONE = 'That world no longer exists.';

export function rangeAround(rank: number, firstRank: number, endRank: number): { firstRank: number; endRank: number } {
    if (rank >= firstRank && rank < endRank) return { firstRank, endRank };
    const start = Math.max(0, rank - Math.floor((endRank - firstRank) / 2));
    return { firstRank: start, endRank: start + (endRank - firstRank) };
}

type SessionState = { overview: ShownOverview; lastChange: LastChangeView };

export function worldbuildingArea(ports: Ports) {
    const bySession = new Map<string, SessionState>();

    const remember = (session: string, state: SessionState) => {
        bySession.delete(session);
        bySession.set(session, state);
        for (const old of bySession.keys()) {
            if (bySession.size <= SESSIONS_REMEMBERED) break;
            bySession.delete(old);
        }
    };

    const withWorld =
        <P>(run: (context: ActionContext, state: SessionState, payload: P) => Promise<ActionResult>) =>
        async (context: ActionContext, payload: P): Promise<ActionResult> => {
            const state = bySession.get(context.session);
            return state ? run(context, state, payload) : { refused: NO_WORLD_SHOWN };
        };

    const who = (context: ActionContext): Who => ({ user: context.user, session: context.session });

    const relationChanged = async (
        context: ActionContext,
        state: SessionState,
        change: RelationChange,
        loopCheckLimit: number,
    ): Promise<ActionResult> => {
        const answer = await ports.changeRelation(who(context), state.overview.book, change, loopCheckLimit);
        if (answer === 'missing') return { refused: WORLD_GONE, changed: [OVERVIEW_VIEW] };
        if ('refused' in answer) return { refused: answer.refused };
        const target = change.change === 'move' ? change.newTarget : change.target;
        const unreachedLoop =
            answer.unreached === null
                ? null
                : { entry: change.entry, kind: change.kind, target, entries: answer.unreached };
        remember(context.session, { ...state, lastChange: { createdKind: null, unreachedLoop } });
        return { changed: [OVERVIEW_VIEW, LAST_CHANGE_VIEW] };
    };

    return defineArea({
        schemas: actions,
        views: {
            [OVERVIEW_VIEW]: async (context: ViewContext): Promise<OverviewView> => {
                const state = bySession.get(context.session);
                if (!state) return NO_OVERVIEW;
                const read = await ports.readOverview(context.user, state.overview);
                return read ? { book: state.overview.book, groupBy: state.overview.groupBy, ...read } : NO_OVERVIEW;
            },
            [RELATION_KINDS_VIEW]: async (context: ViewContext): Promise<RelationKindsView> => {
                const state = bySession.get(context.session);
                const kinds = state ? await ports.readRelationKinds(context.user, state.overview.book) : null;
                return kinds && state ? { book: state.overview.book, kinds } : { book: null, kinds: [] };
            },
            [LAST_CHANGE_VIEW]: async (context: ViewContext): Promise<LastChangeView> =>
                bySession.get(context.session)?.lastChange ?? NOTHING_CHANGED,
        },
        gone: (session) => {
            bySession.delete(session);
        },
        actions: {
            'worldbuilding.openOverview': async (context, { book, groupBy, firstRank, endRank, layout, around }) => {
                let overview: ShownOverview = { book, groupBy, firstRank, endRank, layout, stepLandedOn: null };
                if (around !== null) {
                    const landed = await ports.stepOverview(context.user, {
                        book,
                        groupBy,
                        layout,
                        from: around,
                        by: 0,
                    });
                    if (landed) {
                        overview = {
                            ...overview,
                            ...rangeAround(landed.topLevelRank, firstRank, endRank),
                            stepLandedOn: landed.occurrence,
                        };
                    }
                }
                remember(context.session, { overview, lastChange: NOTHING_CHANGED });
                return { changed: [], opensViews: [OVERVIEW_VIEW, RELATION_KINDS_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.showRange': withWorld(async (context, state, { firstRank, endRank }) => {
                remember(context.session, { ...state, overview: { ...state.overview, firstRank, endRank } });
                return { changed: [OVERVIEW_VIEW] };
            }),
            'worldbuilding.stepOverview': withWorld(async (context, state, step) => {
                const { book, groupBy, layout, firstRank, endRank } = state.overview;
                const landed = await ports.stepOverview(context.user, { book, groupBy, layout, ...step });
                if (!landed) return { refused: 'That is no longer shown.', changed: [OVERVIEW_VIEW] };
                const overview = {
                    ...state.overview,
                    ...rangeAround(landed.topLevelRank, firstRank, endRank),
                    stepLandedOn: landed.occurrence,
                };
                remember(context.session, { ...state, overview });
                return { changed: [OVERVIEW_VIEW] };
            }),
            'worldbuilding.createRelationKind': withWorld(async (context, state, { name }) => {
                const id = await ports.createRelationKind(who(context), state.overview.book, name);
                if (id === null) return { refused: WORLD_GONE, changed: [OVERVIEW_VIEW] };
                remember(context.session, { ...state, lastChange: { createdKind: id, unreachedLoop: null } });
                return { changed: [RELATION_KINDS_VIEW, LAST_CHANGE_VIEW] };
            }),
            'worldbuilding.renameRelationKind': withWorld(async (context, state, { kind, name }) => {
                const done = await ports.renameRelationKind(who(context), state.overview.book, kind, name);
                if (done === 'missing') return { refused: WORLD_GONE, changed: [OVERVIEW_VIEW] };
                if (done === 'no kind')
                    return { refused: 'This world has no such relation kind.', changed: [RELATION_KINDS_VIEW] };
                return { changed: [RELATION_KINDS_VIEW, OVERVIEW_VIEW] };
            }),
            'worldbuilding.addRelation': withWorld((context, state, { loopCheckLimit, ...relation }) =>
                relationChanged(context, state, { change: 'add', ...relation }, loopCheckLimit),
            ),
            'worldbuilding.moveRelation': withWorld((context, state, { loopCheckLimit, ...relation }) =>
                relationChanged(context, state, { change: 'move', ...relation }, loopCheckLimit),
            ),
            'worldbuilding.removeRelation': withWorld((context, state, { loopCheckLimit, ...relation }) =>
                relationChanged(context, state, { change: 'remove', ...relation }, loopCheckLimit),
            ),
            'worldbuilding.setRelationWeak': withWorld((context, state, { loopCheckLimit, ...relation }) =>
                relationChanged(context, state, { change: 'setWeak', ...relation }, loopCheckLimit),
            ),
        },
    });
}
