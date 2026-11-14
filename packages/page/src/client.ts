import { createSignal, untrack } from 'solid-js';
import type { Accessor, Signal } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import type { ActionAnswer, ChatOwner, ViewFrame, ViewPush } from '@st/protocol';
import { isLooks } from './looks.ts';
import type { LookSheet } from './looks.ts';

export type ActionResult = { ok: true; answer?: unknown } | { ok: false; error: string; answer?: unknown };

export type Client = {
    send(type: string, payload: unknown, file?: File): Promise<ActionResult>;
    view<T>(key: string): Accessor<T | undefined>;
    receive(push: ViewPush): void;
    reconnected: (chat: ChatOwner | null) => Promise<void>;
    reread: (key: string) => Promise<void>;
    version: (key: string) => number;
};

export type ClientOptions = {
    headers: () => Record<string, string>;
    looks?: LookSheet;
};

const ENDPOINT = '/api/ui/action';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function merged(held: unknown, change: unknown): unknown {
    if (!isRecord(held) || !isRecord(change)) return change;
    for (const [key, value] of Object.entries(change)) held[key] = merged(held[key], value);
    return held;
}

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

export function createClient({ headers, looks }: ClientOptions): Client {
    const views = new Map<
        string,
        { set: (value: unknown) => void; patch: (change: unknown) => void; get: Accessor<unknown> }
    >();
    const versions = new Map<string, Signal<number>>();
    const versionOf = (key: string): Signal<number> => {
        let found = versions.get(key);
        if (!found) {
            found = createSignal(0);
            versions.set(key, found);
        }
        return found;
    };

    const entry = (key: string) => {
        let found = views.get(key);
        if (!found) {
            const [store, setStore] = createStore<{ value: unknown }>({ value: undefined });
            found = {
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
            const [version, setVersion] = versionOf(frame.key);
            if (frame.version <= untrack(version)) continue;
            if ('patch' in frame) target.patch(frame.patch);
            else target.set(frame.value);
            setVersion(frame.version);
            const carried = 'patch' in frame ? frame.patch : frame.value;
            const drawn = isRecord(carried) ? carried['looks'] : undefined;
            if (looks && isLooks(drawn)) {
                if ('patch' in frame) looks.add(frame.key, drawn);
                else looks.hold(frame.key, drawn);
            }
        }
    };

    const post = async (type: string, payload: unknown, file?: File): Promise<ActionAnswer> => {
        try {
            const answer = (await request(type, payload, file, apply)) as {
                ok?: unknown;
                error?: unknown;
                views?: ViewFrame[];
                answer?: unknown;
            } | null;
            const views = Array.isArray(answer?.views) ? answer.views : [];
            if (answer?.ok === true)
                return { ok: true, views, ...(answer.answer === undefined ? {} : { answer: answer.answer }) };
            return {
                ok: false,
                error: typeof answer?.error === 'string' ? answer.error : 'Request refused.',
                views,
                ...(answer?.answer === undefined ? {} : { answer: answer.answer }),
            };
        } catch {
            return { ok: false, error: "The server can't be reached.", views: [] };
        }
    };

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
            delete head['Content-Type'];
        } else {
            body = JSON.stringify({ type, payload });
            head['Content-Type'] = 'application/json';
        }
        const response = await fetch(ENDPOINT, { method: 'POST', headers: head, body });
        const refused = { ok: false, error: `Server error (${response.status}).` };
        if (!(response.headers.get('Content-Type') ?? '').includes('ndjson') || !response.body) {
            return response.json().catch(() => refused);
        }
        const lines = readLines(response.body);
        const first = await lines.next();
        if (first.done === true) return refused;
        const answer = JSON.parse(first.value) as unknown;
        if (isRecord(answer) && Array.isArray(answer['views'])) later(answer['views'] as ViewFrame[]);
        void (async () => {
            for await (const line of { [Symbol.asyncIterator]: () => lines }) {
                const part = JSON.parse(line) as { views?: ViewFrame[] };
                if (Array.isArray(part.views)) later(part.views);
            }
        })().catch(() => {
            // The answer was cut off: the views keep what came; the stream's next push or a reread brings the rest.
        });
        return answer;
    };

    const open = async (key: string) => {
        apply((await post('view.open', { key })).views);
    };

    return {
        async send(type, payload, file) {
            const answer = await post(type, payload, file);
            apply(answer.views);
            if (answer.ok) return { ok: true, answer: answer.answer };
            return {
                ok: false,
                error: answer.error,
                ...(answer.answer === undefined ? {} : { answer: answer.answer }),
            };
        },
        view<T>(key: string) {
            const known = views.has(key);
            const target = entry(key);
            if (!known) void open(key);
            return target.get as Accessor<T | undefined>;
        },
        receive(push) {
            apply(Array.isArray(push.views) ? push.views : []);
        },
        async reconnected(chat) {
            for (const [, setVersion] of versions.values()) setVersion(0);
            apply((await post(chat ? 'chat.show' : 'chat.close', chat ?? {})).views);
            await Promise.all([...views.keys()].map((key) => open(key)));
        },
        reread: (key) => open(key),
        version: (key) => versionOf(key)[0](),
    };
}
