import type { CountsView, ListView } from '../protocol.ts';

export type Seen = { key: string; version: number; list: ListView; counts: CountsView; used: number };

const DB = 'st-alternatives';
const STORE = 'seen';
const KEPT = 16;
const MOST_TEXT = 8_000_000;

function openDatabase(): Promise<IDBDatabase | null> {
    return new Promise<IDBDatabase | null>((resolve) => {
        try {
            const request = indexedDB.open(DB, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
            request.onsuccess = () => {
                resolve(request.result);
            };
            request.onerror = () => {
                resolve(null);
            };
            request.onblocked = () => {
                resolve(null);
            };
        } catch {
            resolve(null);
        }
    });
}

function done<T>(request: IDBRequest<T>): Promise<T | null> {
    return new Promise((resolve) => {
        request.onsuccess = () => {
            resolve(request.result);
        };
        request.onerror = () => {
            resolve(null);
        };
    });
}

export function createSeen() {
    const memory = new Map<string, Seen>();
    let opening: Promise<IDBDatabase | null> | null = null;
    const database = () => (opening ??= openDatabase());

    async function find(key: string): Promise<Seen | null> {
        const kept = memory.get(key);
        if (kept) return kept;
        try {
            const db = await database();
            if (!db) return null;
            const found = await done(db.transaction(STORE).objectStore(STORE).get(key) as IDBRequest<Seen | undefined>);
            if (!found) return null;
            memory.set(key, found);
            return found;
        } catch {
            return null;
        }
    }

    async function keep(seen: Seen): Promise<void> {
        const before = memory.get(seen.key);
        if (before && before.version > seen.version) return;
        memory.set(seen.key, seen);
        for (const key of [...memory.keys()].slice(0, Math.max(0, memory.size - KEPT))) memory.delete(key);
        if (seen.list.items.reduce((sum, item) => sum + item.text.length, 0) > MOST_TEXT) return;
        try {
            const db = await database();
            if (!db) return;
            const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
            const stored = await done(store.get(seen.key) as IDBRequest<Seen | undefined>);
            if (stored && stored.version > seen.version) return;
            const write = db.transaction(STORE, 'readwrite').objectStore(STORE);
            await done(write.put(seen));
            const all = (await done(write.getAll() as IDBRequest<Seen[]>)) ?? [];
            const old = all.sort((a, b) => b.used - a.used).slice(KEPT);
            for (const entry of old) write.delete(entry.key);
        } catch {
            // Not kept: the next open asks the server, as always.
        }
    }

    return { find, keep };
}
