import { actions, COUNTS_VIEW, LIST_VIEW, MATCHES_VIEW, VIEWS } from './protocol.ts';
import type { CardView, GreetingOp, Item, ListView, Target, TokenizerState } from './protocol.ts';
import { defineArea, patch } from '@st/server-ui';
import type { ActionContext, ActionResult, User, ViewContext } from '@st/server-ui';

export type Alternative = {
    /** its node id; an unstored card greeting's as the page names it */
    id: string;
    nodeId: string | null;
    /** the card greeting it is (a stored opening: the one it is linked to), by its character and id */
    greeting: { avatar: string; id: number } | null;
    text: string;
    name: string;
    isUser: boolean;
    isSystem: boolean;
    date: string | number | null;
    /** the values of the macros it draws, each macro's source to its value, null for one only known when sent */
    macros?: Record<string, string | null>;
};

/** a card's greetings, `ids[k]` the id of `greetings[k]` */
export type ListedCard = { avatar: string; ids: number[]; greetings: string[]; defaultPosition: number | null };

export type Listed = {
    alternatives: Alternative[];
    current: number | null;
    /** every card an alternative is a greeting of */
    cards: ListedCard[];
    /** the card a new greeting is added to */
    addsTo: string | null;
    /** the open chat's openings, each the card greeting it is or null, when the list is of a card the chat offers */
    openings: ({ avatar: string; id: number } | null)[] | null;
};

export type Ports = {
    list(context: ViewContext, target: Target): Promise<Listed | null>;
    hash(text: string): number;
    counts: {
        stored(user: User, tokenizer: TokenizerState, texts: string[]): Promise<(number | null)[]>;
        count(
            user: User,
            tokenizer: TokenizerState,
            texts: string[],
            each: (index: number, count: number | null) => boolean,
        ): Promise<void>;
    };
    match(query: string, texts: string[]): (number[] | null)[];
    greeting(
        context: ActionContext,
        avatar: string,
        op: GreetingChange,
    ): Promise<{ ok: true; opening: unknown } | { ok: false; reason: string; same?: number }>;
    move(
        context: ActionContext,
        nodeId: string,
        place: { after: string } | { first: true },
    ): Promise<{ ok: true } | { ok: false; reason: string }>;
};

/** a card's operation, the card being named apart */
export type GreetingChange = GreetingOp extends infer Op ? (Op extends unknown ? Omit<Op, 'avatar'> : never) : never;

function freshLook(target: Target, tokenizer: TokenizerState | null): Look {
    const look: Look = {
        target,
        tokenizer,
        query: '',
        items: [],
        current: null,
        cards: new Set(),
        addsTo: null,
        counted: new Map(),
        asked: new Set(),
        counting: null,
        counted1: Promise.resolve(),
        tell: () => {},
    };
    waitForCount(look);
    return look;
}

function waitForCount(look: Look) {
    look.counted1 = new Promise((resolve) => {
        look.tell = () => {
            resolve();
            waitForCount(look);
        };
    });
}

type Look = {
    target: Target;
    tokenizer: TokenizerState | null;
    query: string;
    items: Item[];
    current: number | null;
    /** the cards the list's greeting operations may change */
    cards: Set<string>;
    addsTo: string | null;
    counted: Map<string, number>;
    asked: Set<string>;
    counting: Promise<void> | null;
    counted1: Promise<void>;
    tell: () => void;
};

const LOOKS_KEPT = 32;
export const FIRST_PART = 40;
const GROWTH = 4;
export const SEARCH_STEP = 200;
const COUNTS_PART_MS = 50;
const SEARCH_PART_MS = 30;

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

const sameTarget = (a: Target, b: Target) => JSON.stringify(a) === JSON.stringify(b);

const sameGreeting = (a: { avatar: string; id: number } | null, b: { avatar: string; id: number } | null) =>
    a !== null && b !== null && a.avatar === b.avatar && a.id === b.id;

export function cardViewOf(card: ListedCard, hash: (text: string) => number): CardView {
    return {
        avatar: card.avatar,
        greetings: card.greetings,
        hashes: card.greetings.map((text) => hash(text)),
        defaultPosition: card.defaultPosition,
    };
}

export function itemsOf(listed: Listed, hash: (text: string) => number): Item[] {
    const cards = new Map(listed.cards.map((card) => [card.avatar, card]));
    const placeOf = (greeting: Alternative['greeting']) => {
        const card = greeting === null ? undefined : cards.get(greeting.avatar);
        const position = card?.ids.indexOf(greeting!.id) ?? -1;
        if (card === undefined || position < 0) return null;
        return { avatar: card.avatar, id: greeting!.id, position, hash: hash(card.greetings[position]!) };
    };
    return listed.alternatives.map((a, index) => {
        const at = listed.openings?.findIndex((opening) => sameGreeting(opening, a.greeting)) ?? -1;
        return {
            id: a.id,
            index,
            text: a.text,
            name: a.name,
            role: a.isSystem ? 'system' : a.isUser ? 'user' : 'assistant',
            date: a.date,
            nodeId: a.nodeId,
            card: placeOf(a.greeting),
            opening: at >= 0 ? at : null,
            macros: a.macros ?? null,
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
        cards: [],
        addsTo: null,
        chatOpen: false,
    };

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
            look.cards = new Set();
            look.addsTo = null;
            yield { ...empty, target: look.target };
            return;
        }
        const hash = (text: string) => ports.hash(text);
        const items = itemsOf(listed, hash);
        look.items = items;
        look.current = listed.current;
        look.cards = new Set(listed.cards.map((card) => card.avatar));
        look.addsTo = listed.addsTo;
        const view: ListView = {
            target: look.target,
            items,
            total: items.length,
            complete: true,
            current: listed.current,
            cards: listed.cards.map((card) => cardViewOf(card, hash)),
            addsTo: listed.addsTo,
            chatOpen: listed.openings !== null,
        };
        for (let size = FIRST_PART; size < items.length; size *= GROWTH) {
            const from = Math.max(0, Math.min(items.length - size, (listed.current ?? 0) - size / 2));
            yield { ...view, items: items.slice(from, from + size), complete: false };
            await turn();
        }
        yield view;
    }

    const countMisses = async (user: User, session: string, look: Look, texts: string[]) => {
        const tokenizer = look.tokenizer;
        if (!tokenizer) return;
        await ports.counts.count(user, tokenizer, texts, (index, count) => {
            const text = texts[index];
            if (text !== undefined && typeof count === 'number') look.counted.set(text, count);
            look.tell();
            return looks.get(session) === look;
        });
    };

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
                const current = look.current ?? 0;
                const place = new Map(look.items.map((item, index) => [item.text, Math.abs(index - current)]));
                misses.sort((a, b) => (place.get(a) ?? 0) - (place.get(b) ?? 0));
                const before = look.counting ?? Promise.resolve();
                const counting = before
                    .then(() => countMisses(context.user, context.session, look, misses))
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
        let last = performance.now();
        while (look.counting && lookOf(context) === look) {
            await look.counted1;
            const wait = last + COUNTS_PART_MS - performance.now();
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
            const fresh = countsOf(look, sent);
            if (Object.keys(fresh).length > 0) yield patch({ counts: fresh });
            last = performance.now();
        }
        const rest = countsOf(look, sent);
        if (Object.keys(rest).length > 0) yield patch({ counts: rest });
    }

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
        for (let from = SEARCH_STEP; from < items.length;) {
            await turn();
            if (lookOf(context) !== look || look.query !== query) return;
            const found: Record<string, number[]> = {};
            let checked = from;
            const until = performance.now() + SEARCH_PART_MS;
            do {
                const next = step(from);
                Object.assign(found, next.matches);
                checked = next.checked;
                from += SEARCH_STEP;
            } while (from < items.length && performance.now() < until);
            yield patch({ matches: found, checked });
        }
    }

    const all: ActionResult = { changed: [...VIEWS] };

    return defineArea({
        schemas: actions,
        views: { [LIST_VIEW]: readList, [COUNTS_VIEW]: readCounts, [MATCHES_VIEW]: readMatches },
        gone: (session) => void looks.delete(session),
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
                if (!look) return { refused: 'Nothing to search.' };
                look.query = query;
                return { changed: [MATCHES_VIEW] };
            },
            'alternatives.greeting': async (context, { avatar, ...op }) => {
                const look = lookOf(context);
                if (look === null || !look.cards.has(avatar)) return { refused: 'No card to change.' };
                if (op.op === 'add' && avatar !== look.addsTo) return { refused: 'No card to add to.' };
                const sent: GreetingChange =
                    op.op === 'edit' && op.text.trim() === ''
                        ? { op: 'delete', position: op.position, hash: op.hash }
                        : op;
                const result = await ports.greeting(context, avatar, sent);
                if (!result.ok) {
                    return {
                        refused: result.reason,
                        changed: [...VIEWS],
                        ...(result.same === undefined ? {} : { answer: { same: result.same } }),
                    };
                }
                return { ...all, answer: { opening: result.opening } };
            },
            'alternatives.move': async (context, { nodeId, side, target }) => {
                const look = lookOf(context);
                if (!look || !('message' in look.target))
                    return { refused: 'Only a message’s alternatives can be reordered.' };
                const at = look.items.findIndex((item) => item.nodeId === target);
                if (at < 0 || nodeId === target) return { refused: 'Alternative not found.' };
                const above = look.items
                    .slice(0, at)
                    .reverse()
                    .find((item) => item.nodeId !== nodeId)?.nodeId;
                const place =
                    side === 'after'
                        ? { after: target }
                        : above === undefined || above === null
                          ? ({ first: true } as const)
                          : { after: above };
                const shown = look.current === null ? null : (look.items[look.current]?.nodeId ?? null);
                const result = await ports.move(context, nodeId, place);
                if (!result.ok) return { refused: result.reason, changed: [...VIEWS] };
                const order = look.items.map((item) => item.nodeId).filter((id) => id !== nodeId);
                order.splice('first' in place ? 0 : order.indexOf(place.after) + 1, 0, nodeId);
                return { ...all, answer: { current: shown === null ? null : order.indexOf(shown) } };
            },
        },
    });
}
