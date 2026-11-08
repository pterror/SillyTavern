import fs from 'node:fs/promises';
import express from 'express';
import type { Request, Response, Router } from 'express';
import * as v from 'valibot';
import { viewActions } from '@st/protocol';
import type { ActionAnswer, ActionSchemas, ChatOwner, ViewFrame, ViewPush } from '@st/protocol';

export type User = { handle: string; directories: { root: string } & Record<string, string> };

export type ChatRef = { tree: string };

export type ViewContext = { user: User; session: string; chat: ChatRef | null };

export type Upload = { path: string; name: string; type: string; size: number };

export type ActionContext = ViewContext & { upload: Upload | null };

export type ActionResult = { changed: string[]; opens?: string[] } | { refused: string; changed?: string[] };

type Handlers<S extends ActionSchemas> = {
    [T in keyof S]: (context: ActionContext, payload: v.InferOutput<S[T]>) => Promise<ActionResult>;
};

export type ViewReader = (context: ViewContext) => Promise<unknown> | AsyncIterable<unknown>;

export type Area = {
    schemas: ActionSchemas;
    views: Record<string, ViewReader>;
    actions: Record<string, (context: ActionContext, payload: unknown) => Promise<ActionResult>>;
    followChat: string[];
    gone: (session: string) => void;
};

export function defineArea<S extends ActionSchemas>(area: {
    schemas: S;
    views: Area['views'];
    actions: Handlers<S>;
    followChat?: string[];
    gone?: (session: string) => void;
}): Area {
    return {
        schemas: area.schemas,
        views: area.views,
        actions: area.actions as Area['actions'],
        followChat: area.followChat ?? [],
        gone: area.gone ?? (() => {}),
    };
}

type Tab = {
    user: User;
    session: string;
    chat: ChatRef | null;
    open: Set<string>;
    streams: Set<(push: ViewPush) => void>;
};

type MulterFile = { path: string; originalname: string; mimetype: string; size: number };

const SESSION_HEADER = 'X-ST-Session';
const PARTS = 1_000_000;

class Patch {
    readonly value: unknown;
    constructor(value: unknown) {
        this.value = value;
    }
}

export const patch = (value: unknown): unknown => new Patch(value);

export const patchOf = (part: unknown): { value: unknown } | null => (part instanceof Patch ? part : null);

const isParts = (value: unknown): value is AsyncIterable<unknown> =>
    typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type UiOptions = {
    userOf: (request: Request) => User | null;
    chatOf: (user: User, owner: ChatOwner) => Promise<ChatRef | null>;
};

export type Ui = {
    router: Router;
    attach(user: User, session: string, push: (push: ViewPush) => void): () => void;
    showChat(user: User, session: string, chat: ChatRef | null): Promise<ViewFrame[]>;
    chatMoved(user: User, session: string): Promise<void>;
    changed(user: User, keys: string[]): Promise<void>;
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

    type Read = { frames: ViewFrame[]; later: AsyncIterable<ViewFrame>[] };

    const frame = async (tab: Tab, key: string): Promise<Read> => {
        const read = views.get(key);
        if (!read) throw new Error(`No view ${key}`);
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

    const push = (tab: Tab, { frames, later }: Read) => {
        if (frames.length > 0) for (const stream of tab.streams) stream({ type: 'views', views: frames });
        for (const parts of later) {
            void (async () => {
                for await (const part of parts) {
                    if (tab.streams.size === 0) break;
                    for (const stream of tab.streams) stream({ type: 'views', views: [part] });
                }
            })().catch((error: unknown) => console.error("[ui] a view's later part not read:", error));
        }
    };

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
        const answer = async (result: ActionAnswer, status = 200, later: AsyncIterable<ViewFrame>[] = []) => {
            if (later.length === 0) {
                response.status(status).send(result);
                return;
            }
            response.status(status).type('application/x-ndjson');
            response.write(`${JSON.stringify(result)}\n`);
            await Promise.all(
                later.map(async (parts) => {
                    try {
                        for await (const part of parts) {
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
            const opens = 'opens' in result ? (result.opens ?? []) : [];
            for (const key of opens) {
                if (!views.has(key)) throw new Error(`The action ${type} opens no view ${key}`);
                tab.open.add(key);
            }
            const changed = await spread(user, [...(result.changed ?? []), ...opens], tab);
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
            let views: ViewFrame[] = [];
            if (tab && mayHaveChanged.length > 0) {
                try {
                    views = (await spread(tab.user, mayHaveChanged, tab)).frames;
                } catch (again) {
                    console.error(`[ui] after ${type} failed, its views couldn't be read:`, again);
                }
            }
            if (!response.headersSent) await answer({ ok: false, error: 'internal', views }, 500);
            return;
        } finally {
            if (upload) await fs.rm(upload.path, { force: true });
        }
    };
    const router = express.Router();
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
                if (tab.streams.size === 0 && tabs.get(session) === tab) {
                    tabs.delete(session);
                    for (const area of areas) area.gone(session);
                }
            };
        },
        async showChat(user, session, chat) {
            const tab = tabOf(user, session);
            if (tab.chat?.tree === chat?.tree) return [];
            tab.chat = chat;
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
