import fs from 'node:fs/promises';
import express from 'express';
import type { Request, Response, Router } from 'express';
import * as v from 'valibot';
import { viewActions } from '@st/protocol';
import type { ActionAnswer, ActionSchemas, ChatOwner, ViewFrame, ViewPush } from '@st/protocol';

// The server side of packages/README.md: areas declare views and actions; this runs actions, answers with the views
// they changed, and pushes views changed by anything else to the tabs showing them.

/** Whose request it is (the old server's auth decides: see `createUi`'s `userOf`). */
export type User = { handle: string; directories: { root: string } & Record<string, string> };

/** Which chat a tab shows, as the server's chat code names it (opaque here). */
export type ChatRef = { tree: string };

export type ViewContext = { user: User; session: string; chat: ChatRef | null };

/** An upload that came with the action (the request's multipart file). */
export type Upload = { path: string; name: string; type: string; size: number };

export type ActionContext = ViewContext & { upload: Upload | null };

/** What an action did: which views it changed, or why it didn't do it (shown to the user as is). */
export type ActionResult = { changed: string[] } | { refused: string; changed?: string[] };

type Handlers<S extends ActionSchemas> = {
    [T in keyof S]: (context: ActionContext, payload: v.InferOutput<S[T]>) => Promise<ActionResult>;
};

/**
 * A view's reader: its value, or its value in parts (an async iterable: a long list, what's in view first, then the
 * rest). Each part is the whole view as it stands, newer than the one before; the first is answered at once and the
 * rest follow on the same answer (NDJSON) or push.
 */
export type ViewReader = (context: ViewContext) => Promise<unknown> | AsyncIterable<unknown>;

export type Area = {
    schemas: ActionSchemas;
    views: Record<string, ViewReader>;
    actions: Record<string, (context: ActionContext, payload: unknown) => Promise<ActionResult>>;
    /** Views that depend on the tab's chat: read again when it changes. */
    followChat: string[];
};

/** An area, with every action its schemas declare handled and each payload typed by its schema. */
export function defineArea<S extends ActionSchemas>(area: {
    schemas: S;
    views: Area['views'];
    actions: Handlers<S>;
    followChat?: string[];
}): Area {
    return {
        schemas: area.schemas,
        views: area.views,
        actions: area.actions as Area['actions'],
        followChat: area.followChat ?? [],
    };
}

/**
 * What the server knows of a tab: what it shows. It's kept in memory only, and lost with a restart or a dropped
 * stream; the tab says it again whenever its stream (re)connects (`chat.show`, `view.open`), so nothing depends on
 * the server having kept it.
 */
type Tab = {
    user: User;
    session: string;
    chat: ChatRef | null;
    open: Set<string>;
    streams: Set<(push: ViewPush) => void>;
};

/** The file the old server's upload parser (multer) puts on the request. */
type MulterFile = { path: string; originalname: string; mimetype: string; size: number };

const SESSION_HEADER = 'X-ST-Session';
/** Versions a read in parts keeps for its later parts. */
const PARTS = 1_000_000;

/** A later part of a view read in parts that is only what changed (see ViewFrame). */
class Patch {
    readonly value: unknown;
    constructor(value: unknown) {
        this.value = value;
    }
}

/** A part that patches the view's value rather than replacing it. */
export const patch = (value: unknown): unknown => new Patch(value);

/** What a part patches, when it's a patch (for an area's tests, which read their views' parts). */
export const patchOf = (part: unknown): { value: unknown } | null => (part instanceof Patch ? part : null);

const isParts = (value: unknown): value is AsyncIterable<unknown> =>
    typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type UiOptions = {
    /** Whose request it is (null: nobody's). */
    userOf: (request: Request) => User | null;
    /** The chat of a character or group (null: there is none). */
    chatOf: (user: User, owner: ChatOwner) => Promise<ChatRef | null>;
};

export type Ui = {
    /** `POST /api/ui/action`, behind the old server's auth. */
    router: Router;
    /** A tab's stream opened (the old changes stream): views changed elsewhere are pushed through `push`. */
    attach(user: User, session: string, push: (push: ViewPush) => void): () => void;
    /**
     * A tab switched chats (the old open-chat route): answers its views that follow the chat, read for that chat, for
     * the route's answer to carry (the open is the action they follow from).
     */
    showChat(user: User, session: string, chat: ChatRef | null): Promise<ViewFrame[]>;
    /**
     * The tab's chat changed under it (its state, or where its session is in it): its views that follow the chat are
     * pushed. Told per tab by that tab's stream, so each tab reads its own once.
     */
    chatMoved(user: User, session: string): Promise<void>;
    /** Something outside the areas changed these views (a write through old code). */
    changed(user: User, keys: string[]): Promise<void>;
    /**
     * Something changed these views for one tab only (what it reads depends on the tab: its chat, or what it looks
     * at): they're pushed to it, if it shows them.
     */
    changedFor(user: User, session: string, keys: string[]): Promise<void>;
};

export function createUi(areas: Area[], { userOf, chatOf }: UiOptions): Ui {
    const views = new Map<string, Area['views'][string]>();
    const actions = new Map<string, { schema: v.GenericSchema; run: Area['actions'][string]; views: string[] }>();
    const followChat = new Set<string>();
    for (const area of areas) {
        for (const [key, read] of Object.entries(area.views)) {
            if (views.has(key)) throw new Error(`Two areas define the view ${key}`);
            views.set(key, read);
        }
        for (const [type, schema] of Object.entries(area.schemas)) {
            const run = area.actions[type];
            if (!run) throw new Error(`The action ${type} has no handler`);
            if (actions.has(type) || type in viewActions) throw new Error(`Two areas define the action ${type}`);
            actions.set(type, { schema, run, views: Object.keys(area.views) });
        }
        for (const key of area.followChat) followChat.add(key);
    }

    const tabs = new Map<string, Tab>();
    // Versions only grow while the server runs: microseconds since the epoch, or one past the last when two come
    // within the same microsecond. (A page starts its count over when its stream reconnects, so a restart with the
    // clock set back can't leave it holding views it thinks are newer.)
    let lastVersion = 0;
    const nextVersion = () => (lastVersion = Math.max(lastVersion + 1, Date.now() * 1000));

    const tabOf = (user: User, session: string): Tab => {
        let tab = tabs.get(session);
        if (!tab || tab.user.directories.root !== user.directories.root) {
            tab = { user, session, chat: null, open: new Set(), streams: new Set() };
            tabs.set(session, tab);
        }
        return tab;
    };

    /** Views read: the frames there are now, and the later parts of those read in parts. */
    type Read = { frames: ViewFrame[]; later: AsyncIterable<ViewFrame>[] };

    const frame = async (tab: Tab, key: string): Promise<Read> => {
        const read = views.get(key);
        if (!read) throw new Error(`No view ${key}`);
        // Numbered when the read starts: a read that began before another write can't come out newer than one
        // that began after it. A read in parts keeps the next numbers for its later parts, so they're newer than its
        // first and older than any read that starts after it.
        const version = nextVersion();
        lastVersion += PARTS;
        const value = read({ user: tab.user, session: tab.session, chat: tab.chat });
        if (!isParts(value)) return { frames: [{ key, version, value: await value }], later: [] };
        const parts = value[Symbol.asyncIterator]();
        const first = await parts.next();
        if (first.done === true) throw new Error(`The view ${key} read nothing`);
        const later = (async function* () {
            for (let part = 1; ; part++) {
                const next = await parts.next();
                if (next.done === true) return;
                if (part >= PARTS) throw new Error(`The view ${key} read too many parts`);
                const value = next.value as unknown;
                yield value instanceof Patch
                    ? { key, version: version + part, patch: value.value }
                    : { key, version: version + part, value };
            }
        })();
        return { frames: [{ key, version, value: first.value as unknown }], later: [later] };
    };

    /** The views among `keys` the tab shows, read for it. */
    const framesOf = async (tab: Tab, keys: Iterable<string>): Promise<Read> => {
        const all: Read = { frames: [], later: [] };
        for (const key of new Set(keys)) {
            if (!tab.open.has(key)) continue;
            const { frames, later } = await frame(tab, key);
            all.frames.push(...frames);
            all.later.push(...later);
        }
        return all;
    };

    /** Pushes views to a tab's streams: those there are now, then each later part as it's read. */
    const push = (tab: Tab, { frames, later }: Read) => {
        if (frames.length > 0) for (const stream of tab.streams) stream({ type: 'views', views: frames });
        for (const parts of later) {
            void (async () => {
                for await (const part of parts) {
                    // The tab went away: the rest isn't read.
                    if (tab.streams.size === 0) break;
                    for (const stream of tab.streams) stream({ type: 'views', views: [part] });
                }
            })().catch((error: unknown) => console.error("[ui] a view's later part not read:", error));
        }
    };

    /** The changed views each tab of the user shows: answered to `actor` (returned), pushed to the others. */
    const spread = async (user: User, keys: string[], actor: Tab | null): Promise<Read> => {
        let answer: Read = { frames: [], later: [] };
        for (const tab of tabs.values()) {
            if (tab.user.directories.root !== user.directories.root) continue;
            const read = await framesOf(tab, keys);
            if (tab === actor) answer = read;
            else push(tab, read);
        }
        if (actor && !tabs.has(actor.session)) answer = await framesOf(actor, keys);
        return answer;
    };

    const pushTo = async (user: User, session: string, keys: Iterable<string>) => {
        const tab = tabs.get(session);
        if (!tab || tab.user.directories.root !== user.directories.root) return;
        push(tab, await framesOf(tab, keys));
    };

    const act = async (request: Request, response: Response) => {
        /**
         * The answer: one JSON object, or, when views it carries are read in parts, NDJSON: the answer first, then a
         * line `{ views }` for each later part as it's read.
         */
        const answer = async (result: ActionAnswer, status = 200, later: AsyncIterable<ViewFrame>[] = []) => {
            if (later.length === 0) {
                response.status(status).send(result);
                return;
            }
            response.status(status).type('application/x-ndjson');
            response.write(`${JSON.stringify(result)}\n`);
            // Each view's parts go out as they're read, whichever view they're of (one still counting doesn't hold back
            // another's).
            await Promise.all(
                later.map(async (parts) => {
                    try {
                        for await (const part of parts) {
                            // The page went away: the rest isn't read.
                            if (response.destroyed) break;
                            response.write(`${JSON.stringify({ views: [part] })}\n`);
                        }
                    } catch (error) {
                        console.error("[ui] a view's later part not read:", error);
                    }
                }),
            );
            response.end();
        };
        const file = (request as Request & { file?: MulterFile }).file;
        const upload = file ? { path: file.path, name: file.originalname, type: file.mimetype, size: file.size } : null;
        const body = request.body as { type?: unknown; payload?: unknown } | undefined;
        const type = typeof body?.type === 'string' ? body.type : '';
        /** The views a failed action may have changed (its area's), read again so the tab shows what's there. */
        let mayHaveChanged: string[] = [];
        let tab: Tab | null = null;
        try {
            const user = userOf(request);
            const session = request.get(SESSION_HEADER);
            if (!user || session === undefined || !SESSION.test(session)) {
                await answer({ ok: false, error: 'no session', views: [] }, 400);
                return;
            }
            tab = tabOf(user, session);
            // Multipart (an action with a file) carries the payload as JSON text beside the file.
            let payload: unknown = body?.payload;
            if (typeof payload === 'string') {
                try {
                    payload = JSON.parse(payload);
                } catch {
                    await answer({ ok: false, error: 'the payload is not JSON', views: [] }, 400);
                    return;
                }
            }
            if (type === 'chat.show' || type === 'chat.close') {
                const parsed = v.safeParse(viewActions[type], payload);
                if (!parsed.success) {
                    await answer({ ok: false, error: 'not a chat', views: [] }, 400);
                    return;
                }
                tab.chat = type === 'chat.show' ? await chatOf(user, parsed.output as ChatOwner) : null;
                const read = await framesOf(tab, followChat);
                await answer({ ok: true, views: read.frames }, 200, read.later);
                return;
            }
            if (type === 'view.open' || type === 'view.close') {
                const parsed = v.safeParse(viewActions[type], payload);
                if (!parsed.success || !views.has(parsed.output.key)) {
                    await answer({ ok: false, error: 'no such view', views: [] }, 400);
                    return;
                }
                if (type === 'view.close') {
                    tab.open.delete(parsed.output.key);
                    await answer({ ok: true, views: [] });
                    return;
                }
                tab.open.add(parsed.output.key);
                const read = await frame(tab, parsed.output.key);
                await answer({ ok: true, views: read.frames }, 200, read.later);
                return;
            }
            const action = actions.get(type);
            if (!action) {
                await answer({ ok: false, error: `no action ${type}`, views: [] }, 400);
                return;
            }
            const parsed = v.safeParse(action.schema, payload);
            if (!parsed.success) {
                const issue = parsed.issues.map((i) => `${v.getDotPath(i) ?? type}: ${i.message}`).join('; ');
                await answer({ ok: false, error: issue, views: [] }, 400);
                return;
            }
            mayHaveChanged = action.views;
            const result = await action.run({ user, session, chat: tab.chat, upload }, parsed.output);
            const changed = await spread(user, result.changed ?? [], tab);
            await answer(
                'refused' in result
                    ? { ok: false, error: result.refused, views: changed.frames }
                    : { ok: true, views: changed.frames },
                200,
                changed.later,
            );
            return;
        } catch (error) {
            console.error(`[ui] ${type} failed:`, error);
            // It may have done part of what it does: the tab (and the user's others) get what's there now.
            let views: ViewFrame[] = [];
            if (tab && mayHaveChanged.length > 0) {
                try {
                    // Only what can be read at once: a failed action's answer isn't held open.
                    views = (await spread(tab.user, mayHaveChanged, tab)).frames;
                } catch (again) {
                    console.error(`[ui] after ${type} failed, its views couldn't be read:`, again);
                }
            }
            if (!response.headersSent) await answer({ ok: false, error: 'internal', views }, 500);
            return;
        } finally {
            // An action that keeps the upload moves it; whatever is left is the parser's temporary file.
            if (upload) await fs.rm(upload.path, { force: true });
        }
    };
    const router = express.Router();
    // Express doesn't wait on a handler's promise: what escapes act() (its cleanup failing) is logged here.
    router.post('/', (request: Request, response: Response) => {
        act(request, response).catch((error: unknown) => {
            console.error('[ui] action not finished:', error);
            if (!response.headersSent) response.status(500).send({ ok: false, error: 'internal', views: [] });
        });
    });

    return {
        router,
        attach(user, session, push) {
            const tab = tabOf(user, session);
            tab.streams.add(push);
            return () => {
                tab.streams.delete(push);
                if (tab.streams.size === 0 && tabs.get(session) === tab) tabs.delete(session);
            };
        },
        async showChat(user, session, chat) {
            const tab = tabOf(user, session);
            if (tab.chat?.tree === chat?.tree) return [];
            tab.chat = chat;
            // The old route's answer carries what's read at once; later parts come by push.
            const read = await framesOf(tab, followChat);
            push(tab, { frames: [], later: read.later });
            return read.frames;
        },
        async chatMoved(user, session) {
            if (tabs.get(session)?.chat) await pushTo(user, session, followChat);
        },
        async changed(user, keys) {
            await spread(user, keys, null);
        },
        changedFor: (user, session, keys) => pushTo(user, session, keys),
    };
}
