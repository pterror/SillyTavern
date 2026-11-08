import { actions, COUNTS_VIEW, LIST_VIEW, MATCHES_VIEW, VIEWS } from './protocol.ts';
import type { GreetingOp, Item, ListView, Target, TokenizerState } from './protocol.ts';
import { defineArea, patch } from '@st/server-ui';
import type { ActionContext, ActionResult, User, ViewContext } from '@st/server-ui';

export type Alternative = {
    nodeId: string | null;
    text: string;
    name: string;
    isUser: boolean;
    isSystem: boolean;
    date: string | number | null;
};

export type Listed = {
    alternatives: Alternative[];
    current: number | null;
    card: { avatar: string; greetings: string[]; defaultPosition: number | null } | null;
    openings: string[] | null;
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
        op: GreetingOp,
    ): Promise<{ ok: true; opening: unknown } | { ok: false; reason: string }>;
};

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
    card: { avatar: string; greetings: number } | null;
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

const shown = (text: string) => text.trim();

export function itemsOf(listed: Listed, target: Target, hash: (text: string) => number): Item[] {
    const greetings = listed.card?.greetings ?? [];
    const positions = new Map<string, number>();
    greetings.forEach((text, position) => {
        if (text !== '' && !positions.has(shown(text))) positions.set(shown(text), position);
    });
    const openings = listed.openings?.map(shown) ?? null;
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
                if (!look) return { refused: 'Nothing is open to search.' };
                look.query = query;
                return { changed: [MATCHES_VIEW] };
            },
            'alternatives.greeting': async (context, op) => {
                const look = lookOf(context);
                const avatar = look ? ('greetings' in look.target ? look.target.greetings : look.card?.avatar) : null;
                if (avatar === null || avatar === undefined) return { refused: 'These have no card to change.' };
                const sent: GreetingOp =
                    op.op === 'edit' && op.text.trim() === ''
                        ? { op: 'delete', position: op.position, hash: op.hash }
                        : op;
                const result = await ports.greeting(context, avatar, sent);
                if (!result.ok) return { refused: result.reason, changed: [...VIEWS] };
                return { ...all, answer: { opening: result.opening } };
            },
        },
    });
}
