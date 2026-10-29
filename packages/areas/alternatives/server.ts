import { actions, COUNTS_VIEW, LIST_VIEW, MATCHES_VIEW, VIEWS } from './protocol.ts';
import type { CountsView, GreetingOp, Item, ListView, MatchesView, Target, TokenizerState } from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { ActionResult, User, ViewContext } from '@st/server-ui';

// The alternatives of a message (packages/areas/alternatives/protocol.ts), over the chat tree, the card and the
// token count store, which old server code reads and writes.

/** An alternative as old code reads it. */
export type Alternative = {
    nodeId: string | null;
    text: string;
    name: string;
    isUser: boolean;
    isSystem: boolean;
    date: string | number | null;
};

/** What a target is, as old code reads it; null when it isn't there (no chat open, no such message or card). */
export type Listed = {
    alternatives: Alternative[];
    /** Which the message shows; a greetings list: the default. */
    current: number | null;
    /** The card's greetings (card order, as stored, empty ones included) and default; null for a group's chat. */
    card: { avatar: string; greetings: string[]; defaultPosition: number | null } | null;
    /** A greetings list whose character's chat the tab has open: the texts of that chat's first message's alternatives. */
    openings: string[] | null;
};

/** What old server code does for this area. */
export type Ports = {
    list(context: ViewContext, target: Target): Promise<Listed | null>;
    /** The hash a card greeting's operations name it by. */
    hash(text: string): number;
    counts: {
        /** What the count store has for each text (null: not stored). */
        stored(user: User, tokenizer: TokenizerState, texts: string[]): Promise<(number | null)[]>;
        /** Counts the texts, storing what it counted; null where a text couldn't be counted. */
        count(user: User, tokenizer: TokenizerState, texts: string[]): Promise<(number | null)[]>;
    };
    /** The chat search's matcher: each text's matched source ranges (flat [start, end) pairs), null where it doesn't match. */
    match(query: string, texts: string[]): (number[] | null)[];
    /** A card greeting operation; refused with the reason when the card changed under it, or isn't there. */
    greeting(user: User, avatar: string, op: GreetingOp): Promise<{ ok: true } | { ok: false; reason: string }>;
    /** Pushes views to one tab (what changed came from elsewhere: counting finished). */
    changed(user: User, session: string, keys: string[]): Promise<void>;
};

/** A tab's look at a target. */
type Look = {
    target: Target;
    tokenizer: TokenizerState | null;
    query: string;
    /** The list as last read, which counts and matches are of. */
    items: Item[];
    current: number | null;
    /** The card the list is of, and how many greetings it had. */
    card: { avatar: string; greetings: number } | null;
    counted: Map<string, number>;
    /** Texts being counted, or that couldn't be: not asked for again. */
    asked: Set<string>;
};

/** Tabs that went away without closing their look leave it; the oldest go past this many. */
const LOOKS_KEPT = 32;
/** How many rows around the current one a long list's first part has. */
export const FIRST_PART = 40;
/** Counted misses are pushed this many at a time, so the counts fill in as they come. */
const COUNT_BATCH = 64;

const sameTarget = (a: Target, b: Target) => JSON.stringify(a) === JSON.stringify(b);

/** Whether two texts read the same in the chat (spaces and line breaks around them don't show). */
const shown = (text: string) => text.trim();

/** The list's items from what old code read: each card greeting at its position, with its hash. */
export function itemsOf(listed: Listed, target: Target, hash: (text: string) => number): Item[] {
    const greetings = listed.card?.greetings ?? [];
    const positions = new Map<string, number>();
    greetings.forEach((text, position) => {
        if (text !== '' && !positions.has(shown(text))) positions.set(shown(text), position);
    });
    const openings = listed.openings?.map(shown) ?? null;
    // A greeting not stored in the chat is known by its text (its place on the card changes as others move): the
    // same text twice is told apart by which it is.
    const seen = new Map<number, number>();
    const idOf = (text: string) => {
        const key = hash(text);
        const nth = seen.get(key) ?? 0;
        seen.set(key, nth + 1);
        return nth === 0 ? `card:${key}` : `card:${key}:${nth}`;
    };
    return listed.alternatives.map((a, index) => {
        const position = 'greetings' in target ? index : positions.get(shown(a.text));
        const card = position === undefined ? null : { position, hash: hash(greetings[position] ?? a.text) };
        const at = openings?.indexOf(shown(a.text)) ?? -1;
        return {
            id: a.nodeId ?? idOf(a.text),
            index,
            text: a.text,
            name: a.name,
            role: a.isSystem ? 'system' : a.isUser ? 'user' : 'assistant',
            date: a.date,
            nodeId: a.nodeId,
            card,
            opening: at >= 0 ? at : null,
        };
    });
}

export function alternativesArea(ports: Ports) {
    const looks = new Map<string, Look>();
    const lookOf = (context: ViewContext) => looks.get(context.session) ?? null;

    const empty: ListView = {
        target: null,
        items: [],
        total: 0,
        complete: true,
        current: null,
        card: null,
        chatOpen: false,
    };

    // A long list comes in two parts: the rows around the current one, at once, then all of them.
    async function* readList(context: ViewContext): AsyncGenerator<ListView, void, undefined> {
        const look = lookOf(context);
        if (!look) {
            yield empty;
            return;
        }
        const listed = await ports.list(context, look.target);
        if (!listed) {
            look.items = [];
            look.current = null;
            look.card = null;
            yield { ...empty, target: look.target };
            return;
        }
        const items = itemsOf(listed, look.target, (text) => ports.hash(text));
        look.items = items;
        look.current = listed.current;
        look.card = listed.card
            ? { avatar: listed.card.avatar, greetings: listed.card.greetings.filter((text) => text !== '').length }
            : null;
        const view: ListView = {
            target: look.target,
            items,
            total: items.length,
            complete: true,
            current: listed.current,
            card: listed.card
                ? { ...listed.card, hashes: listed.card.greetings.map((text) => ports.hash(text)) }
                : null,
            chatOpen: listed.openings !== null,
        };
        if (items.length > FIRST_PART) {
            const from = Math.max(0, Math.min(items.length - FIRST_PART, (listed.current ?? 0) - FIRST_PART / 2));
            yield { ...view, items: items.slice(from, from + FIRST_PART), complete: false };
        }
        yield view;
    }

    /** Counts the misses, nearest the current one first, pushing each batch's counts as it's done. */
    const countMisses = async (user: User, session: string, look: Look, texts: string[]) => {
        const tokenizer = look.tokenizer;
        if (!tokenizer) return;
        for (let from = 0; from < texts.length; from += COUNT_BATCH) {
            if (looks.get(session) !== look) return;
            const batch = texts.slice(from, from + COUNT_BATCH);
            const counts = await ports.counts.count(user, tokenizer, batch);
            batch.forEach((text, i) => {
                const count = counts[i];
                if (typeof count === 'number') look.counted.set(text, count);
            });
            if (looks.get(session) === look) await ports.changed(user, session, [COUNTS_VIEW]);
        }
    };

    const readCounts = async (context: ViewContext): Promise<CountsView> => {
        const look = lookOf(context);
        if (!look?.tokenizer) return { counts: {} };
        const unknown = [...new Set(look.items.map((item) => item.text))].filter(
            (text) => !look.counted.has(text) && !look.asked.has(text),
        );
        if (unknown.length > 0) {
            const stored = await ports.counts.stored(context.user, look.tokenizer, unknown);
            const misses: string[] = [];
            unknown.forEach((text, i) => {
                const count = stored[i];
                if (typeof count === 'number') look.counted.set(text, count);
                else misses.push(text);
                look.asked.add(text);
            });
            if (misses.length > 0) {
                // Those nearest the one shown come first.
                const current = look.current ?? 0;
                const place = new Map(look.items.map((item, index) => [item.text, Math.abs(index - current)]));
                misses.sort((a, b) => (place.get(a) ?? 0) - (place.get(b) ?? 0));
                countMisses(context.user, context.session, look, misses).catch((error: unknown) =>
                    console.error('[alternatives] counting failed:', error),
                );
            }
        }
        const counts: Record<string, number> = {};
        for (const item of look.items) {
            const count = look.counted.get(item.text);
            if (count !== undefined) counts[item.id] = count;
        }
        return { counts };
    };

    const readMatches = async (context: ViewContext): Promise<MatchesView> => {
        const look = lookOf(context);
        if (!look || look.query.trim() === '') return { query: look?.query ?? '', matches: null };
        const found = ports.match(
            look.query,
            look.items.map((item) => item.text),
        );
        const matches: Record<string, number[]> = {};
        look.items.forEach((item, i) => {
            const spans = found[i];
            if (spans) matches[item.id] = spans;
        });
        return { query: look.query, matches };
    };

    const all: ActionResult = { changed: [...VIEWS] };

    return defineArea({
        schemas: actions,
        views: { [LIST_VIEW]: readList, [COUNTS_VIEW]: readCounts, [MATCHES_VIEW]: readMatches },
        actions: {
            'alternatives.open': async (context, { target, tokenizer }) => {
                const before = looks.get(context.session);
                const keep =
                    before !== undefined &&
                    sameTarget(before.target, target) &&
                    JSON.stringify(before.tokenizer) === JSON.stringify(tokenizer);
                looks.delete(context.session);
                looks.set(context.session, {
                    target,
                    tokenizer,
                    query: '',
                    items: keep ? before.items : [],
                    current: keep ? before.current : null,
                    card: keep ? before.card : null,
                    counted: keep ? before.counted : new Map(),
                    asked: keep ? before.asked : new Set(),
                });
                for (const session of looks.keys()) {
                    if (looks.size <= LOOKS_KEPT) break;
                    looks.delete(session);
                }
                return all;
            },
            'alternatives.close': async (context) => {
                looks.delete(context.session);
                return all;
            },
            'alternatives.search': async (context, { query }) => {
                const look = lookOf(context);
                if (!look) return { refused: 'Nothing is open to search.' };
                look.query = query;
                return { changed: [MATCHES_VIEW] };
            },
            'alternatives.greeting': async (context, op) => {
                const look = lookOf(context);
                const avatar = look ? ('greetings' in look.target ? look.target.greetings : look.card?.avatar) : null;
                if (avatar === null || avatar === undefined) return { refused: 'These have no card to change.' };
                const greetingsBefore = look?.card?.greetings ?? 0;
                // Emptying a greeting is removing it.
                const sent: GreetingOp =
                    op.op === 'edit' && op.text.trim() === ''
                        ? { op: 'delete', position: op.position, hash: op.hash }
                        : op;
                const result = await ports.greeting(context.user, avatar, sent);
                if (!result.ok) return { refused: result.reason, changed: [...VIEWS] };
                // The first greeting a character gets is its default, as when it's created with one.
                if (sent.op === 'add' && greetingsBefore === 0) {
                    await ports.greeting(context.user, avatar, {
                        op: 'default',
                        position: 0,
                        hash: ports.hash(sent.text),
                    });
                }
                return all;
            },
        },
    });
}
