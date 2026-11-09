import {
    actions,
    cardsPerTopLevelEntry,
    ENTRY_VIEW,
    LAST_CHANGE_VIEW,
    LOOPS_LEFT_BY_JOBS_VIEW,
    MAX_CARDS_PER_READ,
    OVERVIEW_VIEW,
    READ_REFUSAL,
    readFitsTheBudget,
    RELATION_KINDS_VIEW,
    WORLD_VIEW,
    WORLDS_VIEW,
} from './protocol.ts';
import type {
    EntryView,
    ExportedWorld,
    World,
    WorldsView,
    WorldView,
    LastChangeView,
    LoopsLeftByJobsView,
    MentionedIn,
    Named,
    OpenEntryView,
    Placement,
    OverviewLayout,
    OverviewView,
    RelationKind,
    RelationKindsView,
    StepLanding,
    UnreachedLoop,
} from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { ActionContext, ActionResult, Upload, User, ViewContext } from '@st/server-ui';

export type Who = { user: User; session: string };

export type Grouping = { book: string; groupBy: string | null };

export type ShownOverview = Grouping & {
    firstRank: number;
    endRank: number;
    layout: OverviewLayout;
    stepLandedOn: string | null;
};

export type ShownWorld = Omit<ShownOverview, 'book' | 'stepLandedOn'> & { around: string | null };

export type OverviewStep = { from: string | null; by: number } | { from: string; to: 'parent' | 'firstChild' };

export type RelationChange = { entry: string; kind: string; target: string } & (
    | { change: 'add'; weak: boolean; after: string | null; before: string | null }
    | { change: 'move'; newTarget: string; after: string | null; before: string | null }
    | { change: 'remove' }
    | { change: 'setWeak'; weak: boolean }
);

export type RelationChangeAnswer = { refused: string } | { unreachedLoops: UnreachedLoop[] } | 'missing';

export type EntryRead =
    | (Omit<OpenEntryView, 'book' | 'entry' | 'mentionedIn'> & { mentionedIn: MentionedIn })
    | { deleted: true }
    | null;

export type EntryEdit =
    | { change: 'text'; text: string }
    | { change: 'title'; title: string }
    | { change: 'addKey'; key: string; as: 'name' | 'trigger' }
    | { change: 'setKeyAs'; key: string; as: 'name' | 'trigger' }
    | { change: 'removeKey'; key: string }
    | { change: 'placement'; fields: Partial<Placement> };

export type EntryCreation = {
    after: string | null;
    name: string | null;
    relation: { kind: string; target: string } | null;
};

export type EntryWriteRefusal = 'missing' | 'no entry' | { refused: string };

export type NewWorld = { book: string } | { refused: string };

export type Ports = {
    readWorlds(user: User): Promise<World[]>;
    readWorld(user: User, book: string): Promise<World | null>;
    openWorld(who: Who, book: string | null): Promise<string | null>;
    createWorld(who: Who, name: string): Promise<NewWorld>;
    renameWorld(who: Who, book: string, name: string): Promise<'ok' | 'missing' | { refused: string }>;
    duplicateWorld(who: Who, book: string): Promise<NewWorld | 'missing'>;
    deleteWorld(who: Who, book: string): Promise<'ok' | 'missing'>;
    importWorld(who: Who, file: Upload): Promise<NewWorld>;
    exportWorld(user: User, book: string): Promise<ExportedWorld | null>;
    setUsedInEveryChat(who: Who, book: string, used: boolean): Promise<'ok' | 'missing'>;
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
    readEntry(user: User, book: string, entry: string, mentionPages: string[]): Promise<EntryRead>;
    editEntry(who: Who, book: string, entry: string, edit: EntryEdit): Promise<'ok' | EntryWriteRefusal>;
    createEntry(
        who: Who,
        book: string,
        creation: EntryCreation,
        loopCheckLimit: number,
    ): Promise<{ entry: string; unreachedLoops: UnreachedLoop[] } | 'missing' | { refused: string }>;
    deleteEntry(
        who: Who,
        book: string,
        entry: string,
    ): Promise<{ label: Named; unreachedLoops: UnreachedLoop[] } | EntryWriteRefusal>;
    restoreEntry(
        who: Who,
        book: string,
        entry: string,
    ): Promise<{ unreachedLoops: UnreachedLoop[] } | EntryWriteRefusal>;
    moveEntryToWorld(
        who: Who,
        book: string,
        entry: string,
        toBook: string,
    ): Promise<{ entry: string; unreachedLoops: UnreachedLoop[] } | EntryWriteRefusal>;
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

const NOTHING_CHANGED: LastChangeView = {
    createdKind: null,
    changedRelation: null,
    createdEntry: null,
    deletedEntry: null,
    movedEntry: null,
    unreachedLoops: [],
};

const NO_ENTRY: EntryView = { book: null };

// The views that show how many entries a world has; an action that adds or takes away an entry answers them all.
const VIEWS_COUNTING_ENTRIES = [OVERVIEW_VIEW, WORLDS_VIEW, WORLD_VIEW];

const NO_WORLD: WorldView = { id: null };

const VIEWS_OF_A_WORLD = [OVERVIEW_VIEW, RELATION_KINDS_VIEW, LAST_CHANGE_VIEW, LOOPS_LEFT_BY_JOBS_VIEW, WORLD_VIEW];

const NO_WORLD_SHOWN = 'No world is shown.';
const WORLD_GONE = 'That world no longer exists.';
const NO_SUCH_KIND = 'This world has no such relation kind.';
const BEING_MERGED = 'That kind is being merged, or another kind is being merged into it.';
const NO_SUCH_ENTRY = "That entry isn't in this world.";
const NO_ENTRY_OPEN = 'No entry is open.';

export function rangeAround(rank: number, firstRank: number, endRank: number): { firstRank: number; endRank: number } {
    if (rank >= firstRank && rank < endRank) return { firstRank, endRank };
    const start = Math.max(0, rank - Math.floor((endRank - firstRank) / 2));
    return { firstRank: start, endRank: start + (endRank - firstRank) };
}

export type OpenEntry = { book: string; entry: string; label: Named | null; mentionPages: string[] };

type SessionState = {
    overview: ShownOverview | null;
    kindsOfBook: string | null;
    entry: OpenEntry | null;
    lastChange: LastChangeView;
};

const NO_SESSION_STATE: SessionState = { overview: null, kindsOfBook: null, entry: null, lastChange: NOTHING_CHANGED };

const opened = (book: string, entry: string): OpenEntry => ({ book, entry, label: null, mentionPages: [] });

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
                ...NOTHING_CHANGED,
                changedRelation: { book, entry: change.entry, kind: change.kind, target },
                unreachedLoops: answer.unreachedLoops,
            },
        });
        return { changed: [OVERVIEW_VIEW, ENTRY_VIEW, LAST_CHANGE_VIEW] };
    };

    const refusedWrite = (refusal: EntryWriteRefusal): ActionResult => {
        if (refusal === 'missing') return { refused: WORLD_GONE };
        if (refusal === 'no entry') return { refused: NO_SUCH_ENTRY, changed: [OVERVIEW_VIEW, ENTRY_VIEW] };
        return { refused: refusal.refused };
    };

    const entryEdited = async (
        context: ActionContext,
        book: string,
        entry: string,
        edit: EntryEdit,
    ): Promise<ActionResult> => {
        const done = await ports.editEntry(who(context), book, entry, edit);
        return done === 'ok' ? { changed: [OVERVIEW_VIEW, ENTRY_VIEW] } : refusedWrite(done);
    };

    const readEntryView = async (context: ViewContext): Promise<EntryView> => {
        const shown = stateOf(context.session).entry;
        if (!shown) return NO_ENTRY;
        const read = await ports.readEntry(context.user, shown.book, shown.entry, shown.mentionPages);
        if (read === null) return NO_ENTRY;
        if (read.deleted) return { book: shown.book, entry: shown.entry, deleted: true, label: shown.label };
        const current = stateOf(context.session).entry;
        if (current?.book === shown.book && current.entry === shown.entry) {
            bySession.set(context.session, { ...stateOf(context.session), entry: { ...current, label: read.label } });
        }
        return { book: shown.book, entry: shown.entry, ...read };
    };

    const showWorld = async (
        context: ActionContext,
        book: string | null,
        { groupBy, firstRank, endRank, layout, around }: ShownWorld,
    ): Promise<{ changed: string[]; opensViews: string[] }> => {
        const opened = await ports.openWorld(who(context), book);
        if (opened === null) {
            remember(context.session, { overview: null, kindsOfBook: null, entry: null, lastChange: NOTHING_CHANGED });
            return {
                changed: [OVERVIEW_VIEW, RELATION_KINDS_VIEW, LAST_CHANGE_VIEW, LOOPS_LEFT_BY_JOBS_VIEW, ENTRY_VIEW],
                opensViews: [WORLD_VIEW, WORLDS_VIEW],
            };
        }
        let overview: ShownOverview = { book: opened, groupBy, firstRank, endRank, layout, stepLandedOn: null };
        if (around !== null) {
            const landed = await ports.stepOverview(context.user, {
                book: opened,
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
        remember(context.session, { overview, kindsOfBook: opened, lastChange: NOTHING_CHANGED });
        return { changed: [], opensViews: VIEWS_OF_A_WORLD };
    };

    const newWorldShown = async (
        context: ActionContext,
        made: NewWorld | 'missing',
        overview: Omit<ShownWorld, 'groupBy' | 'around'>,
    ): Promise<ActionResult> => {
        if (made === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
        if ('refused' in made) return { refused: made.refused };
        const shown = await showWorld(context, made.book, { ...overview, groupBy: null, around: null });
        return { ...shown, changed: [...shown.changed, WORLDS_VIEW] };
    };

    const forgetWorld = (book: string) => {
        for (const [session, state] of bySession) {
            if (state.overview?.book !== book && state.kindsOfBook !== book && state.entry?.book !== book) continue;
            bySession.set(session, {
                ...state,
                overview: state.overview?.book === book ? null : state.overview,
                kindsOfBook: state.kindsOfBook === book ? null : state.kindsOfBook,
                entry: state.entry?.book === book ? null : state.entry,
            });
        }
    };

    return defineArea({
        schemas: actions,
        views: {
            [WORLDS_VIEW]: async (context: ViewContext): Promise<WorldsView> => ({
                worlds: await ports.readWorlds(context.user),
            }),
            [WORLD_VIEW]: async (context: ViewContext): Promise<WorldView> => {
                const book = stateOf(context.session).overview?.book;
                return (book === undefined ? null : await ports.readWorld(context.user, book)) ?? NO_WORLD;
            },
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
            [ENTRY_VIEW]: readEntryView,
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
            'worldbuilding.openOverview': (context, { book, ...shown }) => showWorld(context, book, shown),
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
            'worldbuilding.openEntry': async (context, { book, entry }) => {
                remember(context.session, { entry: opened(book, entry) });
                return { changed: [], opensViews: [ENTRY_VIEW] };
            },
            'worldbuilding.closeEntry': async (context) => {
                remember(context.session, { entry: null });
                return { changed: [ENTRY_VIEW] };
            },
            'worldbuilding.showMoreMentions': async (context, { cursor }) => {
                const shown = stateOf(context.session).entry;
                if (!shown) return { refused: NO_ENTRY_OPEN };
                if (!shown.mentionPages.includes(cursor)) {
                    remember(context.session, { entry: { ...shown, mentionPages: [...shown.mentionPages, cursor] } });
                }
                return { changed: [ENTRY_VIEW] };
            },
            'worldbuilding.setEntryText': (context, { book, entry, text }) =>
                entryEdited(context, book, entry, { change: 'text', text }),
            'worldbuilding.setEntryTitle': (context, { book, entry, title }) =>
                entryEdited(context, book, entry, { change: 'title', title }),
            'worldbuilding.addKey': (context, { book, entry, key, as }) =>
                entryEdited(context, book, entry, { change: 'addKey', key, as }),
            'worldbuilding.setKeyAs': (context, { book, entry, key, as }) =>
                entryEdited(context, book, entry, { change: 'setKeyAs', key, as }),
            'worldbuilding.removeKey': (context, { book, entry, key }) =>
                entryEdited(context, book, entry, { change: 'removeKey', key }),
            'worldbuilding.setPlacement': (context, { book, entry, fields }) =>
                entryEdited(context, book, entry, { change: 'placement', fields }),
            'worldbuilding.createEntry': async (context, { book, after, name, relation, open, loopCheckLimit }) => {
                const made = await ports.createEntry(who(context), book, { after, name, relation }, loopCheckLimit);
                if (made === 'missing') return { refused: WORLD_GONE };
                if ('refused' in made) return { refused: made.refused };
                remember(context.session, {
                    ...(open ? { entry: opened(book, made.entry) } : {}),
                    lastChange: {
                        ...NOTHING_CHANGED,
                        createdEntry: { book, entry: made.entry },
                        unreachedLoops: made.unreachedLoops,
                    },
                });
                return open
                    ? { changed: [...VIEWS_COUNTING_ENTRIES, LAST_CHANGE_VIEW], opensViews: [ENTRY_VIEW] }
                    : { changed: [...VIEWS_COUNTING_ENTRIES, ENTRY_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.deleteEntry': async (context, { book, entry }) => {
                const done = await ports.deleteEntry(who(context), book, entry);
                if (typeof done === 'string' || 'refused' in done) return refusedWrite(done);
                const shown = stateOf(context.session).entry;
                remember(context.session, {
                    ...(shown?.book === book && shown.entry === entry
                        ? { entry: { ...shown, label: done.label } }
                        : {}),
                    lastChange: {
                        ...NOTHING_CHANGED,
                        deletedEntry: { book, entry, label: done.label },
                        unreachedLoops: done.unreachedLoops,
                    },
                });
                return { changed: [...VIEWS_COUNTING_ENTRIES, ENTRY_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.restoreEntry': async (context, { book, entry }) => {
                const done = await ports.restoreEntry(who(context), book, entry);
                if (typeof done === 'string' || 'refused' in done) return refusedWrite(done);
                remember(context.session, { lastChange: { ...NOTHING_CHANGED, unreachedLoops: done.unreachedLoops } });
                return { changed: [...VIEWS_COUNTING_ENTRIES, ENTRY_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.moveEntryToWorld': async (context, { book, entry, toBook }) => {
                if (toBook === book) return { refused: 'The entry is in that world already.' };
                const moved = await ports.moveEntryToWorld(who(context), book, entry, toBook);
                if (typeof moved === 'string' || 'refused' in moved) return refusedWrite(moved);
                const shown = stateOf(context.session).entry;
                remember(context.session, {
                    ...(shown?.book === book && shown.entry === entry ? { entry: opened(toBook, moved.entry) } : {}),
                    lastChange: {
                        ...NOTHING_CHANGED,
                        movedEntry: { book, entry, toBook, newEntry: moved.entry },
                        unreachedLoops: moved.unreachedLoops,
                    },
                });
                return { changed: [...VIEWS_COUNTING_ENTRIES, ENTRY_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.openWorlds': async () => ({ changed: [], opensViews: [WORLDS_VIEW] }),
            'worldbuilding.createWorld': async (context, { name, overview }) =>
                newWorldShown(context, await ports.createWorld(who(context), name), overview),
            'worldbuilding.renameWorld': async (context, { book, name }) => {
                const done = await ports.renameWorld(who(context), book, name);
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                if (done !== 'ok') return { refused: done.refused };
                return { changed: [WORLDS_VIEW, WORLD_VIEW] };
            },
            'worldbuilding.duplicateWorld': async (context, { book, overview }) =>
                newWorldShown(context, await ports.duplicateWorld(who(context), book), overview),
            'worldbuilding.deleteWorld': async (context, { book }) => {
                const done = await ports.deleteWorld(who(context), book);
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                forgetWorld(book);
                return {
                    changed: [OVERVIEW_VIEW, RELATION_KINDS_VIEW, LOOPS_LEFT_BY_JOBS_VIEW, ENTRY_VIEW, WORLD_VIEW],
                    opensViews: [WORLDS_VIEW],
                };
            },
            'worldbuilding.importWorld': async (context, { overview }) => {
                if (!context.upload) return { refused: 'Choose a file to import.' };
                return newWorldShown(context, await ports.importWorld(who(context), context.upload), overview);
            },
            'worldbuilding.exportWorld': async (context, { book }) => {
                const exported = await ports.exportWorld(context.user, book);
                if (!exported) return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                return { changed: [], answer: exported };
            },
            'worldbuilding.setUsedInEveryChat': async (context, { book, used }) => {
                const done = await ports.setUsedInEveryChat(who(context), book, used);
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                return { changed: [WORLDS_VIEW, WORLD_VIEW] };
            },
        },
    });
}
