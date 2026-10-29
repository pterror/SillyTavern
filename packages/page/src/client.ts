import type { Accessor } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import type { ActionAnswer, ChatOwner, ViewFrame, ViewPush } from '@st/protocol';

// The one place the page talks to the server (packages/README.md): it sends actions and keeps, for each view this
// tab shows, the newest the server sent, whether in an answer or a push. Nothing else here is state.
// A new value is merged into the one shown (Solid's reconcile): list items are matched by their `id`, so an item
// that's still there keeps its place on the page and only what changed in it is redrawn.

export type ActionResult = { ok: true } | { ok: false; error: string };

export type Client = {
    /** What an action did. A refusal's reason is for the user; the views it changed are applied either way. */
    send(type: string, payload: unknown, file?: File): Promise<ActionResult>;
    /** The view under `key`, opened on the server the first time it's asked for (undefined until it arrives). */
    view<T>(key: string): Accessor<T | undefined>;
    /** A push from the server (the old page's stream hands them over). */
    receive(push: ViewPush): void;
    /**
     * The tab's stream (re)connected: the server may not know what this tab shows (it restarted, or the tab has a new
     * session), so the tab says its chat and opens every view again, and the answers bring them up to date.
     */
    reconnected: (chat: ChatOwner | null) => Promise<void>;
    /** Reads a view again (for an extension that changed it through an old route). */
    reread: (key: string) => Promise<void>;
    /** The version of the view held now (0: none yet): what a copy kept elsewhere is of. */
    version: (key: string) => number;
};

export type ClientOptions = {
    /** The headers every request needs (the session and the CSRF token): the old page knows them. */
    headers: () => Record<string, string>;
};

const ENDPOINT = '/api/ui/action';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** A patch applied: objects merged key by key (in place, so what didn't change keeps its place), anything else replaced. */
function merged(held: unknown, change: unknown): unknown {
    if (!isRecord(held) || !isRecord(change)) return change;
    for (const [key, value] of Object.entries(change)) held[key] = merged(held[key], value);
    return held;
}

/** A body's lines, as they arrive. */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let rest = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        let end = rest.indexOf('\n');
        while (end >= 0) {
            const line = rest.slice(0, end);
            rest = rest.slice(end + 1);
            if (line.trim() !== '') yield line;
            end = rest.indexOf('\n');
        }
    }
    if (rest.trim() !== '') yield rest;
}

export function createClient({ headers }: ClientOptions): Client {
    const views = new Map<
        string,
        { version: number; set: (value: unknown) => void; patch: (change: unknown) => void; get: Accessor<unknown> }
    >();

    const entry = (key: string) => {
        let found = views.get(key);
        if (!found) {
            const [store, setStore] = createStore<{ value: unknown }>({ value: undefined });
            found = {
                version: 0,
                get: () => store.value,
                set: (value) => setStore('value', reconcile(value, { key: 'id', merge: true })),
                patch: (change) =>
                    setStore(
                        produce((held) => {
                            held.value = merged(held.value, change);
                        }),
                    ),
            };
            views.set(key, found);
        }
        return found;
    };

    const apply = (frames: ViewFrame[]) => {
        for (const frame of frames) {
            const target = entry(frame.key);
            // An answer and a push can cross: the newer wins whichever arrives last.
            if (frame.version <= target.version) continue;
            target.version = frame.version;
            if ('patch' in frame) target.patch(frame.patch);
            else target.set(frame.value);
        }
    };

    /** An answer, whatever came back: a network failure or a body that isn't one is a refusal with no views. */
    const post = async (type: string, payload: unknown, file?: File): Promise<ActionAnswer> => {
        try {
            const answer = (await request(type, payload, file, apply)) as {
                ok?: unknown;
                error?: unknown;
                views?: ViewFrame[];
            } | null;
            const views = Array.isArray(answer?.views) ? answer.views : [];
            if (answer?.ok === true) return { ok: true, views };
            return {
                ok: false,
                error: typeof answer?.error === 'string' ? answer.error : 'The server refused it.',
                views,
            };
        } catch {
            return { ok: false, error: "The server can't be reached.", views: [] };
        }
    };

    /**
     * The answer's body. An answer in parts (NDJSON: views read in parts) is the first line; each later line's views go
     * to `later` as they arrive.
     */
    const request = async (
        type: string,
        payload: unknown,
        file: File | undefined,
        later: (frames: ViewFrame[]) => void,
    ): Promise<unknown> => {
        let body: BodyInit;
        const head = { ...headers() };
        if (file) {
            const form = new FormData();
            form.set('type', type);
            form.set('payload', JSON.stringify(payload));
            form.set('avatar', file);
            body = form;
            // The browser sets the multipart boundary.
            delete head['Content-Type'];
        } else {
            body = JSON.stringify({ type, payload });
            head['Content-Type'] = 'application/json';
        }
        const response = await fetch(ENDPOINT, { method: 'POST', headers: head, body });
        const refused = { ok: false, error: `The server answered ${response.status}.` };
        if (!(response.headers.get('Content-Type') ?? '').includes('ndjson') || !response.body) {
            return response.json().catch(() => refused);
        }
        const lines = readLines(response.body);
        const first = await lines.next();
        void (async () => {
            for await (const line of { [Symbol.asyncIterator]: () => lines }) {
                const part = JSON.parse(line) as { views?: ViewFrame[] };
                if (Array.isArray(part.views)) later(part.views);
            }
        })().catch(() => {
            // The answer was cut off: the views keep what came; the stream's next push or a reread brings the rest.
        });
        return first.done === true ? refused : (JSON.parse(first.value) as unknown);
    };

    const open = async (key: string) => {
        apply((await post('view.open', { key })).views);
    };

    return {
        async send(type, payload, file) {
            const answer = await post(type, payload, file);
            apply(answer.views);
            return answer.ok ? { ok: true } : { ok: false, error: answer.error };
        },
        view<T>(key: string) {
            const known = views.has(key);
            const target = entry(key);
            // A view that doesn't come now comes when the stream (re)connects: reconnected() opens it again.
            if (!known) void open(key);
            return target.get as Accessor<T | undefined>;
        },
        receive(push) {
            apply(Array.isArray(push.views) ? push.views : []);
        },
        async reconnected(chat) {
            // The server's versions may have started over (a restart): what it sends now is the newest there is.
            for (const target of views.values()) target.version = 0;
            apply((await post(chat ? 'chat.show' : 'chat.close', chat ?? {})).views);
            await Promise.all([...views.keys()].map((key) => open(key)));
        },
        reread: (key) => open(key),
        version: (key) => views.get(key)?.version ?? 0,
    };
}
