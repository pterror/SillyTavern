import * as v from 'valibot';

// What the page and the server say to each other (packages/README.md). An area declares its actions as schemas and
// its views as types; the server validates every action against its schema before running it, and both sides take
// their types from the same declaration.

/** A view as sent: which view, how new, and its value. The page keeps a view only when `version` is newer. */
export type ViewFrame = { key: string; version: number; value: unknown };

/** What `POST /api/ui/action` answers: every view the action changed that the tab shows. */
export type ActionAnswer = { ok: true; views: ViewFrame[] } | { ok: false; error: string; views: ViewFrame[] };

/** A push on the tab's stream: views changed by something other than this tab's own action. */
export type ViewPush = { type: 'views'; views: ViewFrame[] };

/** An area's actions, by type: each one's payload schema. */
export type ActionSchemas = Record<string, v.GenericSchema>;

const chatOwner = v.union([
    v.object({ avatar: v.pipe(v.string(), v.minLength(1)) }),
    v.object({ group: v.pipe(v.string(), v.minLength(1)) }),
]);

/** Whose chat: a character's (by avatar) or a group's (by id). */
export type ChatOwner = v.InferOutput<typeof chatOwner>;

/**
 * The actions every tab has, whatever areas exist: what it shows. Opening a chat is the old chat route's, which tells
 * the server too; `chat.show` says it again when the server may have lost it (the tab's stream reconnected).
 */
export const viewActions = {
    'view.open': v.object({ key: v.string() }),
    'view.close': v.object({ key: v.string() }),
    'chat.show': chatOwner,
    'chat.close': v.object({}),
} satisfies ActionSchemas;

/** The payload type of an action, from its schema. */
export type Payload<S extends ActionSchemas, T extends keyof S> = v.InferInput<S[T]>;

/** An action as the page sends it. */
export type Action<S extends ActionSchemas> = { [T in keyof S & string]: { type: T; payload: Payload<S, T> } }[keyof S &
    string];

/** The view keys an area's views are found under, with the value each holds. */
export type ViewTypes = Record<string, unknown>;
