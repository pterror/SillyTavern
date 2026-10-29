import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

// The alternatives of a message (docs/design/alternatives.md): a chat message's swipes, the open chat's first
// message's openings, or a character's greetings. One tab looks at one target at a time; the server keeps it, with
// the tab's tokenizer and search, until the tab closes it.

/** The list: what the alternatives are, in the message's own order. */
export const LIST_VIEW = 'alternatives.list';
/** Their token counts, by item id: those the count store has at once, the rest as they're counted. */
export const COUNTS_VIEW = 'alternatives.counts';
/** The tab's search and what it matches. */
export const MATCHES_VIEW = 'alternatives.matches';
export const VIEWS = [LIST_VIEW, COUNTS_VIEW, MATCHES_VIEW] as const;

const target = v.union([
    /** A stored chat message (its node id): its siblings in the tree. */
    v.object({ message: v.pipe(v.string(), v.minLength(1)) }),
    /** The tab's open chat's first message: its stored openings, then the card's greetings no stored one is. */
    v.object({ opening: v.literal(true) }),
    /** A character's card greetings, in card order. */
    v.object({ greetings: v.pipe(v.string(), v.minLength(1)) }),
]);

export type Target = v.InferOutput<typeof target>;

/** The on-screen connection's tokenizer state, as the count routes take it (getTokenizerState()). */
const tokenizer = v.looseObject({ api: v.pipe(v.string(), v.minLength(1)) });

export type TokenizerState = v.InferOutput<typeof tokenizer>;

export type Item = {
    /** Which it is, kept while it stays (a node id, or a card greeting's text). */
    id: string;
    /** Its place among the message's alternatives (`#index + 1`). */
    index: number;
    text: string;
    name: string;
    role: 'user' | 'assistant' | 'system';
    /** When it was sent, as stored (upstream's send_date); null for a card greeting not in the chat. */
    date: string | number | null;
    /** Its message in the tree; null for a card greeting not stored. */
    nodeId: string | null;
    /** Where the card has it, and the hash its operations name it by; null when the card hasn't it. */
    card: { position: number; hash: number } | null;
    /**
     * A greetings list only: its place among the open chat's first message's alternatives, when the tab's chat is
     * this character's; null otherwise (it can't be shown in the chat).
     */
    opening: number | null;
};

export type ListView = {
    /** null: nothing is open (or what was asked for is gone). */
    target: Target | null;
    /**
     * The alternatives, in order; while `complete` is false, only those around the current one (the rest are being
     * sent).
     */
    items: Item[];
    total: number;
    complete: boolean;
    /** The one the message shows (a greetings list: the default); null when none. */
    current: number | null;
    /** The character whose card the greetings are (its avatar) and the card's list; null when there's no card. */
    card: { avatar: string; greetings: string[]; hashes: number[]; defaultPosition: number | null } | null;
    /** A greetings list: whether the tab's open chat is this character's (so a greeting can be shown in it). */
    chatOpen: boolean;
};

export type CountsView = { counts: Record<string, number> };

export type MatchesView = {
    query: string;
    /** By item id, each matching item's matched source ranges (UTF-16 [start, end) pairs, flat); null: no search. */
    matches: Record<string, number[]> | null;
};

const position = v.pipe(v.number(), v.integer(), v.minValue(0));
const hash = v.pipe(v.number(), v.finite());

export const actions = {
    /** Looks at a target: the tab's views become its. */
    'alternatives.open': v.object({ target, tokenizer: v.nullable(tokenizer) }),
    'alternatives.close': v.object({}),
    /** The chat search's syntax (quoted phrases, -negation); empty clears it. */
    'alternatives.search': v.object({ query: v.string() }),
    /**
     * A card greeting operation on the open target's card, named by position and hash (refused when the greeting
     * there changed). An edit to empty text removes the greeting.
     */
    'alternatives.greeting': v.variant('op', [
        v.object({ op: v.literal('add'), text: v.pipe(v.string(), v.minLength(1)) }),
        v.object({ op: v.literal('edit'), position, hash, text: v.string() }),
        v.object({ op: v.literal('delete'), position, hash }),
        v.object({
            op: v.literal('move'),
            position,
            hash,
            side: v.picklist(['before', 'after']),
            target: position,
            targetHash: hash,
        }),
        v.object({ op: v.literal('default'), position, hash }),
        v.object({ op: v.literal('undefault'), hash }),
    ]),
} satisfies ActionSchemas;

export type GreetingOp = v.InferOutput<(typeof actions)['alternatives.greeting']>;
