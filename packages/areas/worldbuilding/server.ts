import {
    actions,
    cardsPerTopLevelEntry,
    LAST_CHANGE_VIEW,
    LOOPS_LEFT_BY_JOBS_VIEW,
    MAX_CARDS_PER_READ,
    OVERVIEW_VIEW,
    READ_REFUSAL,
    readFitsTheBudget,
    RELATION_KINDS_VIEW,
} from './protocol.ts';
import type {
    LastChangeView,
    LoopsLeftByJobsView,
    OverviewLayout,
    OverviewView,
    RelationKind,
    RelationKindsView,
    StepLanding,
    UnreachedLoop,
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

export type RelationChangeAnswer = { refused: string } | { unreachedLoops: UnreachedLoop[] } | 'missing';

export type Ports = {
    readOverview(user: User, query: ShownOverview): Promise<Omit<OverviewView, 'book' | 'groupBy'> | null>;
    stepOverview(user: User, query: Grouping & { layout: OverviewLayout } & OverviewStep): Promise<StepLanding | null>;
    readRelationKinds(user: User, book: string): Promise<RelationKind[] | null>;
    readLoopsLeftByJobs(user: User, book: string): Promise<UnreachedLoop[]>;
    createRelationKind(who: Who, book: string, name: string): Promise<string | null>;
    renameRelationKind(who: Who, book: string, kind: string, name: string): Promise<'ok' | 'missing' | 'no kind'>;
    deleteRelationKind(
        who: Who,
        book: string,
        kind: string,
    ): Promise<'ok' | 'missing' | 'no kind' | 'in use' | 'being merged'>;
    mergeRelationKind(
        who: Who,
        book: string,
        kind: string,
        into: string,
    ): Promise<'ok' | 'missing' | 'no kind' | 'same kind' | 'being merged'>;
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

const NOTHING_CHANGED: LastChangeView = { createdKind: null, changedRelation: null, unreachedLoops: [] };

const NO_WORLD_SHOWN = 'No world is shown.';
const WORLD_GONE = 'That world no longer exists.';
const NO_SUCH_KIND = 'This world has no such relation kind.';
const BEING_MERGED = 'That kind is being merged, or another kind is being merged into it.';

export function rangeAround(rank: number, firstRank: number, endRank: number): { firstRank: number; endRank: number } {
    if (rank >= firstRank && rank < endRank) return { firstRank, endRank };
    const start = Math.max(0, rank - Math.floor((endRank - firstRank) / 2));
    return { firstRank: start, endRank: start + (endRank - firstRank) };
}

type SessionState = { overview: ShownOverview | null; kindsOfBook: string | null; lastChange: LastChangeView };

const NO_SESSION_STATE: SessionState = { overview: null, kindsOfBook: null, lastChange: NOTHING_CHANGED };

export function worldbuildingArea(ports: Ports) {
    const bySession = new Map<string, SessionState>();

    const stateOf = (session: string) => bySession.get(session) ?? NO_SESSION_STATE;

    const remember = (session: string, change: Partial<SessionState>) => {
        const state = { ...stateOf(session), ...change };
        bySession.delete(session);
        bySession.set(session, state);
        for (const old of bySession.keys()) {
            if (bySession.size <= SESSIONS_REMEMBERED) break;
            bySession.delete(old);
        }
    };

    const withOverview =
        <P>(run: (context: ActionContext, overview: ShownOverview, payload: P) => Promise<ActionResult>) =>
        async (context: ActionContext, payload: P): Promise<ActionResult> => {
            const overview = stateOf(context.session).overview;
            return overview ? run(context, overview, payload) : { refused: NO_WORLD_SHOWN };
        };

    const who = (context: ActionContext): Who => ({ user: context.user, session: context.session });

    const relationChanged = async (
        context: ActionContext,
        { book, loopCheckLimit, ...change }: RelationChange & { book: string; loopCheckLimit: number },
    ): Promise<ActionResult> => {
        const answer = await ports.changeRelation(who(context), book, change, loopCheckLimit);
        if (answer === 'missing') return { refused: WORLD_GONE };
        if ('refused' in answer) return { refused: answer.refused };
        const target = change.change === 'move' ? change.newTarget : change.target;
        remember(context.session, {
            lastChange: {
                createdKind: null,
                changedRelation: { book, entry: change.entry, kind: change.kind, target },
                unreachedLoops: answer.unreachedLoops,
            },
        });
        return { changed: [OVERVIEW_VIEW, LAST_CHANGE_VIEW] };
    };

    return defineArea({
        schemas: actions,
        views: {
            [OVERVIEW_VIEW]: async (context: ViewContext): Promise<OverviewView> => {
                const overview = stateOf(context.session).overview;
                if (!overview) return NO_OVERVIEW;
                const read = await ports.readOverview(context.user, overview);
                return read ? { book: overview.book, groupBy: overview.groupBy, ...read } : NO_OVERVIEW;
            },
            [RELATION_KINDS_VIEW]: async (context: ViewContext): Promise<RelationKindsView> => {
                const book = stateOf(context.session).kindsOfBook;
                const kinds = book === null ? null : await ports.readRelationKinds(context.user, book);
                return kinds && book !== null ? { book, kinds } : { book: null, kinds: [] };
            },
            [LAST_CHANGE_VIEW]: async (context: ViewContext): Promise<LastChangeView> =>
                stateOf(context.session).lastChange,
            [LOOPS_LEFT_BY_JOBS_VIEW]: async (context: ViewContext): Promise<LoopsLeftByJobsView> => {
                const book = stateOf(context.session).kindsOfBook;
                return book === null
                    ? { book: null, unreachedLoops: [] }
                    : { book, unreachedLoops: await ports.readLoopsLeftByJobs(context.user, book) };
            },
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
                remember(context.session, { overview, kindsOfBook: book, lastChange: NOTHING_CHANGED });
                return {
                    changed: [],
                    opensViews: [OVERVIEW_VIEW, RELATION_KINDS_VIEW, LAST_CHANGE_VIEW, LOOPS_LEFT_BY_JOBS_VIEW],
                };
            },
            'worldbuilding.showRange': withOverview(async (context, overview, { firstRank, endRank }) => {
                if (!readFitsTheBudget(endRank - firstRank, overview.layout)) return { refused: READ_REFUSAL };
                remember(context.session, { overview: { ...overview, firstRank, endRank } });
                return { changed: [OVERVIEW_VIEW] };
            }),
            'worldbuilding.stepOverview': withOverview(async (context, overview, step) => {
                const crossed = 'by' in step ? Math.abs(step.by) + 1 : 1;
                if (crossed * cardsPerTopLevelEntry(overview.layout.regionsByNestingLevel) > MAX_CARDS_PER_READ) {
                    return { refused: READ_REFUSAL };
                }
                const { book, groupBy, layout, firstRank, endRank } = overview;
                const landed = await ports.stepOverview(context.user, { book, groupBy, layout, ...step });
                if (!landed) return { refused: 'That is no longer shown.', changed: [OVERVIEW_VIEW] };
                remember(context.session, {
                    overview: {
                        ...overview,
                        ...rangeAround(landed.topLevelRank, firstRank, endRank),
                        stepLandedOn: landed.occurrence,
                    },
                });
                return { changed: [OVERVIEW_VIEW] };
            }),
            'worldbuilding.showRelationKinds': async (context, { book }) => {
                remember(context.session, { kindsOfBook: book });
                return { changed: [], opensViews: [RELATION_KINDS_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.createRelationKind': async (context, { book, name }) => {
                const kind = await ports.createRelationKind(who(context), book, name);
                if (kind === null) return { refused: WORLD_GONE };
                remember(context.session, { lastChange: { ...NOTHING_CHANGED, createdKind: { book, kind } } });
                return { changed: [RELATION_KINDS_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.renameRelationKind': async (context, { book, kind, name }) => {
                const done = await ports.renameRelationKind(who(context), book, kind, name);
                if (done === 'missing') return { refused: WORLD_GONE };
                if (done === 'no kind') return { refused: NO_SUCH_KIND, changed: [RELATION_KINDS_VIEW] };
                return { changed: [RELATION_KINDS_VIEW, OVERVIEW_VIEW] };
            },
            'worldbuilding.deleteRelationKind': async (context, { book, kind }) => {
                const done = await ports.deleteRelationKind(who(context), book, kind);
                if (done === 'missing') return { refused: WORLD_GONE };
                if (done === 'no kind') return { refused: NO_SUCH_KIND, changed: [RELATION_KINDS_VIEW] };
                if (done === 'in use') return { refused: 'Relations of this kind still exist.' };
                if (done === 'being merged') return { refused: BEING_MERGED };
                return { changed: [RELATION_KINDS_VIEW] };
            },
            'worldbuilding.mergeRelationKind': async (context, { book, kind, into }) => {
                const done = await ports.mergeRelationKind(who(context), book, kind, into);
                if (done === 'missing') return { refused: WORLD_GONE };
                if (done === 'no kind') return { refused: NO_SUCH_KIND, changed: [RELATION_KINDS_VIEW] };
                if (done === 'same kind') return { refused: 'A kind is merged into another kind.' };
                if (done === 'being merged') return { refused: BEING_MERGED };
                return { changed: [RELATION_KINDS_VIEW, OVERVIEW_VIEW] };
            },
            'worldbuilding.addRelation': (context, relation) =>
                relationChanged(context, { change: 'add', ...relation }),
            'worldbuilding.moveRelation': (context, relation) =>
                relationChanged(context, { change: 'move', ...relation }),
            'worldbuilding.removeRelation': (context, relation) =>
                relationChanged(context, { change: 'remove', ...relation }),
            'worldbuilding.setRelationWeak': (context, relation) =>
                relationChanged(context, { change: 'setWeak', ...relation }),
        },
    });
}
