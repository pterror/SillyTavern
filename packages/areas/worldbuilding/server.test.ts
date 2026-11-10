import * as v from 'valibot';
import { expect, test } from 'vite-plus/test';
import type { Looks, ResolvedLook } from '@st/protocol/looks';
import { READS_OF_LOOKS_BESIDES_THINGS } from '@st/looks/protocol';

import {
    actions,
    cardsPerTopLevelEntry,
    ENTRY_VIEW,
    FOUND_PER_QUERY,
    FOUND_VIEW,
    KEY_SHARERS_SHOWN,
    KEY_SHARERS_VIEW,
    LAST_CHANGE_VIEW,
    LOOP_CHECK_VISITS_PER_WRITE,
    LOOPS_LEFT_BY_JOBS_VIEW,
    MAX_CARDS_PER_READ,
    MENTION_PAGES_AT_MOST,
    OVERVIEW_VIEW,
    placementFields,
    POINTING_AT_VIEW,
    READ_REFUSAL,
    RELATION_KINDS_VIEW,
    RESULTS_VIEW,
    SELECTION_VIEW,
    BULK_JOBS_VIEW,
    PICKED_AT_MOST,
    READS_PER_CARD,
    READS_PER_DRAWN_CARD,
    READS_PER_LOOK,
    READS_OF_TEXT_LINKS,
    READS_OF_LOOKS_PER_PART,
    READS_PER_LABEL,
    READS_PER_LOOP_CHECK_VISIT,
    READS_PER_MENTION_CHECK,
    READS_PER_REQUEST,
    READS_OF_ACTION,
    READS_PER_VIEW,
    STEP_CARDS_AT_MOST,
    READS_OF_COUNTED_LABELS,
    MENTION_CHECKS_PER_READ,
    SELECTION_WALK_STEPS,
    TEXT_LINK_READS_PER_READ,
    WALK_STEPS_PER_READ,
    WORLD_VIEW,
    WORLDS_VIEW,
} from './protocol.ts';
import type {
    KeySharersView,
    BulkAction,
    BulkJob,
    BulkJobsView,
    SelectionView,
    EntryCell,
    EntryView,
    FoundView,
    ResultsView,
    LastChangeView,
    Named,
    OpenEntryView,
    LoopsLeftByJobsView,
    NamesOffer,
    OverviewLayout,
    OverviewView,
    PointingAtSection,
    PointingAtView,
    RelationKindsView,
    ShownLoop,
    World,
    WorldsView,
    WorldView,
} from './protocol.ts';
import { rangeAround, worldbuildingArea } from './server.ts';
import type {
    EntryCreation,
    EntryEdit,
    EntryRead,
    Grouping,
    HeldSelection,
    OverviewStep,
    PagesRun,
    PointingAtQuery,
    Ports,
    RelationChange,
    ResultsQuery,
} from './server.ts';
import type { ActionContext, ActionResult, Upload, User } from '@st/server-ui';

const LOOK: ResolvedLook = {
    layers: { rest: [{ property: 'color', value: 'teal' }] },
    picture: { before: false, after: false, crop: null, image: null },
    note: null,
    fonts: [],
};
const user: User = { handle: 'u', directories: { root: '/u' } };

const NOTHING_CHANGED: LastChangeView = {
    createdKind: null,
    changedRelation: null,
    createdEntry: null,
    deletedEntry: null,
    movedEntry: null,
    markedTitleKeys: null,
    unreachedLoops: [],
    moreUnreachedLoops: 0,
};

const named = (thing: string, text: string): Named => ({ thing, text, shownAs: 'name' });

const LOOP_OF_7: ShownLoop = {
    entry: named('7', 'name 7'),
    kind: '1',
    kindName: 'in',
    target: named('8', 'name 8'),
    entries: [named('7', 'name 7'), named('8', 'name 8')],
    moreEntries: 0,
};

const PLACEMENT = v.parse(v.object(placementFields), {
    keysecondary: [],
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: false,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
    characterFilter: { isExclude: false, names: [], tags: [] },
});

const LAYOUT: OverviewLayout = { regionsByNestingLevel: [{ columns: 3, rows: 2 }], cardTextCharacters: 300 };

const card = (occurrence: string, topLevelRank: number): EntryCell & { topLevelRank: number } => ({
    cell: 'entry',
    occurrence,
    entry: occurrence,
    entryKey: occurrence,
    label: { thing: occurrence, text: '', shownAs: 'opening' },
    title: null,
    text: '',
    textCut: false,
    keys: [],
    names: [],
    relations: [],
    groupingKindRelationsTargetingThis: 0,
    alreadyOpenAbove: false,
    region: [],
    topLevelRank,
});

const resultCard = (rank: number): EntryCell => {
    const { topLevelRank: _, ...cell } = card(String(300 + rank), rank);
    return cell;
};

const SOURCES_FROM = 1000;

const rankOf = (occurrence: string) => Number(occurrence.split('/')[1]) - SOURCES_FROM;

const source = (kind: string, entry: string, rank: number) => ({
    ...card(String(SOURCES_FROM + rank), rank),
    occurrence: `${kind}@${entry}/${SOURCES_FROM + rank}`,
});

const cardsOf = (layout: OverviewLayout) => cardsPerTopLevelEntry(layout.regionsByNestingLevel);
const crossedBy = (step: OverviewStep) => ('by' in step ? Math.abs(step.by) + 1 : 1);
const loopCheck = (limit: number) => limit * READS_PER_LOOP_CHECK_VISIT;

// Counts the reads each bounded port is asked for, at the most its bounds let it read: cards, steps, loop checks, mention
// checks, the names a text writes, walks and labels. What a world holds a count of (worlds, kinds, jobs, chips) isn't
// bounded and isn't counted.
type Costs = { [K in keyof Ports]?: (...args: Parameters<Ports[K]>) => number };

const READS_ASKED: Costs = {
    readWorld: () => READS_PER_LABEL,
    looksOf: (_c, _v, things) => (things.length === 0 ? 0 : READS_OF_LOOKS_BESIDES_THINGS),
    readOverview: (_u, q) => (q.endRank - q.firstRank) * cardsOf(q.layout) * READS_PER_DRAWN_CARD,
    stepOverview: (_u, q) => crossedBy(q) * cardsOf(q.layout) * READS_PER_CARD,
    readPointingAt: (_u, q) => q.maxCards * READS_PER_DRAWN_CARD,
    stepPointingAt: (_u, q) => crossedBy(q) * cardsOf(q.layout) * READS_PER_CARD,
    labelEntries: (_u, _b, entries) => entries.length * READS_PER_LABEL,
    readResults: (_u, q) => q.pages * q.pageSize * READS_PER_DRAWN_CARD + q.walkSteps,
    findEntries: (_u, q) => q.limit * READS_PER_LABEL,
    readSelection: (_u, selection, walkSteps) => selection.except.length + walkSteps,
    // The first chunk walks in the engine's own share (WALK_STEPS_PER_READ) before its loop check.
    startBulk: (_w, _s, _a, limit) => WALK_STEPS_PER_READ + loopCheck(limit),
    changeRelation: (_w, _b, _c, limit) => loopCheck(limit),
    // Each entry the text names costs at least two of its reads, and its look one more.
    readEntry: (_u, _b, _e, asked) =>
        asked.textLinkReads +
        Math.ceil(asked.textLinkReads / 2) * READS_PER_LOOK +
        asked.mentionChecks * READS_PER_MENTION_CHECK,
    readKeySharers: (_u, q) => q.limit * READS_PER_LABEL,
    createEntry: (_w, _b, _c, limit) => loopCheck(limit),
    // These run the engine's loop check at its own limit.
    deleteEntry: () => loopCheck(LOOP_CHECK_VISITS_PER_WRITE),
    restoreEntry: () => loopCheck(LOOP_CHECK_VISITS_PER_WRITE),
    moveEntryToWorld: () => loopCheck(LOOP_CHECK_VISITS_PER_WRITE),
};

// Counts the reads each bounded port is asked for, at the most its bounds let it read: cards, steps, loop checks, mention
// checks, the names a text writes, walks and labels. What a world holds a count of (worlds, kinds, jobs, chips) isn't
// bounded and isn't counted.
function countingReads(ports: Ports, reads: { asked: number }): Ports {
    type Port = (...args: unknown[]) => Promise<unknown>;
    const counted = Object.entries(ports as Record<string, Port>).map(([key, port]) => {
        const cost = READS_ASKED[key as keyof Ports] as ((...args: unknown[]) => number) | undefined;
        const countedPort: Port = (...args) => {
            reads.asked += cost?.(...args) ?? 0;
            return port(...args);
        };
        return [key, countedPort];
    });
    return Object.fromEntries(counted) as Ports;
}

function world(
    count: number,
    { worlds: listed = ['1', '2'], results = 5 }: { worlds?: string[]; results?: number } = {},
) {
    const asked: {
        overview: unknown[];
        step: (Grouping & OverviewStep)[];
        changes: { book: string; change: RelationChange; loopCheckLimit: number; session: string }[];
        edits: { book: string; entry: string; edit: EntryEdit; session: string }[];
        created: { book: string; creation: EntryCreation; loopCheckLimit: number }[];
        entryReads: { book: string; entry: string; mentions: PagesRun }[];
        deleted: string[];
        restored: string[];
        moved: { entry: string; toBook: string }[];
        opened: (string | null)[];
        imported: Upload[];
        pointingAt: PointingAtQuery[];
        pointingAtSteps: unknown[];
        results: ResultsQuery[];
        found: { book: string; query: string; limit: number }[];
        sharers: { book: string; entry: string; key: string; limit: number }[];
        namesOffer: [string, string][];
        selections: HeldSelection[];
        bulk: { selection: HeldSelection; action: BulkAction; loopCheckLimit: number; session: string }[];
        looks: { view: string; session: string; things: string[] }[];
    } = {
        looks: [],
        overview: [],
        step: [],
        changes: [],
        edits: [],
        created: [],
        entryReads: [],
        deleted: [],
        restored: [],
        moved: [],
        opened: [],
        imported: [],
        pointingAt: [],
        pointingAtSteps: [],
        results: [],
        found: [],
        sharers: [],
        namesOffer: [],
        selections: [],
        bulk: [],
    };
    const bulkJobs: BulkJob[] = [];
    const offers = new Map<string, NamesOffer | null>([
        [
            '1',
            { entries: 212, example: { thing: '7', text: 'Gerold Venn', shownAs: 'title' }, running: null, marked: 0 },
        ],
    ]);
    const changeOffer = (
        book: string,
        change: string,
        to: (offer: NamesOffer | null) => NamesOffer | null | string,
    ) => {
        asked.namesOffer.push([change, book]);
        if (!worlds.has(book)) return 'missing' as const;
        const changed = to(offers.get(book) ?? null);
        if (typeof changed === 'string') return { refused: changed };
        offers.set(book, changed);
        return 'ok' as const;
    };
    const worlds = new Map<string, World>(
        listed.map((id) => [id, { id, name: `World ${id}`, entries: id === '1' ? 2 : 0, usedInEveryChat: false }]),
    );
    let lastOpened: string | null = null;
    let nextWorld = 10;
    const made = (name: string) => {
        if ([...worlds.values()].some((w) => w.name === name))
            return { refused: `A world named "${name}" already exists.` };
        const id = String(nextWorld++);
        worlds.set(id, { id, name, entries: 0, usedInEveryChat: false });
        return { book: id };
    };
    const entries = new Map<string, { text: string; deleted: boolean }>([
        ['7', { text: 'Ilse keeps the lamp.', deleted: false }],
        ['8', { text: 'The Lantern House', deleted: false }],
    ]);
    let nextEntry = 50;
    // What mentions an entry: three pages, `p0` (read at null), `p1` and `p2`, each naming the entry `m<page>`.
    const mentionsPage = (at: number) => ({
        cursor: at === 0 ? null : `p${at}`,
        entries: [{ from: named(`m${at}`, `name m${at}`), sentence: { before: '', mention: 'Ilse', after: '.' } }],
        next: at < 2 ? `p${at + 1}` : null,
        lookedThrough: at + 1,
        stoppedForBound: false,
    });
    const entryRead = (entry: string, { from, pages }: PagesRun): EntryRead => {
        const found = entries.get(entry);
        if (!found) return null;
        if (found.deleted) return { deleted: true };
        return {
            deleted: false,
            entryKey: entry,
            label: named(entry, `name ${entry}`),
            title: null,
            keys: [{ text: `name ${entry}`, isName: true, alsoBringsUp: 0 }],
            text: found.text,
            links: entry === '7' ? [{ entry: '8', from: 0, to: 3 }] : [],
            linksComplete: true,
            relations: [],
            placement: PLACEMENT,
            placementDiffersFromDefaults: false,
            tokens: found.text.length,
            mentionedIn: {
                pages: Array.from({ length: pages }, (_, at) => at + (from === null ? 0 : Number(from.slice(1))))
                    .filter((at) => at <= 2)
                    .map(mentionsPage),
            },
        };
    };
    const kinds: { id: string; name: string; mergingInto: string | null }[] = [
        { id: '1', name: 'in', mergingInto: null },
    ];
    const pointedAt = (entry: string) =>
        entry === '7'
            ? [
                  { kind: '1', sources: 500 },
                  { kind: '2', sources: 3 },
              ]
            : [];
    const ports: Ports = {
        looksOf: async (context, view, things) => {
            asked.looks.push({ view, session: context.session, things });
            return { styles: { s: LOOK }, things: Object.fromEntries(things.map((thing) => [thing, 's'])) };
        },
        readWorlds: async () => [...worlds.values()].sort((a, b) => a.name.localeCompare(b.name)),
        readWorld: async (_u, book) => {
            const found = worlds.get(book);
            return found ? { ...found, namesOffer: offers.get(book) ?? null } : null;
        },
        markTitleKeysAsNames: async (_w, book) =>
            changeOffer(book, 'mark', (offer) =>
                offer?.running === null
                    ? { ...offer, running: 'marking', marked: 1000, entries: offer.entries - 1000 }
                    : 'This world offers no names to mark.',
            ),
        declineNamesOffer: async (_w, book) =>
            changeOffer(book, 'decline', (offer) =>
                offer?.running === null ? null : 'This world offers no names to mark.',
            ),
        undoMarkTitleKeysAsNames: async (_w, book) =>
            changeOffer(book, 'undo', (offer) =>
                offer?.running === 'marking' ? { ...offer, running: 'undoing' } : 'Nothing was marked to take back.',
            ),
        openWorld: async (_w, book) => {
            asked.opened.push(book);
            const opened =
                book ??
                (lastOpened !== null && worlds.has(lastOpened) ? lastOpened : null) ??
                [...worlds.keys()][0] ??
                null;
            if (opened === null || !worlds.has(opened)) return null;
            lastOpened = opened;
            return opened;
        },
        createWorld: async (_w, name) => made(name),
        renameWorld: async (_w, book, name) => {
            const found = worlds.get(book);
            if (!found) return 'missing';
            if ([...worlds.values()].some((w) => w.name === name && w.id !== book))
                return { refused: `A world named "${name}" already exists.` };
            found.name = name;
            return 'ok';
        },
        duplicateWorld: async (_w, book) => {
            const found = worlds.get(book);
            return found ? made(`${found.name} (1)`) : 'missing';
        },
        deleteWorld: async (_w, book) => {
            const listed = await ports.readWorlds(user);
            const at = listed.findIndex((listedWorld) => listedWorld.id === book);
            if (!worlds.delete(book)) return 'missing';
            return { next: (listed[at + 1] ?? listed[at - 1])?.id ?? null };
        },
        importWorld: async (_w, file) => {
            asked.imported.push(file);
            return file.name.endsWith('.txt') ? { refused: "This file isn't a world." } : made(file.name.slice(0, -5));
        },
        exportWorld: async (_u, book) => {
            const found = worlds.get(book);
            return found ? { fileName: `${found.name}.json`, json: '{"entries":{}}' } : null;
        },
        setUsedInEveryChat: async (_w, book, used) => {
            const found = worlds.get(book);
            if (!found) return 'missing';
            found.usedInEveryChat = used;
            return 'ok';
        },
        readOverview: async (_u, q) => {
            asked.overview.push(q);
            if (q.book !== '1') return null;
            const entries = [];
            for (let r = q.firstRank; r < Math.min(q.endRank, count); r++) entries.push(card(String(r + 100), r));
            const rank = q.stepLandedOn === null ? -1 : Number(q.stepLandedOn.split('/')[0]) - 100;
            return {
                topLevelCount: count,
                firstRank: q.firstRank,
                entries,
                stepLanding:
                    rank >= 0 && rank < count ? { occurrence: q.stepLandedOn ?? '', topLevelRank: rank } : null,
            };
        },
        stepOverview: async (_u, { layout, ...q }) => {
            void layout;
            asked.step.push(q);
            if ('to' in q)
                return {
                    occurrence: q.from.includes('/') ? q.from.slice(0, q.from.lastIndexOf('/')) : q.from,
                    topLevelRank: 0,
                };
            const at = q.from === null ? (q.by > 0 ? -1 : count) : Number(q.from.split('/')[0]) - 100;
            const rank = Math.max(0, Math.min(count - 1, at + q.by));
            return count === 0 || (q.from !== null && (at < 0 || at >= count))
                ? null
                : { occurrence: String(rank + 100), topLevelRank: rank };
        },
        readPointingAt: async (_u, q) => {
            asked.pointingAt.push(q);
            const found = entries.get(q.entry);
            if (q.book !== '1' || !found || found.deleted) return null;
            return pointedAt(q.entry).map(({ kind, sources }): PointingAtSection => {
                const held = q.held.find((range) => range.kind === kind);
                const [firstRank, endRank] = held ? [held.firstRank, held.endRank] : [0, q.endRank];
                const shown = [];
                for (let r = firstRank; r < Math.min(endRank, sources); r++) shown.push(source(kind, q.entry, r));
                const landed = held?.stepLandedOn ?? null;
                return {
                    kind,
                    kindName: kinds.find((listed) => listed.id === kind)?.name ?? null,
                    count: sources,
                    firstRank,
                    entries: shown,
                    stepLanding: landed === null ? null : { occurrence: landed, topLevelRank: rankOf(landed) },
                };
            });
        },
        stepPointingAt: async (_u, { layout, ...q }) => {
            void layout;
            asked.pointingAtSteps.push(q);
            const sources = pointedAt(q.entry).find((listed) => listed.kind === q.kind)?.sources ?? 0;
            const at = q.from === null ? ('by' in q && q.by < 0 ? sources : -1) : rankOf(q.from);
            if (q.from !== null && (!q.from.startsWith(`${q.kind}@${q.entry}/`) || at < 0 || at >= sources)) {
                return null;
            }
            const rank = 'by' in q ? Math.max(0, Math.min(sources - 1, at + q.by)) : at;
            return { occurrence: source(q.kind, q.entry, rank).occurrence, topLevelRank: rank };
        },
        readRelationKinds: async (_u, book) => (book === '1' ? kinds : null),
        labelEntries: async (_u, book, listed) =>
            listed.map((entry) => {
                const found = entries.get(entry);
                return book === '1' && found && !found.deleted ? named(entry, `name ${entry}`) : null;
            }),
        readResults: async (_u, q) => {
            asked.results.push(q);
            return {
                chips: q.chips.map(({ kind, target }) => ({
                    kindName: kinds.find((listed) => listed.id === kind)?.name ?? null,
                    target: entries.get(target)?.deleted === false ? named(target, `name ${target}`) : null,
                })),
                pages: (() => {
                    const read = [];
                    let cursor = q.from;
                    while (read.length < q.pages) {
                        const at = cursor === null ? 0 : Number(cursor.slice(1));
                        const entries = [];
                        for (let r = at; r < Math.min(at + q.pageSize, results); r++) entries.push(resultCard(r));
                        const next = at + q.pageSize < results ? `c${at + q.pageSize}` : null;
                        read.push({ cursor, entries, next });
                        if (next === null) break;
                        cursor = next;
                    }
                    return read;
                })(),
            };
        },
        findEntries: async (_u, q) => {
            asked.found.push(q);
            return { entries: q.query === '' ? [] : [named('7', 'name 7')], next: null };
        },
        readLoopsLeftByJobs: async (_u, book) => (book === '1' ? [{ entry: '7', kind: '1', entries: ['7', '8'] }] : []),
        readSelection: async (_u, selection) => {
            asked.selections.push(selection);
            if (selection.book !== '1') return null;
            if (selection.base === 'none') {
                const except = selection.except.filter((entry) => entries.get(entry)?.deleted === false);
                return { except, matching: null, matchingCapped: false };
            }
            const matched = selection.filter === null ? 1500 : results;
            const selected = matched - selection.except.length;
            return { except: selection.except, matching: Math.min(selected, 1000), matchingCapped: selected > 1000 };
        },
        startBulk: async ({ session }, selection, action, loopCheckLimit) => {
            asked.bulk.push({ selection, action, loopCheckLimit, session });
            if (selection.book !== '1') return 'missing';
            if ('moveTo' in action && action.moveTo.target === '999') {
                return { refused: "The target isn't an entry of this world." };
            }
            bulkJobs.push({ job: String(bulkJobs.length + 1), action, target: null, done: 1000 });
            return { unreachedLoops: 'moveTo' in action ? [{ entry: '7', kind: '1', entries: ['7', '8'] }] : [] };
        },
        readBulkJobs: async (_u, book) => (book === '1' ? bulkJobs : null),
        createRelationKind: async (_w, book, name) => {
            if (book !== '1') return null;
            kinds.push({ id: String(kinds.length + 1), name, mergingInto: null });
            return String(kinds.length);
        },
        renameRelationKind: async (_w, _b, kind, name) => {
            const found = kinds.find((existing) => existing.id === kind);
            if (!found) return 'no kind';
            found.name = name;
            return 'ok';
        },
        deleteRelationKind: async (_w, _b, kind) => {
            if (kind === '1') return 'in use';
            const at = kinds.findIndex((existing) => existing.id === kind);
            if (at === -1) return 'no kind';
            kinds.splice(at, 1);
            return 'ok';
        },
        mergeRelationKind: async (_w, _b, kind, into) => {
            if (kind === into) return 'same kind';
            const merged = kinds.find((existing) => existing.id === kind);
            if (!merged || !kinds.some((existing) => existing.id === into)) return 'no kind';
            if (merged.mergingInto !== null) return 'being merged';
            merged.mergingInto = into;
            return 'ok';
        },
        readEntry: async (_u, book, entry, { mentions }) => {
            asked.entryReads.push({ book, entry, mentions });
            return book === '1' ? entryRead(entry, mentions) : null;
        },
        readKeySharers: async (_u, { book, entry, key, limit }) => {
            asked.sharers.push({ book, entry, key, limit });
            if (book !== '1') return null;
            return { entries: key === 'Ilse' ? [named('8', 'name 8')] : [], more: false };
        },
        editEntry: async ({ session }, book, entry, edit) => {
            asked.edits.push({ book, entry, edit, session });
            if (book !== '1') return 'missing';
            const found = entries.get(entry);
            if (!found || found.deleted) return 'no entry';
            if (edit.change === 'setKeyAs' && edit.key !== `name ${entry}`)
                return { refused: 'That entry has no such key.' };
            if (edit.change === 'text') found.text = edit.text;
            return 'ok';
        },
        createEntry: async (_w, book, creation, loopCheckLimit) => {
            asked.created.push({ book, creation, loopCheckLimit });
            if (book !== '1') return 'missing';
            if (creation.relation?.target === '999') return { refused: "The target isn't an entry of this world." };
            const entry = String(nextEntry++);
            entries.set(entry, { text: '', deleted: false });
            return {
                entry,
                unreachedLoops: creation.relation ? [{ entry, kind: creation.relation.kind, entries: [entry] }] : [],
            };
        },
        deleteEntry: async (_w, book, entry) => {
            asked.deleted.push(entry);
            if (book !== '1') return 'missing';
            const found = entries.get(entry);
            if (!found || found.deleted) return 'no entry';
            found.deleted = true;
            return { label: named(entry, `name ${entry}`), unreachedLoops: [] };
        },
        restoreEntry: async (_w, book, entry) => {
            asked.restored.push(entry);
            const found = entries.get(entry);
            if (book !== '1') return 'missing';
            if (found?.deleted !== true) return 'no entry';
            found.deleted = false;
            return { unreachedLoops: [{ entry, kind: '1', entries: [entry, '8'] }] };
        },
        moveEntryToWorld: async (_w, book, entry, toBook) => {
            asked.moved.push({ entry, toBook });
            if (toBook === '3') return { refused: 'The world to move it to no longer exists.' };
            if (book !== '1' || !entries.has(entry)) return 'no entry';
            entries.delete(entry);
            return { entry: '90', unreachedLoops: [] };
        },
        changeRelation: async ({ session }, book, change, loopCheckLimit) => {
            asked.changes.push({ book, change, loopCheckLimit, session });
            if (change.target === '999') return { refused: "The target isn't an entry of this world." };
            if (change.entry === '8') {
                return {
                    unreachedLoops: [
                        { entry: '8', kind: '2', entries: ['8', '7', '404', '405'] },
                        { entry: '404', kind: '1', entries: ['404', '8'] },
                        { entry: '7', kind: '1', entries: ['7'] },
                        { entry: '7', kind: '1', entries: ['7', '8'] },
                    ],
                };
            }
            return {
                unreachedLoops: change.entry === '7' ? [{ entry: '7', kind: change.kind, entries: ['7', '8'] }] : [],
            };
        },
    };
    const reads = { asked: 0 };
    const area = worldbuildingArea(countingReads(ports, reads));
    const context: ActionContext = { user, session: 's', chat: null, upload: null };
    const withoutLooks = async <T>(read: Promise<unknown>): Promise<T> => {
        const { looks: _, ...value } = (await read) as { looks: unknown };
        return value as T;
    };
    const view = <T>(key: string) => withoutLooks<T>(area.views[key]!(context) as Promise<unknown>);
    const parsed = (type: string, payload: unknown) =>
        v.parse(actions[type as keyof typeof actions] as v.GenericSchema, payload);
    const act = (type: string, payload: unknown, upload: Upload | null = null): Promise<ActionResult> =>
        area.actions[type]!({ ...context, upload }, parsed(type, payload));
    const other = (type: string, payload: unknown): Promise<ActionResult> =>
        area.actions[type]!({ ...context, session: 't' }, parsed(type, payload));
    const otherView = <T>(key: string) =>
        withoutLooks<T>(area.views[key]!({ ...context, session: 't' }) as Promise<unknown>);
    const drawnView = (key: string) => area.views[key]!(context) as Promise<{ looks: Looks }>;
    return { view, drawnView, act, other, otherView, asked, reads, views: Object.keys(area.views) };
}

const WORLD_VIEWS = [
    OVERVIEW_VIEW,
    RESULTS_VIEW,
    RELATION_KINDS_VIEW,
    LAST_CHANGE_VIEW,
    LOOPS_LEFT_BY_JOBS_VIEW,
    WORLD_VIEW,
    SELECTION_VIEW,
    BULK_JOBS_VIEW,
];

const open = { book: '1', groupBy: '1', firstRank: 0, endRank: 20, layout: LAYOUT, around: null };

const pointingAt = { endRank: 12, layout: LAYOUT };

test('every view carries the looks of exactly the names it draws, and the looks know which session drew them', async () => {
    const w = world(1000);
    await w.act('worldbuilding.openOverview', { ...open, endRank: 3 });
    await w.act('worldbuilding.openEntry', { entry: '7', pointingAt });
    const overview = await w.drawnView(OVERVIEW_VIEW);
    expect(Object.keys(overview.looks.things)).toEqual(['100', '101', '102']);
    expect(overview.looks.styles).toEqual({ s: LOOK });
    const entry = await w.drawnView(ENTRY_VIEW);
    expect(Object.keys(entry.looks.things)).toEqual(expect.arrayContaining(['7', '8']));
    const worlds = await w.drawnView(WORLDS_VIEW);
    expect(Object.keys(worlds.looks.things).sort()).toEqual(['1', '2']);
    expect(Object.keys((await w.drawnView(WORLD_VIEW)).looks.things)).toEqual(['1', '7']);
    expect(Object.keys((await w.drawnView(SELECTION_VIEW)).looks.things)).toEqual([]);
    expect(w.asked.looks.find((l) => l.view === ENTRY_VIEW)).toMatchObject({ session: 's' });
});

test('opening a world opens its overview, its kinds and the last change in the same answer, at the range asked for', async () => {
    const w = world(1000);
    expect(await w.view<OverviewView>(OVERVIEW_VIEW)).toEqual({
        book: null,
        groupBy: null,
        topLevelCount: 0,
        firstRank: 0,
        entries: [],
        stepLanding: null,
    });
    expect(await w.act('worldbuilding.openOverview', open)).toEqual({
        changed: [],
        opensViews: WORLD_VIEWS,
        own: [OVERVIEW_VIEW, WORLD_VIEW],
    });
    expect(await w.view<WorldView>(WORLD_VIEW)).toEqual({
        id: '1',
        name: 'World 1',
        entries: 2,
        usedInEveryChat: false,
        namesOffer: {
            entries: 212,
            example: { thing: '7', text: 'Gerold Venn', shownAs: 'title' },
            running: null,
            marked: 0,
        },
    });
    expect(await w.view<LoopsLeftByJobsView>(LOOPS_LEFT_BY_JOBS_VIEW)).toEqual({
        book: '1',
        unreachedLoops: [LOOP_OF_7],
        moreUnreachedLoops: 0,
    });
    const shown = await w.view<OverviewView>(OVERVIEW_VIEW);
    expect(shown).toMatchObject({ book: '1', groupBy: '1', topLevelCount: 1000, firstRank: 0, stepLanding: null });
    expect(shown.entries.map((i) => i.topLevelRank)).toEqual([...Array(20).keys()]);
    expect(w.asked.overview[0]).toMatchObject({ layout: LAYOUT });
    expect(await w.view<RelationKindsView>(RELATION_KINDS_VIEW)).toEqual({
        book: '1',
        kinds: [{ id: '1', name: 'in', mergingInto: null }],
    });
    expect(w.asked.step).toEqual([]);
});

test('opening around an occurrence puts the range around its top-level entry and marks where it landed', async () => {
    const w = world(1000);
    await w.act('worldbuilding.openOverview', { ...open, around: '600/7/+' });
    expect(w.asked.step).toEqual([{ book: '1', groupBy: '1', from: '600/7/+', by: 0 }]);
    const shown = await w.view<OverviewView>(OVERVIEW_VIEW);
    expect(shown.firstRank).toBe(490);
    expect(shown.entries).toHaveLength(20);
    expect(shown.stepLanding).toEqual({ occurrence: '600', topLevelRank: 500 });
});

test('showing a range reads it; nothing is shown before a world is opened', async () => {
    const w = world(1000);
    expect(await w.act('worldbuilding.showRange', { firstRank: 40, endRank: 60 })).toEqual({
        refused: 'No world is shown.',
    });
    await w.act('worldbuilding.openOverview', { ...open, groupBy: null });
    expect(await w.act('worldbuilding.showRange', { firstRank: 40, endRank: 60 })).toEqual({
        changed: [OVERVIEW_VIEW],
    });
    const shown = await w.view<OverviewView>(OVERVIEW_VIEW);
    expect([shown.firstRank, shown.entries[0]?.topLevelRank, shown.groupBy]).toEqual([40, 40, null]);
});

test('a step lands where the store says, keeps the range when that is in it and follows it when it is not', async () => {
    const w = world(1000);
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.stepOverview', { from: '105', by: 1 });
    let shown = await w.view<OverviewView>(OVERVIEW_VIEW);
    expect([shown.firstRank, shown.stepLanding]).toEqual([0, { occurrence: '106', topLevelRank: 6 }]);
    await w.act('worldbuilding.stepOverview', { from: '106', by: 30 });
    shown = await w.view<OverviewView>(OVERVIEW_VIEW);
    expect([shown.firstRank, shown.stepLanding]).toEqual([26, { occurrence: '136', topLevelRank: 36 }]);
    await w.act('worldbuilding.stepOverview', { from: '136/3', to: 'parent' });
    expect(w.asked.step.at(-1)).toEqual({ book: '1', groupBy: '1', from: '136/3', to: 'parent' });
    expect((await w.view<OverviewView>(OVERVIEW_VIEW)).stepLanding).toEqual({ occurrence: '136', topLevelRank: 36 });
    expect(await w.act('worldbuilding.stepOverview', { from: '5000', by: 1 })).toEqual({
        refused: 'That is no longer shown.',
        changed: [OVERVIEW_VIEW],
    });
});

test("a world the store can't read shows nothing", async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', { ...open, book: '2' });
    expect(await w.view<OverviewView>(OVERVIEW_VIEW)).toMatchObject({ book: null, entries: [] });
    expect(await w.view<RelationKindsView>(RELATION_KINDS_VIEW)).toEqual({ book: null, kinds: [] });
});

const unopened = { book: null, groupBy: null, firstRank: 0, endRank: 20, layout: LAYOUT, around: null };
const drawn = { firstRank: 0, endRank: 20, layout: LAYOUT };
const listedNames = async (w: ReturnType<typeof world>) =>
    (await w.view<WorldsView>(WORLDS_VIEW)).worlds.map((listed) => listed.name);

test('opening no world in particular opens the last one opened, else the first; with none it opens the worlds list', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', { ...open, book: '2', groupBy: null });
    expect(await w.act('worldbuilding.openOverview', unopened)).toEqual({
        changed: [],
        opensViews: WORLD_VIEWS,
        own: [OVERVIEW_VIEW, WORLD_VIEW],
    });
    expect(w.asked.opened).toEqual(['2', null]);
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ id: '2' });
    await w.view<OverviewView>(OVERVIEW_VIEW);
    expect(w.asked.overview.at(-1)).toMatchObject({ book: '2', groupBy: null });

    const none = world(3, { worlds: [] });
    await none.act('worldbuilding.openEntry', { entry: '7', pointingAt });
    expect(await none.act('worldbuilding.openOverview', unopened)).toEqual({
        changed: [
            OVERVIEW_VIEW,
            RESULTS_VIEW,
            RELATION_KINDS_VIEW,
            LAST_CHANGE_VIEW,
            LOOPS_LEFT_BY_JOBS_VIEW,
            ENTRY_VIEW,
            POINTING_AT_VIEW,
            SELECTION_VIEW,
            BULK_JOBS_VIEW,
        ],
        opensViews: [WORLD_VIEW, WORLDS_VIEW],
        own: [
            OVERVIEW_VIEW,
            RESULTS_VIEW,
            RELATION_KINDS_VIEW,
            LAST_CHANGE_VIEW,
            LOOPS_LEFT_BY_JOBS_VIEW,
            ENTRY_VIEW,
            POINTING_AT_VIEW,
            SELECTION_VIEW,
            BULK_JOBS_VIEW,
            WORLD_VIEW,
            WORLDS_VIEW,
        ],
    });
    expect(await none.view<WorldView>(WORLD_VIEW)).toEqual({ id: null });
    expect(await none.view<WorldsView>(WORLDS_VIEW)).toEqual({ worlds: [] });
    expect(await none.view<EntryView>(ENTRY_VIEW)).toEqual({ book: null });
});

test('the worlds list opens by its own action and lists every world in name order with its entries and whether it is used in every chat', async () => {
    const w = world(3);
    expect(await w.act('worldbuilding.openWorlds', {})).toEqual({ changed: [], opensViews: [WORLDS_VIEW] });
    expect(await w.view<WorldsView>(WORLDS_VIEW)).toEqual({
        worlds: [
            { id: '1', name: 'World 1', entries: 2, usedInEveryChat: false },
            { id: '2', name: 'World 2', entries: 0, usedInEveryChat: false },
        ],
    });
    expect(await w.act('worldbuilding.setUsedInEveryChat', { book: '2', used: true })).toEqual({
        changed: [WORLDS_VIEW, WORLD_VIEW],
    });
    expect((await w.view<WorldsView>(WORLDS_VIEW)).worlds[1]?.usedInEveryChat).toBe(true);
    expect(await w.act('worldbuilding.setUsedInEveryChat', { book: '9', used: true })).toEqual({
        refused: 'That world no longer exists.',
        changed: [WORLDS_VIEW],
    });
});

test('making a world names it, opens it at the range asked for and answers the worlds list; a taken name is refused', async () => {
    const w = world(3);
    expect(await w.act('worldbuilding.createWorld', { name: ' Saltmarrow ', overview: drawn })).toEqual({
        changed: [WORLDS_VIEW],
        opensViews: WORLD_VIEWS,
        own: [OVERVIEW_VIEW, WORLD_VIEW, WORLDS_VIEW],
    });
    expect(await w.view<WorldView>(WORLD_VIEW)).toEqual({
        id: '10',
        name: 'Saltmarrow',
        entries: 0,
        usedInEveryChat: false,
        namesOffer: null,
    });
    expect(await w.view<OverviewView>(OVERVIEW_VIEW)).toMatchObject({ book: null });
    expect(w.asked.overview.at(-1)).toMatchObject({ book: '10', groupBy: null, firstRank: 0, endRank: 20 });
    expect(await w.act('worldbuilding.createWorld', { name: 'Saltmarrow', overview: drawn })).toEqual({
        refused: 'A world named "Saltmarrow" already exists.',
    });
    expect(await listedNames(w)).toEqual(['Saltmarrow', 'World 1', 'World 2']);
});

test('renaming a world answers the list and the header; a taken name or a gone world is refused', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    expect(await w.act('worldbuilding.renameWorld', { book: '1', name: 'Lantern' })).toEqual({
        changed: [WORLDS_VIEW, WORLD_VIEW],
    });
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ id: '1', name: 'Lantern' });
    expect(await w.act('worldbuilding.renameWorld', { book: '2', name: 'Lantern' })).toEqual({
        refused: 'A world named "Lantern" already exists.',
    });
    expect(await w.act('worldbuilding.renameWorld', { book: '9', name: 'x' })).toEqual({
        refused: 'That world no longer exists.',
        changed: [WORLDS_VIEW],
    });
});

test('duplicating a world opens the copy; importing a file opens what it made, and needs a file', async () => {
    const w = world(3);
    expect(await w.act('worldbuilding.duplicateWorld', { book: '1', overview: drawn })).toMatchObject({
        changed: [WORLDS_VIEW],
        opensViews: WORLD_VIEWS,
    });
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ id: '10', name: 'World 1 (1)' });
    expect(await w.act('worldbuilding.duplicateWorld', { book: '9', overview: drawn })).toEqual({
        refused: 'That world no longer exists.',
        changed: [WORLDS_VIEW],
    });
    expect(await w.act('worldbuilding.importWorld', { overview: drawn })).toEqual({
        refused: 'Choose a file to import.',
    });
    const file: Upload = { path: '/tmp/upload', name: 'Ashfall.json', type: 'application/json', size: 20 };
    expect(await w.act('worldbuilding.importWorld', { overview: drawn }, file)).toMatchObject({
        changed: [WORLDS_VIEW],
        opensViews: WORLD_VIEWS,
    });
    expect(w.asked.imported).toEqual([file]);
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ id: '11', name: 'Ashfall' });
    expect(await w.act('worldbuilding.importWorld', { overview: drawn }, { ...file, name: 'notes.txt' })).toEqual({
        refused: "This file isn't a world.",
    });
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ id: '11' });
});

test('deleting the shown world opens the one the list orders after it, else before it, at the range it showed', async () => {
    const w = world(3, { worlds: ['1', '2', '3'] });
    await w.act('worldbuilding.openOverview', { ...open, book: '2', firstRank: 5, endRank: 15 });
    await w.act('worldbuilding.openEntry', { entry: '7', pointingAt });
    await w.other('worldbuilding.openOverview', { ...open, book: '2' });
    expect(await w.act('worldbuilding.deleteWorld', { book: '2' })).toEqual({
        changed: [FOUND_VIEW, ENTRY_VIEW, POINTING_AT_VIEW, WORLDS_VIEW],
        opensViews: WORLD_VIEWS,
        own: [OVERVIEW_VIEW, WORLD_VIEW, WORLDS_VIEW],
    });
    expect(w.asked.opened.at(-1)).toBe('3');
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ id: '3' });
    await w.view<OverviewView>(OVERVIEW_VIEW);
    expect(w.asked.overview.at(-1)).toMatchObject({ book: '3', groupBy: null, firstRank: 0, endRank: 10 });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({ book: null });
    expect(await w.otherView<WorldView>(WORLD_VIEW)).toEqual({ id: null });

    await w.act('worldbuilding.deleteWorld', { book: '3' });
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ id: '1' });
    expect(await w.act('worldbuilding.deleteWorld', { book: '1' })).toEqual({
        changed: [
            RESULTS_VIEW,
            FOUND_VIEW,
            ENTRY_VIEW,
            POINTING_AT_VIEW,
            OVERVIEW_VIEW,
            RELATION_KINDS_VIEW,
            LAST_CHANGE_VIEW,
            LOOPS_LEFT_BY_JOBS_VIEW,
            SELECTION_VIEW,
            BULK_JOBS_VIEW,
        ],
        opensViews: [WORLD_VIEW, WORLDS_VIEW],
        own: [
            OVERVIEW_VIEW,
            RESULTS_VIEW,
            RELATION_KINDS_VIEW,
            LAST_CHANGE_VIEW,
            LOOPS_LEFT_BY_JOBS_VIEW,
            ENTRY_VIEW,
            POINTING_AT_VIEW,
            SELECTION_VIEW,
            BULK_JOBS_VIEW,
            WORLD_VIEW,
            WORLDS_VIEW,
        ],
    });
    expect(await w.view<WorldView>(WORLD_VIEW)).toEqual({ id: null });
    expect(await listedNames(w)).toEqual([]);
});

test('deleting a world another tab shows leaves that tab with no world, and this one where it was', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', { ...open, book: '2' });
    await w.other('worldbuilding.openOverview', open);
    expect(await w.act('worldbuilding.deleteWorld', { book: '1' })).toEqual({
        changed: [
            OVERVIEW_VIEW,
            RESULTS_VIEW,
            FOUND_VIEW,
            RELATION_KINDS_VIEW,
            LOOPS_LEFT_BY_JOBS_VIEW,
            ENTRY_VIEW,
            POINTING_AT_VIEW,
            WORLD_VIEW,
            SELECTION_VIEW,
            BULK_JOBS_VIEW,
        ],
        opensViews: [WORLDS_VIEW],
        own: [WORLDS_VIEW],
    });
    expect(await w.otherView<WorldView>(WORLD_VIEW)).toEqual({ id: null });
    expect(await w.otherView<OverviewView>(OVERVIEW_VIEW)).toMatchObject({ book: null });
    expect(await w.otherView<RelationKindsView>(RELATION_KINDS_VIEW)).toEqual({ book: null, kinds: [] });
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ id: '2' });
    expect(await listedNames(w)).toEqual(['World 2']);
    expect(await w.act('worldbuilding.deleteWorld', { book: '1' })).toEqual({
        refused: 'That world no longer exists.',
        changed: [WORLDS_VIEW],
    });
});

test("exporting a world answers its file in the action's own answer", async () => {
    const w = world(3);
    expect(await w.act('worldbuilding.exportWorld', { book: '1' })).toEqual({
        changed: [],
        answer: { fileName: 'World 1.json', json: '{"entries":{}}' },
    });
    expect(await w.act('worldbuilding.exportWorld', { book: '9' })).toEqual({
        refused: 'That world no longer exists.',
        changed: [WORLDS_VIEW],
    });
});

test('the world schemas take names trimmed and not empty, worlds by id, and the overview to open within one read', () => {
    const ok = (type: keyof typeof actions, payload: unknown) => v.safeParse(actions[type], payload).success;
    expect(ok('worldbuilding.openOverview', unopened)).toBe(true);
    expect(ok('worldbuilding.openOverview', { ...unopened, groupBy: '1' })).toBe(false);
    expect(ok('worldbuilding.openOverview', { ...unopened, around: '12' })).toBe(false);
    expect(ok('worldbuilding.createWorld', { name: '  ', overview: drawn })).toBe(false);
    expect(ok('worldbuilding.createWorld', { name: 'x' })).toBe(false);
    expect(ok('worldbuilding.createWorld', { name: 'x', overview: { ...drawn, endRank: MAX_CARDS_PER_READ } })).toBe(
        false,
    );
    expect(ok('worldbuilding.renameWorld', { book: 'Lore', name: 'x' })).toBe(false);
    expect(ok('worldbuilding.duplicateWorld', { book: '1', overview: drawn })).toBe(true);
    expect(ok('worldbuilding.importWorld', { overview: drawn })).toBe(true);
    expect(ok('worldbuilding.setUsedInEveryChat', { book: '1', used: 'yes' })).toBe(false);
});

test('kind actions name their world: making one says which it made, renaming answers the kinds and the overview, an unused one is deleted', async () => {
    const w = world(3);
    expect(await w.act('worldbuilding.createRelationKind', { book: '2', name: 'In' })).toEqual({
        refused: 'That world no longer exists.',
    });
    expect(await w.act('worldbuilding.showRelationKinds', { book: '1' })).toEqual({
        changed: [],
        opensViews: [RELATION_KINDS_VIEW, LAST_CHANGE_VIEW],
    });
    expect(await w.act('worldbuilding.createRelationKind', { book: '1', name: 'In' })).toEqual({
        changed: [RELATION_KINDS_VIEW, LAST_CHANGE_VIEW],
    });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        ...NOTHING_CHANGED,
        createdKind: { book: '1', kind: '2' },
    });
    expect((await w.view<RelationKindsView>(RELATION_KINDS_VIEW)).kinds).toEqual([
        { id: '1', name: 'in', mergingInto: null },
        { id: '2', name: 'In', mergingInto: null },
    ]);
    expect(await w.act('worldbuilding.renameRelationKind', { book: '1', kind: '1', name: 'inside' })).toEqual({
        changed: [RELATION_KINDS_VIEW, OVERVIEW_VIEW, RESULTS_VIEW, POINTING_AT_VIEW],
        own: [RELATION_KINDS_VIEW],
    });
    expect(await w.act('worldbuilding.renameRelationKind', { book: '1', kind: '9', name: 'x' })).toMatchObject({
        refused: 'This world has no such relation kind.',
    });
    expect(await w.act('worldbuilding.deleteRelationKind', { book: '1', kind: '1' })).toEqual({
        refused: 'Relations of this kind still exist.',
    });
    expect(await w.act('worldbuilding.mergeRelationKind', { book: '1', kind: '2', into: '2' })).toEqual({
        refused: 'A kind is merged into another kind.',
    });
    expect(await w.act('worldbuilding.mergeRelationKind', { book: '1', kind: '2', into: '1' })).toEqual({
        changed: [RELATION_KINDS_VIEW, OVERVIEW_VIEW, RESULTS_VIEW, POINTING_AT_VIEW],
        own: [RELATION_KINDS_VIEW],
    });
    expect((await w.view<RelationKindsView>(RELATION_KINDS_VIEW)).kinds[1]).toEqual({
        id: '2',
        name: 'In',
        mergingInto: '1',
    });
    expect(await w.act('worldbuilding.mergeRelationKind', { book: '1', kind: '2', into: '1' })).toEqual({
        refused: 'That kind is being merged, or another kind is being merged into it.',
    });
});

test('the loops a change left are named in its world: the first few, each by its first few entries and the relation it was walked from', async () => {
    const w = world(3);
    await w.act('worldbuilding.moveRelation', {
        book: '1',
        entry: '8',
        kind: '1',
        target: '7',
        newTarget: '7',
        after: null,
        before: null,
        loopCheckLimit: 10,
    });
    const shown = await w.view<LastChangeView>(LAST_CHANGE_VIEW);
    expect(shown.unreachedLoops).toEqual([
        {
            entry: named('8', 'name 8'),
            kind: '2',
            kindName: null,
            target: named('7', 'name 7'),
            entries: [named('8', 'name 8'), named('7', 'name 7')],
            moreEntries: 1,
        },
        {
            entry: named('7', 'name 7'),
            kind: '1',
            kindName: 'in',
            target: null,
            entries: [named('7', 'name 7')],
            moreEntries: 0,
        },
    ]);
    expect(shown.moreUnreachedLoops).toBe(1);
    await w.act('worldbuilding.createRelationKind', { book: '1', name: 'owes' });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toMatchObject({ unreachedLoops: [], moreUnreachedLoops: 0 });
});

test('a relation change names its world, passes the session and the loop check limit, and its answer names unreached loops', async () => {
    const w = world(3);
    const add = {
        book: '1',
        entry: '7',
        kind: '1',
        target: '8',
        after: null,
        before: null,
        weak: false,
        loopCheckLimit: 500,
    };
    expect(await w.act('worldbuilding.addRelation', add)).toEqual({
        changed: [OVERVIEW_VIEW, RESULTS_VIEW, ENTRY_VIEW, POINTING_AT_VIEW, SELECTION_VIEW, LAST_CHANGE_VIEW],
        own: [OVERVIEW_VIEW, LAST_CHANGE_VIEW],
    });
    expect(w.asked.changes[0]).toEqual({
        book: '1',
        change: { change: 'add', entry: '7', kind: '1', target: '8', after: null, before: null, weak: false },
        loopCheckLimit: 500,
        session: 's',
    });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        ...NOTHING_CHANGED,
        changedRelation: { book: '1', entry: '7', kind: '1', target: '8' },
        unreachedLoops: [LOOP_OF_7],
    });
    await w.act('worldbuilding.setRelationWeak', {
        book: '1',
        entry: '7',
        kind: '1',
        target: '8',
        weak: true,
        loopCheckLimit: 500,
    });
    await w.act('worldbuilding.moveRelation', {
        book: '1',
        entry: '3',
        kind: '1',
        target: '8',
        newTarget: '9',
        after: '4',
        before: null,
        loopCheckLimit: 10,
    });
    expect(w.asked.changes.map((c) => c.change.change)).toEqual(['add', 'setWeak', 'move']);
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        ...NOTHING_CHANGED,
        changedRelation: { book: '1', entry: '3', kind: '1', target: '9' },
    });
    expect(
        await w.act('worldbuilding.removeRelation', {
            book: '1',
            entry: '3',
            kind: '1',
            target: '999',
            loopCheckLimit: 10,
        }),
    ).toEqual({ refused: "The target isn't an entry of this world." });
});

test('showing a range or stepping that would draw more than one read may is refused', async () => {
    const w = world(100_000);
    const wide = { regionsByNestingLevel: [{ columns: 10, rows: 10 }], cardTextCharacters: 100 };
    await w.act('worldbuilding.openOverview', { ...open, layout: wide, endRank: 1 });
    const fits = Math.floor(MAX_CARDS_PER_READ / 101);
    expect(await w.act('worldbuilding.showRange', { firstRank: 0, endRank: fits + 1 })).toEqual({
        refused: READ_REFUSAL,
    });
    expect(await w.act('worldbuilding.showRange', { firstRank: 0, endRank: fits })).toEqual({
        changed: [OVERVIEW_VIEW],
    });
    expect(await w.act('worldbuilding.stepOverview', { from: '100', by: fits })).toEqual({ refused: READ_REFUSAL });
});

test('the schemas bound a read by the cards it draws, and take worlds and kinds by id', () => {
    const ok = (type: keyof typeof actions, payload: unknown) => v.safeParse(actions[type], payload).success;
    expect(ok('worldbuilding.openOverview', open)).toBe(true);
    expect(ok('worldbuilding.openOverview', { ...open, endRank: Math.floor(MAX_CARDS_PER_READ / 7) })).toBe(true);
    expect(ok('worldbuilding.openOverview', { ...open, endRank: Math.floor(MAX_CARDS_PER_READ / 7) + 1 })).toBe(false);
    expect(ok('worldbuilding.openOverview', { ...open, groupBy: 'in' })).toBe(false);
    expect(ok('worldbuilding.openOverview', { ...open, around: '12/34/+' })).toBe(true);
    expect(ok('worldbuilding.openOverview', { ...open, around: '12/+/3' })).toBe(false);
    const deep = {
        regionsByNestingLevel: [
            { columns: 4, rows: 2 },
            { columns: 4, rows: 2 },
        ],
        cardTextCharacters: 100_000,
    };
    expect(cardsPerTopLevelEntry(deep.regionsByNestingLevel)).toBe(1 + 8 + 64);
    expect(
        ok('worldbuilding.openOverview', { ...open, layout: deep, endRank: Math.floor(MAX_CARDS_PER_READ / 73) }),
    ).toBe(true);
    expect(
        ok('worldbuilding.openOverview', { ...open, layout: deep, endRank: Math.floor(MAX_CARDS_PER_READ / 73) + 1 }),
    ).toBe(false);
    const huge = { regionsByNestingLevel: Array(30).fill({ columns: 1000, rows: 1000 }), cardTextCharacters: 0 };
    expect(ok('worldbuilding.openOverview', { ...open, layout: huge, endRank: 0 })).toBe(true);
    expect(ok('worldbuilding.openOverview', { ...open, layout: huge, endRank: 1 })).toBe(false);
    expect(
        ok('worldbuilding.openOverview', {
            ...open,
            layout: { ...LAYOUT, regionsByNestingLevel: [{ columns: 0, rows: 1 }] },
        }),
    ).toBe(false);
    expect(ok('worldbuilding.showRange', { firstRank: 30, endRank: 10 })).toBe(false);
    expect(ok('worldbuilding.stepOverview', { from: null, by: -1 })).toBe(true);
    expect(ok('worldbuilding.stepOverview', { from: null, to: 'parent' })).toBe(false);
    expect(ok('worldbuilding.stepOverview', { from: '1', to: 'sibling' })).toBe(false);
    expect(ok('worldbuilding.stepOverview', { from: '1', by: 0.5 })).toBe(false);
    expect(ok('worldbuilding.createRelationKind', { book: '1', name: '  ' })).toBe(false);
    expect(ok('worldbuilding.createRelationKind', { name: 'in' })).toBe(false);
    const add = {
        book: '1',
        entry: '7',
        kind: '1',
        target: '8',
        after: null,
        before: null,
        weak: false,
        loopCheckLimit: 500,
    };
    expect(ok('worldbuilding.addRelation', add)).toBe(true);
    expect(ok('worldbuilding.addRelation', { ...add, kind: 'in' })).toBe(false);
    expect(ok('worldbuilding.addRelation', { ...add, loopCheckLimit: 0 })).toBe(false);
    expect(ok('worldbuilding.addRelation', { ...add, loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE + 1 })).toBe(false);
    const { book: _, ...withoutWorld } = add;
    expect(ok('worldbuilding.addRelation', withoutWorld)).toBe(false);
});

test('a range follows a rank by keeping its width', () => {
    expect(rangeAround(5, 0, 20)).toEqual({ firstRank: 0, endRank: 20 });
    expect(rangeAround(20, 0, 20)).toEqual({ firstRank: 10, endRank: 30 });
    expect(rangeAround(3, 40, 60)).toEqual({ firstRank: 0, endRank: 20 });
});

const entryOpen = (view: EntryView): OpenEntryView => {
    if (view.book === null || view.deleted) throw new Error(`no open entry: ${JSON.stringify(view)}`);
    return view;
};

test('opening an entry opens its view: the entry, its keys, placement, tokens and the first page of what mentions it; the page names the run of mention pages held; closing it shows none', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({ book: null });
    expect(await w.act('worldbuilding.openEntry', { entry: '7', pointingAt })).toEqual({
        changed: [],
        opensViews: [ENTRY_VIEW, POINTING_AT_VIEW],
        own: [ENTRY_VIEW],
    });
    const shown = entryOpen(await w.view<EntryView>(ENTRY_VIEW));
    expect(shown).toMatchObject({ book: '1', entry: '7', deleted: false, label: named('7', 'name 7'), tokens: 20 });
    const pagesOf = (view: OpenEntryView) =>
        view.mentionedIn.pages.map((page) => [page.cursor, page.next, page.entries.map((m) => m.from.thing)]);
    expect(pagesOf(shown)).toEqual([[null, '1.p1', ['m0']]]);
    expect(await w.act('worldbuilding.showMentions', { from: null, pages: 3 })).toEqual({ changed: [ENTRY_VIEW] });
    expect(pagesOf(entryOpen(await w.view<EntryView>(ENTRY_VIEW)))).toEqual([
        [null, '1.p1', ['m0']],
        ['1.p1', '1.p2', ['m1']],
        ['1.p2', null, ['m2']],
    ]);
    expect(await w.act('worldbuilding.showMentions', { from: '1.p2', pages: 2 })).toEqual({ changed: [ENTRY_VIEW] });
    expect(pagesOf(entryOpen(await w.view<EntryView>(ENTRY_VIEW)))).toEqual([['1.p2', null, ['m2']]]);
    expect(w.asked.entryReads.at(-1)).toEqual({ book: '1', entry: '7', mentions: { from: 'p2', pages: 2 } });
    await w.act('worldbuilding.openEntry', { entry: '8', pointingAt });
    expect(w.asked.entryReads.length).toBe(3);
    expect(pagesOf(entryOpen(await w.view<EntryView>(ENTRY_VIEW)))).toEqual([[null, '2.p1', ['m0']]]);
    expect(await w.act('worldbuilding.showMentions', { from: '1.p1', pages: 1 })).toEqual({
        refused: 'Those mentions are no longer shown.',
        changed: [ENTRY_VIEW],
    });
    expect(await w.act('worldbuilding.closeEntry', {})).toEqual({ changed: [ENTRY_VIEW, POINTING_AT_VIEW] });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({ book: null });
    expect(await w.act('worldbuilding.showMentions', { from: null, pages: 1 })).toEqual({
        refused: 'No entry is open.',
    });
    await w.act('worldbuilding.openEntry', { entry: '404', pointingAt });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({ book: null });
});

test('an edit names its world and entry, passes the session, answers the entry and the overview, and says why it is refused', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.openEntry', { entry: '7', pointingAt });
    const both = {
        changed: [OVERVIEW_VIEW, RESULTS_VIEW, ENTRY_VIEW, POINTING_AT_VIEW, SELECTION_VIEW, FOUND_VIEW],
        own: [ENTRY_VIEW],
    };
    expect(await w.act('worldbuilding.setEntryText', { book: '1', entry: '7', text: 'Ilse left.' })).toEqual(both);
    expect(entryOpen(await w.view<EntryView>(ENTRY_VIEW)).text).toBe('Ilse left.');
    expect(await w.act('worldbuilding.setEntryTitle', { book: '1', entry: '7', title: '' })).toEqual(both);
    expect(await w.act('worldbuilding.addKey', { book: '1', entry: '8', key: ' lamp ', as: 'trigger' })).toEqual(both);
    expect(await w.act('worldbuilding.setKeyAs', { book: '1', entry: '7', key: 'name 7', as: 'trigger' })).toEqual(
        both,
    );
    expect(await w.act('worldbuilding.setKeyAs', { book: '1', entry: '7', key: 'x', as: 'name' })).toEqual({
        refused: 'That entry has no such key.',
    });
    expect(await w.act('worldbuilding.removeKey', { book: '1', entry: '7', key: 'name 7' })).toEqual(both);
    expect(await w.act('worldbuilding.setPlacement', { book: '1', entry: '7', fields: { depth: 2, role: 1 } })).toEqual(
        both,
    );
    expect(await w.act('worldbuilding.setEntryText', { book: '1', entry: '404', text: '' })).toEqual({
        refused: "That entry isn't in this world.",
        changed: [OVERVIEW_VIEW, RESULTS_VIEW, ENTRY_VIEW, POINTING_AT_VIEW, SELECTION_VIEW, FOUND_VIEW],
        own: [],
    });
    expect(await w.act('worldbuilding.setEntryText', { book: '2', entry: '7', text: '' })).toEqual({
        refused: 'That world no longer exists.',
    });
    expect(w.asked.edits.map(({ edit }) => edit)).toEqual([
        { change: 'text', text: 'Ilse left.' },
        { change: 'title', title: '' },
        { change: 'addKey', key: 'lamp', as: 'trigger' },
        { change: 'setKeyAs', key: 'name 7', as: 'trigger' },
        { change: 'setKeyAs', key: 'x', as: 'name' },
        { change: 'removeKey', key: 'name 7' },
        { change: 'placement', fields: { depth: 2, role: 1 } },
        { change: 'text', text: '' },
        { change: 'text', text: '' },
    ]);
    expect(w.asked.edits[0]).toMatchObject({ book: '1', entry: '7', session: 's' });
});

test('making an entry places it, opens it when asked and says what it made and which loops it left; a refused one changes nothing', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    const make = {
        book: '1',
        after: '7',
        name: 'Saltmarrow',
        relation: null,
        open: { pointingAt },
        loopCheckLimit: 300,
    };
    expect(await w.act('worldbuilding.createEntry', make)).toEqual({
        changed: [OVERVIEW_VIEW, RESULTS_VIEW, FOUND_VIEW, WORLDS_VIEW, WORLD_VIEW, SELECTION_VIEW, LAST_CHANGE_VIEW],
        opensViews: [ENTRY_VIEW, POINTING_AT_VIEW],
        own: [ENTRY_VIEW, LAST_CHANGE_VIEW],
    });
    expect(w.asked.created[0]).toEqual({
        book: '1',
        creation: { after: '7', name: 'Saltmarrow', relation: null },
        loopCheckLimit: 300,
    });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toMatchObject({ book: '1', entry: '50' });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        ...NOTHING_CHANGED,
        createdEntry: { book: '1', entry: '50' },
    });
    const related = { ...make, after: null, name: null, relation: { kind: '1', target: '8' }, open: null };
    expect(await w.act('worldbuilding.createEntry', related)).toEqual({
        changed: [
            OVERVIEW_VIEW,
            RESULTS_VIEW,
            FOUND_VIEW,
            WORLDS_VIEW,
            WORLD_VIEW,
            SELECTION_VIEW,
            ENTRY_VIEW,
            POINTING_AT_VIEW,
            LAST_CHANGE_VIEW,
        ],
        own: [OVERVIEW_VIEW, LAST_CHANGE_VIEW],
    });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toMatchObject({ entry: '50' });
    expect((await w.view<LastChangeView>(LAST_CHANGE_VIEW)).unreachedLoops).toEqual([
        {
            entry: named('51', 'name 51'),
            kind: '1',
            kindName: 'in',
            target: null,
            entries: [named('51', 'name 51')],
            moreEntries: 0,
        },
    ]);
    expect(await w.act('worldbuilding.createEntry', { ...related, relation: { kind: '1', target: '999' } })).toEqual({
        refused: "The target isn't an entry of this world.",
    });
    expect(await w.act('worldbuilding.createEntry', { ...make, book: '2', open: null })).toEqual({
        refused: 'That world no longer exists.',
    });
});

test('deleting the open entry closes it and offers it back under its label; restoring answers the loops it left', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.openEntry', { entry: '7', pointingAt });
    const all = {
        changed: [
            OVERVIEW_VIEW,
            RESULTS_VIEW,
            FOUND_VIEW,
            WORLDS_VIEW,
            WORLD_VIEW,
            SELECTION_VIEW,
            ENTRY_VIEW,
            POINTING_AT_VIEW,
            LAST_CHANGE_VIEW,
        ],
    };
    expect(await w.act('worldbuilding.deleteEntry', { book: '1', entry: '7' })).toEqual({
        ...all,
        own: [OVERVIEW_VIEW, LAST_CHANGE_VIEW, ENTRY_VIEW, POINTING_AT_VIEW],
    });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({ book: null });
    expect((await w.view<LastChangeView>(LAST_CHANGE_VIEW)).deletedEntry).toEqual({
        book: '1',
        entry: '7',
        label: named('7', 'name 7'),
    });
    expect(await w.act('worldbuilding.deleteEntry', { book: '1', entry: '7' })).toEqual({
        refused: "That entry isn't in this world.",
        changed: [OVERVIEW_VIEW, RESULTS_VIEW, ENTRY_VIEW, POINTING_AT_VIEW, SELECTION_VIEW, FOUND_VIEW],
        own: [],
    });
    expect(await w.act('worldbuilding.restoreEntry', { book: '1', entry: '7' })).toEqual({
        ...all,
        own: [OVERVIEW_VIEW, LAST_CHANGE_VIEW],
    });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({ book: null });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        ...NOTHING_CHANGED,
        unreachedLoops: [LOOP_OF_7],
    });
    expect(await w.act('worldbuilding.restoreEntry', { book: '1', entry: '7' })).toMatchObject({
        refused: "That entry isn't in this world.",
    });
});

test("a key's other entries open with the key, for the open entry only, and reopen with the next key", async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    const ask = { book: '1', entry: '7', key: 'Ilse' };
    expect(await w.view<KeySharersView>(KEY_SHARERS_VIEW)).toEqual({ book: null });
    expect(await w.act('worldbuilding.showKeySharers', ask)).toEqual({ refused: 'No entry is open.' });
    await w.act('worldbuilding.openEntry', { entry: '7', pointingAt });
    expect(await w.act('worldbuilding.showKeySharers', { ...ask, entry: '8' })).toEqual({
        refused: 'No entry is open.',
    });
    expect(await w.act('worldbuilding.showKeySharers', ask)).toEqual({ changed: [], opensViews: [KEY_SHARERS_VIEW] });
    expect(await w.view<KeySharersView>(KEY_SHARERS_VIEW)).toEqual({
        ...ask,
        entries: [named('8', 'name 8')],
        more: false,
    });
    expect(w.asked.sharers).toEqual([{ ...ask, limit: KEY_SHARERS_SHOWN }]);
    await w.act('worldbuilding.showKeySharers', { ...ask, key: 'lamp' });
    expect(await w.view<KeySharersView>(KEY_SHARERS_VIEW)).toMatchObject({ key: 'lamp', entries: [] });
    await w.act('worldbuilding.openEntry', { entry: '8', pointingAt });
    expect(await w.view<KeySharersView>(KEY_SHARERS_VIEW)).toEqual({ book: null });
});

test('an entry deleted elsewhere shows deleted under the label it was last shown with', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.openEntry', { entry: '8', pointingAt });
    await w.view<EntryView>(ENTRY_VIEW);
    await w.other('worldbuilding.deleteEntry', { book: '1', entry: '8' });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({
        book: '1',
        entry: '8',
        deleted: true,
        label: named('8', 'name 8'),
    });
});

test('moving the open entry to another world opens that world with the entry open over it; the same world or a missing one is refused', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', { ...open, firstRank: 5, endRank: 15 });
    await w.act('worldbuilding.openEntry', { entry: '7', pointingAt });
    expect(await w.act('worldbuilding.moveEntryToWorld', { book: '1', entry: '7', toBook: '1' })).toEqual({
        refused: 'The entry is in that world already.',
    });
    expect(await w.act('worldbuilding.moveEntryToWorld', { book: '1', entry: '7', toBook: '3' })).toEqual({
        refused: 'The world to move it to no longer exists.',
    });
    expect(await w.act('worldbuilding.moveEntryToWorld', { book: '1', entry: '7', toBook: '2' })).toEqual({
        changed: [FOUND_VIEW, WORLDS_VIEW, ENTRY_VIEW, POINTING_AT_VIEW],
        opensViews: WORLD_VIEWS,
        own: [WORLD_VIEW, LAST_CHANGE_VIEW],
    });
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ id: '2' });
    await w.view<OverviewView>(OVERVIEW_VIEW);
    expect(w.asked.overview.at(-1)).toMatchObject({ book: '2', groupBy: null, firstRank: 0, endRank: 10 });
    expect(w.asked.step.at(-1)).toEqual({ book: '2', groupBy: null, from: '90', by: 0 });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        ...NOTHING_CHANGED,
        movedEntry: { book: '1', entry: '7', toBook: '2', newEntry: '90' },
    });
    expect(w.asked.entryReads).toEqual([]);
    await w.view<EntryView>(ENTRY_VIEW);
    expect(w.asked.entryReads).toEqual([{ book: '2', entry: '90', mentions: { from: null, pages: 1 } }]);
});

test('moving an entry that is not the open one leaves the tab on its world, with the open entry still open', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.openEntry', { entry: '8', pointingAt });
    expect(await w.act('worldbuilding.moveEntryToWorld', { book: '1', entry: '7', toBook: '2' })).toEqual({
        changed: [
            OVERVIEW_VIEW,
            RESULTS_VIEW,
            FOUND_VIEW,
            WORLDS_VIEW,
            WORLD_VIEW,
            SELECTION_VIEW,
            ENTRY_VIEW,
            POINTING_AT_VIEW,
            LAST_CHANGE_VIEW,
        ],
        own: [OVERVIEW_VIEW, LAST_CHANGE_VIEW],
    });
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ id: '1' });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toMatchObject({ book: '1', entry: '8' });
});

test("an open entry is always the shown world's: another world closes it, the same one keeps it, and none opens none", async () => {
    const w = world(3);
    expect(await w.act('worldbuilding.openEntry', { entry: '7', pointingAt })).toEqual({
        refused: 'No world is shown.',
    });
    expect(
        await w.act('worldbuilding.createEntry', {
            book: '1',
            after: null,
            name: null,
            relation: null,
            open: { pointingAt },
            loopCheckLimit: 10,
        }),
    ).toEqual({ refused: "That world isn't shown." });
    expect(w.asked.created).toEqual([]);
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.openEntry', { entry: '7', pointingAt });
    expect(await w.act('worldbuilding.openOverview', { ...open, firstRank: 3, endRank: 9 })).toEqual({
        changed: [],
        opensViews: WORLD_VIEWS,
        own: [OVERVIEW_VIEW, WORLD_VIEW],
    });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toMatchObject({ book: '1', entry: '7' });
    expect(await w.act('worldbuilding.openOverview', { ...open, book: '2', groupBy: null })).toEqual({
        changed: [ENTRY_VIEW, POINTING_AT_VIEW],
        opensViews: WORLD_VIEWS,
        own: [OVERVIEW_VIEW, WORLD_VIEW, ENTRY_VIEW, POINTING_AT_VIEW],
    });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({ book: null });
    expect(await w.view<PointingAtView>(POINTING_AT_VIEW)).toEqual({ book: null });
});

test('the entry schemas take worlds and entries by id, keys trimmed and not empty, and placement fields each by its own type and range', () => {
    const ok = (type: keyof typeof actions, payload: unknown) => v.safeParse(actions[type], payload).success;
    const at = { book: '1', entry: '7' };
    expect(ok('worldbuilding.openEntry', { entry: '7', pointingAt })).toBe(true);
    expect(ok('worldbuilding.openEntry', { entry: '7' })).toBe(false);
    expect(ok('worldbuilding.openEntry', { entry: 'seven', pointingAt })).toBe(false);
    expect(ok('worldbuilding.addKey', { ...at, key: '  ', as: 'name' })).toBe(false);
    expect(ok('worldbuilding.addKey', { ...at, key: 'Ilse', as: 'title' })).toBe(false);
    expect(ok('worldbuilding.setKeyAs', { ...at, key: 'Ilse', as: 'trigger' })).toBe(true);
    expect(ok('worldbuilding.setEntryTitle', { ...at, title: '' })).toBe(true);
    const placing = (fields: unknown) => ok('worldbuilding.setPlacement', { ...at, fields });
    expect(placing(PLACEMENT)).toBe(true);
    expect(placing({})).toBe(false);
    expect(placing({ probability: 101 })).toBe(false);
    expect(placing({ probability: 12.5 })).toBe(true);
    expect(placing({ depth: -1 })).toBe(false);
    expect(placing({ depth: 1001 })).toBe(false);
    expect(placing({ position: 8 })).toBe(false);
    expect(placing({ role: 2, selectiveLogic: 3 })).toBe(true);
    expect(placing({ groupWeight: 0 })).toBe(false);
    expect(placing({ scanDepth: null, sticky: 3, delay: null })).toBe(true);
    expect(placing({ sticky: 1.5 })).toBe(false);
    expect(placing({ delayUntilRecursion: true })).toBe(true);
    expect(placing({ delayUntilRecursion: 2 })).toBe(true);
    expect(placing({ triggers: ['normal', 'swipe'] })).toBe(true);
    expect(placing({ triggers: ['dream'] })).toBe(false);
    expect(placing({ characterFilter: { isExclude: true, names: ['a.png'], tags: [] } })).toBe(true);
    expect(placing({ key: ['Ilse'] })).toBe(false);
    expect(placing({ content: 'x' })).toBe(false);
    const make = { book: '1', after: null, name: null, relation: null, open: { pointingAt }, loopCheckLimit: 10 };
    expect(ok('worldbuilding.createEntry', make)).toBe(true);
    expect(ok('worldbuilding.createEntry', { ...make, name: ' ' })).toBe(false);
    expect(ok('worldbuilding.createEntry', { ...make, relation: { kind: 'in', target: '8' } })).toBe(false);
    expect(ok('worldbuilding.createEntry', { ...make, loopCheckLimit: 0 })).toBe(false);
    expect(ok('worldbuilding.moveEntryToWorld', { ...at, toBook: '2' })).toBe(true);
    expect(ok('worldbuilding.showMentions', { from: '', pages: 1 })).toBe(false);
    expect(ok('worldbuilding.showMentions', { from: null, pages: 0 })).toBe(false);
    expect(ok('worldbuilding.showMentions', { from: null, pages: MENTION_PAGES_AT_MOST + 1 })).toBe(false);
});

const pointingAtOpen = (view: PointingAtView) => {
    if (view.book === null) throw new Error('nothing is pointed at');
    return view;
};

const ranksOf = (view: PointingAtView) =>
    pointingAtOpen(view).sections.map((section) => [section.kind, section.entries.map((cell) => cell.topLevelRank)]);

test('opening an entry opens what points at it in the same answer: a section per kind, each from its first rank', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    expect(await w.view<PointingAtView>(POINTING_AT_VIEW)).toEqual({ book: null });
    expect(await w.act('worldbuilding.openEntry', { entry: '7', pointingAt })).toEqual({
        changed: [],
        opensViews: [ENTRY_VIEW, POINTING_AT_VIEW],
        own: [ENTRY_VIEW],
    });
    const shown = pointingAtOpen(await w.view<PointingAtView>(POINTING_AT_VIEW));
    expect(shown.book).toBe('1');
    expect(shown.entry).toBe('7');
    expect(shown.sections.map(({ kind, kindName, count, firstRank }) => [kind, kindName, count, firstRank])).toEqual([
        ['1', 'in', 500, 0],
        ['2', null, 3, 0],
    ]);
    expect(ranksOf(shown)).toEqual([
        ['1', [...Array(12).keys()]],
        ['2', [0, 1, 2]],
    ]);
    expect(shown.sections[0]?.entries[0]?.occurrence).toBe('1@7/1000');
    expect(w.asked.pointingAt.at(-1)).toEqual({
        book: '1',
        entry: '7',
        layout: LAYOUT,
        endRank: 12,
        held: [],
        maxCards: MAX_CARDS_PER_READ,
    });
    await w.act('worldbuilding.openEntry', { entry: '8', pointingAt });
    expect(await w.view<PointingAtView>(POINTING_AT_VIEW)).toEqual({ book: '1', entry: '8', sections: [] });
    await w.other('worldbuilding.deleteEntry', { book: '1', entry: '8' });
    expect(await w.view<PointingAtView>(POINTING_AT_VIEW)).toEqual({ book: '1', entry: '8', sections: [] });
    await w.act('worldbuilding.closeEntry', {});
    expect(await w.view<PointingAtView>(POINTING_AT_VIEW)).toEqual({ book: null });
});

test("a section's range is held per session, the one asked last first, and reset when another entry opens", async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    expect(await w.act('worldbuilding.showPointingAtRange', { kind: '1', firstRank: 0, endRank: 5 })).toEqual({
        refused: 'No entry is open.',
    });
    await w.act('worldbuilding.openEntry', { entry: '7', pointingAt });
    expect(await w.act('worldbuilding.showPointingAtRange', { kind: '1', firstRank: 300, endRank: 320 })).toEqual({
        changed: [POINTING_AT_VIEW],
    });
    expect(await w.act('worldbuilding.showPointingAtRange', { kind: '2', firstRank: 1, endRank: 3 })).toEqual({
        changed: [POINTING_AT_VIEW],
    });
    const shown = pointingAtOpen(await w.view<PointingAtView>(POINTING_AT_VIEW));
    expect(shown.sections.map((section) => section.firstRank)).toEqual([300, 1]);
    expect(w.asked.pointingAt.at(-1)?.held.map((range) => [range.kind, range.firstRank, range.endRank])).toEqual([
        ['2', 1, 3],
        ['1', 300, 320],
    ]);
    expect(await w.otherView<PointingAtView>(POINTING_AT_VIEW)).toEqual({ book: null });
    const fits = Math.floor(MAX_CARDS_PER_READ / cardsPerTopLevelEntry(LAYOUT.regionsByNestingLevel));
    expect(await w.act('worldbuilding.showPointingAtRange', { kind: '1', firstRank: 0, endRank: fits + 1 })).toEqual({
        refused: READ_REFUSAL,
    });
    await w.act('worldbuilding.openEntry', { entry: '7', pointingAt: { ...pointingAt, endRank: 4 } });
    await w.view<PointingAtView>(POINTING_AT_VIEW);
    expect(w.asked.pointingAt.at(-1)).toMatchObject({ endRank: 4, held: [] });
});

test('a step in a section lands where the store says and its range follows; one past the read budget or no longer shown is refused', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    expect(await w.act('worldbuilding.stepPointingAt', { kind: '1', from: '1@7/1000', by: 1 })).toEqual({
        refused: 'No entry is open.',
    });
    await w.act('worldbuilding.openEntry', { entry: '7', pointingAt });
    expect(await w.act('worldbuilding.stepPointingAt', { kind: '1', from: '1@7/1005', by: 1 })).toEqual({
        changed: [POINTING_AT_VIEW],
    });
    let section = pointingAtOpen(await w.view<PointingAtView>(POINTING_AT_VIEW)).sections[0];
    expect([section?.firstRank, section?.stepLanding]).toEqual([0, { occurrence: '1@7/1006', topLevelRank: 6 }]);
    await w.act('worldbuilding.stepPointingAt', { kind: '1', from: '1@7/1006', by: 30 });
    section = pointingAtOpen(await w.view<PointingAtView>(POINTING_AT_VIEW)).sections[0];
    expect([section?.firstRank, section?.entries.length, section?.stepLanding]).toEqual([
        30,
        12,
        { occurrence: '1@7/1036', topLevelRank: 36 },
    ]);
    expect(w.asked.pointingAtSteps.at(-1)).toEqual({ book: '1', entry: '7', kind: '1', from: '1@7/1006', by: 30 });
    await w.act('worldbuilding.stepPointingAt', { kind: '2', from: null, by: -1 });
    expect(pointingAtOpen(await w.view<PointingAtView>(POINTING_AT_VIEW)).sections[1]?.stepLanding).toEqual({
        occurrence: '2@7/1002',
        topLevelRank: 2,
    });
    expect(await w.act('worldbuilding.stepPointingAt', { kind: '1', from: '1@7/1206', to: 'parent' })).toEqual({
        changed: [POINTING_AT_VIEW],
    });
    expect(await w.act('worldbuilding.stepPointingAt', { kind: '1', from: '2@7/1000', by: 1 })).toEqual({
        refused: 'That is no longer shown.',
        changed: [POINTING_AT_VIEW],
    });
    const far = Math.floor(MAX_CARDS_PER_READ / cardsPerTopLevelEntry(LAYOUT.regionsByNestingLevel));
    expect(await w.act('worldbuilding.stepPointingAt', { kind: '1', from: '1@7/1000', by: far })).toEqual({
        refused: READ_REFUSAL,
    });
});

test('moving the open entry to another world keeps how its page draws what points at it', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    const wide = { endRank: 7, layout: { regionsByNestingLevel: [{ columns: 4, rows: 1 }], cardTextCharacters: 80 } };
    await w.act('worldbuilding.openEntry', { entry: '7', pointingAt: wide });
    await w.act('worldbuilding.showPointingAtRange', { kind: '1', firstRank: 40, endRank: 47 });
    await w.act('worldbuilding.moveEntryToWorld', { book: '1', entry: '7', toBook: '2' });
    await w.view<PointingAtView>(POINTING_AT_VIEW);
    expect(w.asked.pointingAt.at(-1)).toEqual({
        book: '2',
        entry: '90',
        layout: wide.layout,
        endRank: 7,
        held: [],
        maxCards: MAX_CARDS_PER_READ,
    });
});

test('the pointing-at schemas take a kind by id, a range forward, a step from an occurrence of a section, and a first range within one read', () => {
    const ok = (type: keyof typeof actions, payload: unknown) => v.safeParse(actions[type], payload).success;
    expect(ok('worldbuilding.showPointingAtRange', { kind: '1', firstRank: 0, endRank: 10 })).toBe(true);
    expect(ok('worldbuilding.showPointingAtRange', { kind: 'in', firstRank: 0, endRank: 10 })).toBe(false);
    expect(ok('worldbuilding.showPointingAtRange', { kind: '1', firstRank: 10, endRank: 0 })).toBe(false);
    expect(ok('worldbuilding.stepPointingAt', { kind: '1', from: '1@7/12/34/+', by: -2 })).toBe(true);
    expect(ok('worldbuilding.stepPointingAt', { kind: '1', from: null, by: 1 })).toBe(true);
    expect(ok('worldbuilding.stepPointingAt', { kind: '1', from: '12/34', by: 1 })).toBe(false);
    expect(ok('worldbuilding.stepPointingAt', { kind: '1', from: '1@7', by: 1 })).toBe(false);
    expect(ok('worldbuilding.stepPointingAt', { kind: '1', from: null, to: 'parent' })).toBe(false);
    expect(ok('worldbuilding.stepPointingAt', { kind: '1', from: '1@7/12', to: 'firstChild' })).toBe(true);
    const at = { book: '1', entry: '7' };
    const fits = Math.floor(MAX_CARDS_PER_READ / cardsPerTopLevelEntry(LAYOUT.regionsByNestingLevel));
    expect(ok('worldbuilding.openEntry', { ...at, pointingAt: { ...pointingAt, endRank: fits } })).toBe(true);
    expect(ok('worldbuilding.openEntry', { ...at, pointingAt: { ...pointingAt, endRank: fits + 1 } })).toBe(false);
    const make = { book: '1', after: null, name: null, relation: null, loopCheckLimit: 10 };
    expect(ok('worldbuilding.createEntry', { ...make, open: null })).toBe(true);
    expect(ok('worldbuilding.createEntry', { ...make, open: true })).toBe(false);
});

const inSaltmarrow = { kind: '1', target: '8', depth: 'anyDepth' } as const;
const filter = { book: '1', query: 'lamp', chips: [inSaltmarrow], pageSize: 2 };

test("the filter is the shown world's: setting it opens the results at their first page, closing an open entry; empty clears it", async () => {
    const w = world(3);
    expect(await w.act('worldbuilding.setFilter', filter)).toEqual({ refused: 'No world is shown.' });
    expect(await w.view<ResultsView>(RESULTS_VIEW)).toEqual({ book: null });
    await w.act('worldbuilding.openOverview', open);
    expect(await w.act('worldbuilding.setFilter', { ...filter, book: '2' })).toEqual({
        refused: "That world isn't shown.",
    });
    expect(await w.act('worldbuilding.setFilter', { ...filter, chips: [{ ...inSaltmarrow, target: '999' }] })).toEqual({
        refused: "That entry isn't in this world.",
    });
    expect(await w.act('worldbuilding.setFilter', filter)).toEqual({ changed: [], opensViews: [RESULTS_VIEW] });
    expect(await w.view<ResultsView>(RESULTS_VIEW)).toEqual({
        book: '1',
        generation: 1,
        filter: {
            query: 'lamp',
            chips: [
                { kind: '1', kindName: 'in', target: named('8', 'name 8'), targetDeleted: false, depth: 'anyDepth' },
            ],
        },
        pages: [{ cursor: null, entries: [resultCard(0), resultCard(1)], next: '1.c2' }],
    });
    expect(w.asked.results.at(-1)).toEqual({
        book: '1',
        groupBy: '1',
        layout: LAYOUT,
        query: 'lamp',
        chips: [inSaltmarrow],
        pageSize: 2,
        from: null,
        pages: 1,
        walkSteps: WALK_STEPS_PER_READ,
    });
    await w.act('worldbuilding.openEntry', { entry: '7', pointingAt });
    expect(await w.act('worldbuilding.setFilter', filter)).toEqual({
        changed: [ENTRY_VIEW, POINTING_AT_VIEW],
        opensViews: [RESULTS_VIEW],
    });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({ book: null });
    expect(await w.act('worldbuilding.setFilter', { ...filter, query: ' ', chips: [] })).toEqual({
        changed: [RESULTS_VIEW],
    });
    expect(await w.view<ResultsView>(RESULTS_VIEW)).toEqual({ book: null });
    expect(await w.act('worldbuilding.setFilter', { ...filter, query: '' })).toMatchObject({
        opensViews: [RESULTS_VIEW],
    });
});

test('the session holds the run of pages the page asks for, read from its first cursor; a cursor of another filter is refused', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.setFilter', filter);
    let shown = await w.view<ResultsView>(RESULTS_VIEW);
    const pagesOf = (view: ResultsView) =>
        'pages' in view ? view.pages.map((page) => [page.cursor, page.next, page.entries.map((e) => e.entry)]) : [];
    expect(pagesOf(shown)).toEqual([[null, '1.c2', ['300', '301']]]);
    expect(await w.act('worldbuilding.showResults', { from: null, pages: 4 })).toEqual({ changed: [RESULTS_VIEW] });
    shown = await w.view<ResultsView>(RESULTS_VIEW);
    expect(pagesOf(shown)).toEqual([
        [null, '1.c2', ['300', '301']],
        ['1.c2', '1.c4', ['302', '303']],
        ['1.c4', null, ['304']],
    ]);
    expect(w.asked.results.at(-1)).toMatchObject({ from: null, pages: 4 });
    expect(await w.act('worldbuilding.showResults', { from: '1.c4', pages: 1 })).toEqual({ changed: [RESULTS_VIEW] });
    expect(pagesOf(await w.view<ResultsView>(RESULTS_VIEW))).toEqual([['1.c4', null, ['304']]]);
    expect(await w.act('worldbuilding.showResults', { from: '1.c2', pages: 1 })).toEqual({ changed: [RESULTS_VIEW] });
    expect(pagesOf(await w.view<ResultsView>(RESULTS_VIEW))).toEqual([['1.c2', '1.c4', ['302', '303']]]);
    expect(w.asked.results.at(-1)).toMatchObject({ from: 'c2', pages: 1 });
    await w.act('worldbuilding.setFilter', { ...filter, query: 'oil' });
    expect(await w.act('worldbuilding.showResults', { from: '1.c2', pages: 1 })).toEqual({
        refused: 'Those results are no longer shown.',
        changed: [RESULTS_VIEW],
    });
    expect(await w.view<ResultsView>(RESULTS_VIEW)).toMatchObject({ generation: 2 });
    expect(pagesOf(await w.view<ResultsView>(RESULTS_VIEW))).toEqual([[null, '2.c2', ['300', '301']]]);
    expect(await w.other('worldbuilding.showResults', { from: null, pages: 1 })).toEqual({
        refused: 'Nothing is searched for.',
        changed: [RESULTS_VIEW],
    });
});

test("a run past one read's budget is refused", async () => {
    const half = Math.floor(MAX_CARDS_PER_READ / 2);
    const w = world(3, { results: 2 * MAX_CARDS_PER_READ });
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.setFilter', { ...filter, pageSize: half });
    expect(await w.act('worldbuilding.showResults', { from: null, pages: 2 })).toEqual({ changed: [RESULTS_VIEW] });
    expect(await w.act('worldbuilding.showResults', { from: `1.c${half}`, pages: 3 })).toEqual({
        refused: READ_REFUSAL,
    });
});

test('a chip whose entry is deleted shows under the label it was last shown with', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.setFilter', filter);
    await w.view<ResultsView>(RESULTS_VIEW);
    expect(await w.act('worldbuilding.deleteEntry', { book: '1', entry: '8' })).toMatchObject({
        changed: expect.arrayContaining([RESULTS_VIEW, FOUND_VIEW]),
    });
    expect(await w.view<ResultsView>(RESULTS_VIEW)).toMatchObject({
        filter: { chips: [{ target: named('8', 'name 8'), targetDeleted: true }] },
    });
});

test('what changes cards answers the results; another world clears them, the same world with another grouping keeps them', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.setFilter', filter);
    expect(await w.act('worldbuilding.setEntryText', { book: '1', entry: '7', text: 'x' })).toMatchObject({
        changed: expect.arrayContaining([RESULTS_VIEW, FOUND_VIEW]),
    });
    expect(
        await w.act('worldbuilding.addRelation', {
            book: '1',
            entry: '7',
            kind: '1',
            target: '8',
            after: null,
            before: null,
            weak: false,
            loopCheckLimit: 10,
        }),
    ).toMatchObject({ changed: expect.arrayContaining([RESULTS_VIEW]) });
    expect(await w.act('worldbuilding.renameRelationKind', { book: '1', kind: '1', name: 'within' })).toMatchObject({
        changed: expect.arrayContaining([RESULTS_VIEW]),
    });
    expect(await w.act('worldbuilding.openOverview', { ...open, groupBy: null })).toEqual({
        changed: [],
        opensViews: WORLD_VIEWS,
        own: [OVERVIEW_VIEW, WORLD_VIEW],
    });
    expect(await w.view<ResultsView>(RESULTS_VIEW)).toMatchObject({ book: '1' });
    expect(w.asked.results.at(-1)).toMatchObject({ groupBy: null });
    expect(await w.act('worldbuilding.openOverview', { ...open, book: '2' })).toMatchObject({
        changed: [],
        opensViews: WORLD_VIEWS,
    });
    expect(await w.view<ResultsView>(RESULTS_VIEW)).toEqual({ book: null });
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.setFilter', filter);
    await w.act('worldbuilding.findEntries', { book: '1', query: 'na' });
    await w.act('worldbuilding.deleteWorld', { book: '1' });
    expect(await w.view<ResultsView>(RESULTS_VIEW)).toEqual({ book: null });
    expect(await w.view<FoundView>(FOUND_VIEW)).toEqual({ book: null });
});

test("finding an entry of a world opens its best matches by name and title, a combobox's worth, one request per query", async () => {
    const w = world(3);
    expect(await w.view<FoundView>(FOUND_VIEW)).toEqual({ book: null });
    expect(await w.act('worldbuilding.findEntries', { book: '1', query: 'na' })).toEqual({
        changed: [],
        opensViews: [FOUND_VIEW],
    });
    expect(await w.view<FoundView>(FOUND_VIEW)).toEqual({
        book: '1',
        query: 'na',
        entries: [named('7', 'name 7')],
        next: null,
    });
    expect(w.asked.found).toEqual([{ book: '1', query: 'na', limit: FOUND_PER_QUERY }]);
    expect(await w.otherView<FoundView>(FOUND_VIEW)).toEqual({ book: null });
});

test('the search schemas take a world and chips by id, a depth of directly or at any depth, and a page within one read', () => {
    const accepts = (type: string, payload: unknown) =>
        v.safeParse(actions[type as keyof typeof actions] as v.GenericSchema, payload).success;
    expect(accepts('worldbuilding.setFilter', filter)).toBe(true);
    expect(accepts('worldbuilding.setFilter', { ...filter, chips: [{ ...inSaltmarrow, depth: 'deep' }] })).toBe(false);
    expect(accepts('worldbuilding.setFilter', { ...filter, chips: [{ ...inSaltmarrow, kind: '0' }] })).toBe(false);
    expect(accepts('worldbuilding.setFilter', { ...filter, pageSize: 0 })).toBe(false);
    expect(accepts('worldbuilding.setFilter', { ...filter, pageSize: MAX_CARDS_PER_READ + 1 })).toBe(false);
    expect(accepts('worldbuilding.showResults', { from: null, pages: 0 })).toBe(false);
    expect(accepts('worldbuilding.showResults', { from: '', pages: 1 })).toBe(false);
    expect(accepts('worldbuilding.showResults', { from: '1.c2', pages: 2 })).toBe(true);
    expect(accepts('worldbuilding.showResults', { from: null, pages: MAX_CARDS_PER_READ + 1 })).toBe(false);
    expect(accepts('worldbuilding.findEntries', { book: 'x', query: '' })).toBe(false);
});

test("an imported book's offer is on the world's header; marking answers the cards and offers Undo in the last change until the next change", async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    const cardViews = [
        OVERVIEW_VIEW,
        RESULTS_VIEW,
        ENTRY_VIEW,
        POINTING_AT_VIEW,
        SELECTION_VIEW,
        FOUND_VIEW,
        WORLD_VIEW,
        LAST_CHANGE_VIEW,
    ];
    expect(await w.act('worldbuilding.markTitleKeysAsNames', { book: '1' })).toEqual({
        changed: cardViews,
        own: [WORLD_VIEW, LAST_CHANGE_VIEW],
    });
    expect(w.asked.namesOffer).toEqual([['mark', '1']]);
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ namesOffer: { running: 'marking', marked: 1000 } });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        ...NOTHING_CHANGED,
        markedTitleKeys: { book: '1' },
    });
    expect(await w.otherView<LastChangeView>(LAST_CHANGE_VIEW)).toEqual(NOTHING_CHANGED);
    expect(await w.act('worldbuilding.markTitleKeysAsNames', { book: '1' })).toEqual({
        refused: 'This world offers no names to mark.',
        changed: [WORLD_VIEW],
    });
    expect(await w.act('worldbuilding.undoMarkTitleKeysAsNames', { book: '1' })).toEqual({
        changed: cardViews,
        own: [WORLD_VIEW, LAST_CHANGE_VIEW],
    });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual(NOTHING_CHANGED);
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ namesOffer: { running: 'undoing' } });
    expect(await w.act('worldbuilding.undoMarkTitleKeysAsNames', { book: '1' })).toEqual({
        refused: 'Nothing was marked to take back.',
        changed: [WORLD_VIEW],
    });
    expect(await w.act('worldbuilding.markTitleKeysAsNames', { book: '9' })).toEqual({
        refused: 'That world no longer exists.',
        changed: [WORLDS_VIEW],
    });
});

test('leaving the offer answers only the header, which shows no offer from then on', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.createRelationKind', { book: '1', name: 'in' });
    expect(await w.act('worldbuilding.declineNamesOffer', { book: '1' })).toEqual({ changed: [WORLD_VIEW] });
    expect(await w.view<WorldView>(WORLD_VIEW)).toMatchObject({ namesOffer: null });
    expect((await w.view<LastChangeView>(LAST_CHANGE_VIEW)).createdKind).toEqual({ book: '1', kind: '2' });
    expect(v.safeParse(actions['worldbuilding.declineNamesOffer'], { book: 'one' }).success).toBe(false);
});

test('picking entries selects them as exceptions to nothing; unpicking the last clears the selection, and a deleted one drops out', async () => {
    const w = world(3);
    const pick = (entries: string[], selected: boolean, book = '1') =>
        w.act('worldbuilding.select', { book, entries, selected });
    expect(await pick(['7'], true)).toEqual({ refused: 'No world is shown.' });
    await w.act('worldbuilding.openOverview', open);
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toEqual({ book: null });
    expect(await pick(['7', '8'], true, '2')).toEqual({ refused: "That world isn't shown." });
    expect(await pick(['7', '8', '7'], true)).toEqual({ changed: [SELECTION_VIEW] });
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toEqual({
        book: '1',
        base: 'none',
        except: ['7', '8'],
        matching: null,
        matchingCapped: false,
    });
    expect(await w.otherView<SelectionView>(SELECTION_VIEW)).toEqual({ book: null });
    await pick(['7'], false);
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toMatchObject({ base: 'none', except: ['8'] });
    await pick(['7'], true);
    await w.act('worldbuilding.deleteEntry', { book: '1', entry: '8' });
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toMatchObject({ base: 'none', except: ['7'] });
    await pick(['7', '8'], false);
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toEqual({ book: null });
    await pick(['7'], true);
    expect(await w.act('worldbuilding.selectNone', { book: '1' })).toEqual({ changed: [SELECTION_VIEW] });
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toEqual({ book: null });
});

test('selecting all matching holds the shown filter, else the whole world; unpicking adds exceptions and the count follows', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    expect(await w.act('worldbuilding.selectAllMatching', { book: '1' })).toEqual({ changed: [SELECTION_VIEW] });
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toEqual({
        book: '1',
        base: 'matching',
        except: [],
        matching: 1000,
        matchingCapped: true,
    });
    expect(w.asked.selections.at(-1)).toEqual({ book: '1', base: 'matching', filter: null, except: [] });

    expect(await w.act('worldbuilding.setFilter', filter)).toEqual({
        changed: [SELECTION_VIEW],
        opensViews: [RESULTS_VIEW],
    });
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toEqual({ book: null });
    await w.act('worldbuilding.selectAllMatching', { book: '1' });
    expect(w.asked.selections).toHaveLength(1);
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toMatchObject({ matching: 5, matchingCapped: false });
    expect(w.asked.selections.at(-1)).toEqual({
        book: '1',
        base: 'matching',
        filter: { query: 'lamp', chips: [{ kind: '1', target: '8', depth: 'anyDepth' }] },
        except: [],
    });
    await w.act('worldbuilding.select', { book: '1', entries: ['301', '302'], selected: false });
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toMatchObject({ except: ['301', '302'], matching: 3 });
    await w.act('worldbuilding.select', { book: '1', entries: ['302'], selected: true });
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toMatchObject({ base: 'matching', except: ['301'] });

    expect(await w.act('worldbuilding.setFilter', { ...filter, query: '', chips: [] })).toEqual({
        changed: [RESULTS_VIEW, SELECTION_VIEW],
    });
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toEqual({ book: null });

    await w.act('worldbuilding.select', { book: '1', entries: ['7'], selected: true });
    expect(await w.act('worldbuilding.setFilter', filter)).toEqual({ changed: [], opensViews: [RESULTS_VIEW] });
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toMatchObject({ base: 'none', except: ['7'] });
    await w.act('worldbuilding.openOverview', { ...open, book: '2' });
    await w.act('worldbuilding.openOverview', open);
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toEqual({ book: null });
});

test('picking one at a time stops at one read of cards', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    const many = Array.from({ length: PICKED_AT_MOST }, (_, i) => String(1000 + i));
    expect(await w.act('worldbuilding.select', { book: '1', entries: many, selected: true })).toEqual({
        changed: [SELECTION_VIEW],
    });
    expect(await w.act('worldbuilding.select', { book: '1', entries: ['7'], selected: true })).toEqual({
        refused: `At most ${PICKED_AT_MOST} entries are picked one at a time; select all matching instead.`,
    });
    await w.act('worldbuilding.selectAllMatching', { book: '1' });
    expect(await w.act('worldbuilding.select', { book: '1', entries: many, selected: false })).toEqual({
        changed: [SELECTION_VIEW],
    });
});

test('a bulk action runs over the selection and clears it, answering the cards, the running jobs and the loops it left', async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', open);
    const moveTo = { moveTo: { kind: '1', target: '8' } };
    expect(await w.act('worldbuilding.bulk', { book: '1', action: moveTo, loopCheckLimit: 400 })).toEqual({
        refused: 'Nothing is selected.',
        changed: [SELECTION_VIEW],
    });
    await w.act('worldbuilding.selectAllMatching', { book: '1' });
    await w.act('worldbuilding.select', { book: '1', entries: ['7'], selected: false });
    const refused = { moveTo: { kind: '1', target: '999' } };
    expect(await w.act('worldbuilding.bulk', { book: '1', action: refused, loopCheckLimit: 400 })).toEqual({
        refused: "The target isn't an entry of this world.",
    });
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toMatchObject({ base: 'matching', except: ['7'] });

    expect(await w.view<BulkJobsView>(BULK_JOBS_VIEW)).toEqual({ book: '1', jobs: [] });
    expect(await w.act('worldbuilding.bulk', { book: '1', action: moveTo, loopCheckLimit: 400 })).toEqual({
        changed: [
            OVERVIEW_VIEW,
            RESULTS_VIEW,
            FOUND_VIEW,
            WORLDS_VIEW,
            WORLD_VIEW,
            SELECTION_VIEW,
            ENTRY_VIEW,
            POINTING_AT_VIEW,
            BULK_JOBS_VIEW,
            LAST_CHANGE_VIEW,
        ],
        own: [SELECTION_VIEW, BULK_JOBS_VIEW, LAST_CHANGE_VIEW],
    });
    expect(w.asked.bulk.at(-1)).toEqual({
        selection: { book: '1', base: 'matching', filter: null, except: ['7'] },
        action: moveTo,
        loopCheckLimit: 400,
        session: 's',
    });
    expect(await w.view<SelectionView>(SELECTION_VIEW)).toEqual({ book: null });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        ...NOTHING_CHANGED,
        unreachedLoops: [LOOP_OF_7],
    });
    expect(await w.view<BulkJobsView>(BULK_JOBS_VIEW)).toEqual({
        book: '1',
        jobs: [{ job: '1', action: moveTo, target: null, done: 1000 }],
    });
    expect(await w.otherView<BulkJobsView>(BULK_JOBS_VIEW)).toEqual({ book: null });
});

test('the selection schemas take entries by id, at most one read of them at once, and one bulk action of a known shape', () => {
    const ok = (type: string, payload: unknown) =>
        v.safeParse(actions[type as keyof typeof actions] as v.GenericSchema, payload).success;
    expect(ok('worldbuilding.select', { book: '1', entries: [], selected: true })).toBe(false);
    expect(ok('worldbuilding.select', { book: '1', entries: ['x'], selected: true })).toBe(false);
    const tooMany = Array.from({ length: PICKED_AT_MOST + 1 }, (_, i) => String(i));
    expect(ok('worldbuilding.select', { book: '1', entries: tooMany, selected: true })).toBe(false);
    const bulk = (action: unknown) => ok('worldbuilding.bulk', { book: '1', action, loopCheckLimit: 10 });
    expect(bulk({ delete: true })).toBe(true);
    expect(bulk({ delete: false })).toBe(false);
    expect(bulk({ set: { order: 5, position: 4 } })).toBe(true);
    expect(bulk({ set: {} })).toBe(false);
    expect(bulk({ set: { content: 'x' } })).toBe(false);
    expect(bulk({ alsoPutIn: { kind: '1', target: '8' } })).toBe(true);
    expect(bulk({ moveTo: { kind: '0', target: '8' } })).toBe(false);
    expect(bulk({ delete: true, moveTo: { kind: '1', target: '8' } })).toBe(false);
});

// A tab at the most every view can read: the widest overview, a results run of one read's cards, a selection of every
// match but one read's picked entries, an entry open with the widest sections and the most mention pages, a key's
// sharers and a target search shown.
async function atTheMost() {
    const w = world(3, { results: 10 * MAX_CARDS_PER_READ });
    const widest = Math.floor(MAX_CARDS_PER_READ / cardsPerTopLevelEntry(LAYOUT.regionsByNestingLevel));
    const shownAtTheMost = { endRank: widest, layout: LAYOUT };
    const picked = Array.from({ length: PICKED_AT_MOST }, (_, at) => String(1000 + at));
    for (const [type, payload] of [
        ['worldbuilding.openOverview', { ...open, ...shownAtTheMost, around: '7' }],
        ['worldbuilding.setFilter', { ...filter, pageSize: MAX_CARDS_PER_READ }],
        ['worldbuilding.selectAllMatching', { book: '1' }],
        ['worldbuilding.select', { book: '1', entries: picked, selected: false }],
        ['worldbuilding.openEntry', { entry: '7', pointingAt: shownAtTheMost }],
        ['worldbuilding.showMentions', { from: null, pages: MENTION_PAGES_AT_MOST }],
        ['worldbuilding.showKeySharers', { book: '1', entry: '7', key: 'Ilse' }],
        ['worldbuilding.findEntries', { book: '1', query: 'lamp' }],
    ] as const) {
        expect(await w.act(type, payload)).not.toHaveProperty('refused');
    }
    return { w, widest, shownAtTheMost };
}

// The reads of an answer's first part: the action's own work and the views it names its own.
async function readsOfTheFirstPart(w: Awaited<ReturnType<typeof atTheMost>>['w'], action: () => Promise<ActionResult>) {
    w.reads.asked = 0;
    const result = await action();
    const own = result.own ?? [...(result.changed ?? []), ...('opensViews' in result ? (result.opensViews ?? []) : [])];
    for (const key of own) await w.view(key);
    return w.reads.asked;
}

test("every action's first part, with every view at the most, reads within one part's budget", async () => {
    const most = LOOP_CHECK_VISITS_PER_WRITE;
    const relation = { book: '1', entry: '7', kind: '1', target: '8', loopCheckLimit: most };
    const farthest = Math.floor(STEP_CARDS_AT_MOST / cardsPerTopLevelEntry(LAYOUT.regionsByNestingLevel));
    // Each action, with what another tab did first.
    const answers: [string, (shown: Awaited<ReturnType<typeof atTheMost>>) => unknown, [string, unknown]?][] = [
        ['worldbuilding.openEntry', ({ shownAtTheMost }) => ({ entry: '8', pointingAt: shownAtTheMost })],
        ['worldbuilding.closeEntry', () => ({})],
        ['worldbuilding.showMentions', () => ({ from: null, pages: MENTION_PAGES_AT_MOST })],
        ['worldbuilding.showPointingAtRange', ({ widest }) => ({ kind: '1', firstRank: 0, endRank: widest })],
        ['worldbuilding.stepPointingAt', () => ({ kind: '1', from: null, by: farthest - 1 })],
        ['worldbuilding.openOverview', ({ shownAtTheMost }) => ({ ...open, ...shownAtTheMost, around: '7' })],
        ['worldbuilding.showRange', ({ widest }) => ({ firstRank: 0, endRank: widest })],
        ['worldbuilding.stepOverview', () => ({ from: null, by: farthest - 1 })],
        ['worldbuilding.addRelation', () => ({ ...relation, after: null, before: null, weak: false })],
        ['worldbuilding.moveRelation', () => ({ ...relation, newTarget: '7', after: null, before: null })],
        ['worldbuilding.removeRelation', () => relation],
        ['worldbuilding.setRelationWeak', () => ({ ...relation, weak: true })],
        ['worldbuilding.setEntryText', () => ({ book: '1', entry: '7', text: 'Ilse keeps the lamp.' })],
        ['worldbuilding.setPlacement', () => ({ book: '1', entry: '7', fields: { order: 5 } })],
        [
            'worldbuilding.createEntry',
            ({ shownAtTheMost }) => ({
                book: '1',
                after: '7',
                name: 'Varro',
                relation: { kind: '1', target: '8' },
                open: { pointingAt: shownAtTheMost },
                loopCheckLimit: most,
            }),
        ],
        [
            'worldbuilding.createEntry',
            () => ({ book: '1', after: '7', name: 'Varro', relation: null, open: null, loopCheckLimit: most }),
        ],
        ['worldbuilding.deleteEntry', () => ({ book: '1', entry: '8' })],
        ['worldbuilding.deleteEntry', () => ({ book: '1', entry: '7' })],
        [
            'worldbuilding.restoreEntry',
            () => ({ book: '1', entry: '7' }),
            ['worldbuilding.deleteEntry', { book: '1', entry: '7' }],
        ],
        [
            'worldbuilding.restoreEntry',
            () => ({ book: '1', entry: '8' }),
            ['worldbuilding.deleteEntry', { book: '1', entry: '8' }],
        ],
        ['worldbuilding.moveEntryToWorld', () => ({ book: '1', entry: '7', toBook: '2' })],
        ['worldbuilding.moveEntryToWorld', () => ({ book: '1', entry: '8', toBook: '2' })],
        ['worldbuilding.renameRelationKind', () => ({ book: '1', kind: '1', name: 'within' })],
        [
            'worldbuilding.mergeRelationKind',
            () => ({ book: '1', kind: '1', into: '2' }),
            ['worldbuilding.createRelationKind', { book: '1', name: 'within' }],
        ],
        ['worldbuilding.setFilter', () => ({ ...filter, pageSize: MAX_CARDS_PER_READ })],
        ['worldbuilding.showResults', () => ({ from: null, pages: 1 })],
        ['worldbuilding.findEntries', () => ({ book: '1', query: 'lamp' })],
        ['worldbuilding.select', () => ({ book: '1', entries: ['7'], selected: true })],
        ['worldbuilding.selectAllMatching', () => ({ book: '1' })],
        ['worldbuilding.bulk', () => ({ book: '1', action: { delete: true }, loopCheckLimit: most })],
        ['worldbuilding.markTitleKeysAsNames', () => ({ book: '1' })],
        [
            'worldbuilding.createWorld',
            ({ shownAtTheMost }) => ({ name: 'World 3', overview: { firstRank: 0, ...shownAtTheMost } }),
        ],
        ['worldbuilding.deleteWorld', () => ({ book: '1' })],
        ['worldbuilding.deleteWorld', () => ({ book: '2' })],
    ];
    for (const [type, payload, before] of answers) {
        const shown = await atTheMost();
        if (before) await shown.w.other(...before);
        let refused: string | null = null;
        const reads = await readsOfTheFirstPart(shown.w, async () => {
            const result = await shown.w.act(type, payload(shown));
            refused = 'refused' in result ? result.refused : null;
            return result;
        });
        expect({ type, refused, withinTheBudget: reads <= READS_PER_REQUEST }).toEqual({
            type,
            refused: null,
            withinTheBudget: true,
        });
    }
});

test("every later part, and every part of a push, reads one view at the most within one part's budget", async () => {
    const { w } = await atTheMost();
    for (const key of w.views) {
        w.reads.asked = 0;
        await w.view(key);
        expect({ key, withinTheBudget: w.reads.asked <= READS_PER_REQUEST }).toEqual({ key, withinTheBudget: true });
    }
});

test("a job's step reads its walk and its loop check within one part's budget, its push a part after it", () => {
    expect(WALK_STEPS_PER_READ + LOOP_CHECK_VISITS_PER_WRITE * READS_PER_LOOP_CHECK_VISIT).toBeLessThanOrEqual(
        READS_PER_REQUEST - READS_OF_COUNTED_LABELS,
    );
});

test("a part holds one action's work and one view's bounded reads, besides the counted labels", () => {
    expect(READS_OF_ACTION + READS_PER_VIEW + READS_OF_COUNTED_LABELS + READS_OF_LOOKS_PER_PART).toBeLessThanOrEqual(
        READS_PER_REQUEST,
    );
    expect(LOOP_CHECK_VISITS_PER_WRITE * READS_PER_LOOP_CHECK_VISIT).toBeLessThanOrEqual(READS_OF_ACTION);
    expect(STEP_CARDS_AT_MOST * READS_PER_CARD).toBeLessThanOrEqual(READS_OF_ACTION);
    expect(WALK_STEPS_PER_READ).toBeLessThanOrEqual(READS_OF_ACTION);
    expect(MAX_CARDS_PER_READ * READS_PER_DRAWN_CARD).toBeLessThanOrEqual(READS_PER_VIEW);
    expect(MAX_CARDS_PER_READ * READS_PER_DRAWN_CARD + WALK_STEPS_PER_READ).toBeLessThanOrEqual(
        READS_OF_ACTION + READS_PER_VIEW,
    );
    expect(TEXT_LINK_READS_PER_READ + Math.ceil(TEXT_LINK_READS_PER_READ / 2) * READS_PER_LOOK).toBeLessThanOrEqual(
        READS_OF_TEXT_LINKS,
    );
    expect(READS_OF_TEXT_LINKS + MENTION_CHECKS_PER_READ * READS_PER_MENTION_CHECK).toBeLessThanOrEqual(READS_PER_VIEW);
    expect(PICKED_AT_MOST + SELECTION_WALK_STEPS).toBeLessThanOrEqual(READS_PER_VIEW);
});
