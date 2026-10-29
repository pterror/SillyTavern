import { actions, COUNTS_VIEW, LIST_VIEW, MATCHES_VIEW, VIEWS } from './protocol.ts';
import type { GreetingOp, Item, ListView, Target, TokenizerState } from './protocol.ts';
import { defineArea, patch } from '@st/server-ui';
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
        /**
         * Counts the texts, storing what it counted; `each` is told each count as it's done (null: the text couldn't be
         * counted).
         */
        count(
            user: User,
            tokenizer: TokenizerState,
            texts: string[],
            each: (index: number, count: number | null) => void,
        ): Promise<void>;
    };
    /** The chat search's matcher: each text's matched source ranges (flat [start, end) pairs), null where it doesn't match. */
    match(query: string, texts: string[]): (number[] | null)[];
    /** A card greeting operation; refused with the reason when the card changed under it, or isn't there. */
    greeting(user: User, avatar: string, op: GreetingOp): Promise<{ ok: true } | { ok: false; reason: string }>;
};

/** A look at a target, nothing read or counted yet. */
function freshLook(target: Target, tokenizer: TokenizerState | null): Look {
    const look: Look = {
        target,
        tokenizer,
        query: '',
        items: [],
        current: null,
        card: null,
        counted: new Map(),
        asked: new Set(),
        counting: null,
        counted1: Promise.resolve(),
        tell: () => {},
    };
    waitForCount(look);
    return look;
}

/** The look's next count kept as a promise, and how to keep it. */
function waitForCount(look: Look) {
    look.counted1 = new Promise((resolve) => {
        look.tell = () => {
            resolve();
            waitForCount(look);
        };
    });
}

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
    /** The misses being counted (null: none), and a promise kept each time one is counted. */
    counting: Promise<void> | null;
    counted1: Promise<void>;
    tell: () => void;
};

/** Tabs that went away without closing their look leave it; the oldest go past this many. */
const LOOKS_KEPT = 32;
/** How many rows around the current one a long list's first part has; each part after has this many times more. */
export const FIRST_PART = 40;
const GROWTH = 4;
/** How many texts a search checks before it sends what it found. */
export const SEARCH_STEP = 200;

/** Lets what's waiting run (an answer's lines go out) before the next step. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

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

    // A long list comes in parts: the rows around the current one at once, then more and more around them, then all.
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
        for (let size = FIRST_PART; size < items.length; size *= GROWTH) {
            const from = Math.max(0, Math.min(items.length - size, (listed.current ?? 0) - size / 2));
            yield { ...view, items: items.slice(from, from + size), complete: false };
            await turn();
        }
        yield view;
    }

    /** Counts the misses, nearest the current one first, telling the look each count as it's done. */
    const countMisses = async (user: User, look: Look, texts: string[]) => {
        const tokenizer = look.tokenizer;
        if (!tokenizer) return;
        await ports.counts.count(user, tokenizer, texts, (index, count) => {
            const text = texts[index];
            if (text !== undefined && typeof count === 'number') look.counted.set(text, count);
            look.tell();
        });
    };

    /** The counts of the look's items known now, by item id, but those already sent. */
    const countsOf = (look: Look, sent: Set<string>) => {
        const counts: Record<string, number> = {};
        for (const item of look.items) {
            const count = look.counted.get(item.text);
            if (count === undefined || sent.has(item.id)) continue;
            counts[item.id] = count;
            sent.add(item.id);
        }
        return counts;
    };

    // The counts the store has at once, then each miss as it's counted (a patch with what's new).
    async function* readCounts(context: ViewContext): AsyncGenerator<unknown, void, undefined> {
        const look = lookOf(context);
        if (!look?.tokenizer) {
            yield { counts: {} };
            return;
        }
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
                const before = look.counting ?? Promise.resolve();
                const counting = before
                    .then(() => countMisses(context.user, look, misses))
                    .catch((error: unknown) => console.error('[alternatives] counting failed:', error))
                    .finally(() => {
                        if (look.counting === counting) look.counting = null;
                        look.tell();
                    });
                look.counting = counting;
            }
        }
        const sent = new Set<string>();
        yield { counts: countsOf(look, sent) };
        while (look.counting && lookOf(context) === look) {
            await look.counted1;
            const fresh = countsOf(look, sent);
            if (Object.keys(fresh).length > 0) yield patch({ counts: fresh });
        }
        const rest = countsOf(look, sent);
        if (Object.keys(rest).length > 0) yield patch({ counts: rest });
    }

    // A search checks the texts a step at a time and sends what each step found (a patch), with how far it is.
    async function* readMatches(context: ViewContext): AsyncGenerator<unknown, void, undefined> {
        const look = lookOf(context);
        if (!look || look.query.trim() === '') {
            yield { query: look?.query ?? '', matches: null, checked: 0, total: 0 };
            return;
        }
        const { query, items } = look;
        const step = (from: number) => {
            const part = items.slice(from, from + SEARCH_STEP);
            const found = ports.match(
                query,
                part.map((item) => item.text),
            );
            const matches: Record<string, number[]> = {};
            part.forEach((item, i) => {
                const spans = found[i];
                if (spans) matches[item.id] = spans;
            });
            return { matches, checked: Math.min(items.length, from + SEARCH_STEP) };
        };
        yield { query, total: items.length, ...step(0) };
        for (let from = SEARCH_STEP; from < items.length; from += SEARCH_STEP) {
            await turn();
            // Another search took its place: this one stops.
            if (lookOf(context) !== look || look.query !== query) return;
            yield patch(step(from));
        }
    }

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
                looks.set(context.session, keep ? { ...before, query: '' } : freshLook(target, tokenizer));
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
