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

export type Area = {
    schemas: ActionSchemas;
    views: Record<string, (context: ViewContext) => Promise<unknown>>;
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

    const frame = async (tab: Tab, key: string): Promise<ViewFrame> => {
        const read = views.get(key);
        if (!read) throw new Error(`No view ${key}`);
        // Numbered when the read starts: a read that began before another write can't come out newer than one
        // that began after it.
        const version = nextVersion();
        const value = await read({ user: tab.user, session: tab.session, chat: tab.chat });
        return { key, version, value };
    };

    /** The views among `keys` the tab shows, read for it. */
    const framesOf = async (tab: Tab, keys: Iterable<string>) => {
        const frames: ViewFrame[] = [];
        for (const key of new Set(keys)) if (tab.open.has(key)) frames.push(await frame(tab, key));
        return frames;
    };

    /** The changed views each tab of the user shows: answered to `actor` (returned), pushed to the others. */
    const spread = async (user: User, keys: string[], actor: Tab | null): Promise<ViewFrame[]> => {
        let answer: ViewFrame[] = [];
        for (const tab of tabs.values()) {
            if (tab.user.directories.root !== user.directories.root) continue;
            const frames = await framesOf(tab, keys);
            if (tab === actor) answer = frames;
            else if (frames.length > 0) for (const push of tab.streams) push({ type: 'views', views: frames });
        }
        if (actor && !tabs.has(actor.session)) answer = await framesOf(actor, keys);
        return answer;
    };

    const act = async (request: Request, response: Response) => {
        const answer = (result: ActionAnswer, status = 200) => void response.status(status).send(result);
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
                answer({ ok: false, error: 'no session', views: [] }, 400);
                return;
            }
            tab = tabOf(user, session);
            // Multipart (an action with a file) carries the payload as JSON text beside the file.
            let payload: unknown = body?.payload;
            if (typeof payload === 'string') {
                try {
                    payload = JSON.parse(payload);
                } catch {
                    answer({ ok: false, error: 'the payload is not JSON', views: [] }, 400);
                    return;
                }
            }
            if (type === 'chat.show' || type === 'chat.close') {
                const parsed = v.safeParse(viewActions[type], payload);
                if (!parsed.success) {
                    answer({ ok: false, error: 'not a chat', views: [] }, 400);
                    return;
                }
                tab.chat = type === 'chat.show' ? await chatOf(user, parsed.output as ChatOwner) : null;
                answer({ ok: true, views: await framesOf(tab, followChat) });
                return;
            }
            if (type === 'view.open' || type === 'view.close') {
                const parsed = v.safeParse(viewActions[type], payload);
                if (!parsed.success || !views.has(parsed.output.key)) {
                    answer({ ok: false, error: 'no such view', views: [] }, 400);
                    return;
                }
                if (type === 'view.close') {
                    tab.open.delete(parsed.output.key);
                    answer({ ok: true, views: [] });
                    return;
                }
                tab.open.add(parsed.output.key);
                answer({ ok: true, views: [await frame(tab, parsed.output.key)] });
                return;
            }
            const action = actions.get(type);
            if (!action) {
                answer({ ok: false, error: `no action ${type}`, views: [] }, 400);
                return;
            }
            const parsed = v.safeParse(action.schema, payload);
            if (!parsed.success) {
                const issue = parsed.issues.map((i) => `${v.getDotPath(i) ?? type}: ${i.message}`).join('; ');
                answer({ ok: false, error: issue, views: [] }, 400);
                return;
            }
            mayHaveChanged = action.views;
            const result = await action.run({ user, session, chat: tab.chat, upload }, parsed.output);
            const changed = await spread(user, result.changed ?? [], tab);
            answer(
                'refused' in result
                    ? { ok: false, error: result.refused, views: changed }
                    : { ok: true, views: changed },
            );
            return;
        } catch (error) {
            console.error(`[ui] ${type} failed:`, error);
            // It may have done part of what it does: the tab (and the user's others) get what's there now.
            let views: ViewFrame[] = [];
            if (tab && mayHaveChanged.length > 0) {
                try {
                    views = await spread(tab.user, mayHaveChanged, tab);
                } catch (again) {
                    console.error(`[ui] after ${type} failed, its views couldn't be read:`, again);
                }
            }
            answer({ ok: false, error: 'internal', views }, 500);
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
            return framesOf(tab, followChat);
        },
        async chatMoved(user, session) {
            const tab = tabs.get(session);
            if (!tab || tab.user.directories.root !== user.directories.root || !tab.chat) return;
            const frames = await framesOf(tab, followChat);
            if (frames.length > 0) for (const push of tab.streams) push({ type: 'views', views: frames });
        },
        async changed(user, keys) {
            await spread(user, keys, null);
        },
    };
}
