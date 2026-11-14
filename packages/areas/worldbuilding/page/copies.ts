import type { EntryVersion } from '../protocol.ts';

// An entry's text as the browser keeps it until the server has it: written before each save and while a conflict over
// it is open, with the version it was written against, so a copy is a save that can be sent again. Each tab writes
// only its own copies, under the tab's token; a tab that is gone never confirms its copies, so whichever tab opens the
// entry next carries every copy of it there is.

export type TextField = 'text' | 'title';
export type CopyOf = { book: string; entry: string; field: TextField };
export type Copy = { text: string; version: EntryVersion };
export type KeptCopy = CopyOf & Copy & { key: string };

const PREFIX = 'WbEntryCopy:';
const TAB = 'WbEntryCopyTab';

const local = (): Storage | null => {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
};

const read = (key: string): string | null => {
    try {
        return local()?.getItem(key) ?? null;
    } catch {
        return null;
    }
};

const write = (key: string, value: string): void => {
    try {
        local()?.setItem(key, value);
    } catch {
        // Not kept: the page still holds the text.
    }
};

const remove = (key: string): void => {
    try {
        local()?.removeItem(key);
    } catch {
        // Nothing to remove.
    }
};

// A token kept in sessionStorage, so it outlives a reload; a duplicated tab copies it, which only shares copies both
// would carry anyway.
function tabToken(): string {
    try {
        const kept = window.sessionStorage.getItem(TAB);
        if (kept !== null) return kept;
        const made = crypto.randomUUID();
        window.sessionStorage.setItem(TAB, made);
        return made;
    } catch {
        return 'tab';
    }
}

const keyOf = ({ book, entry, field }: CopyOf, owner: string) => PREFIX + JSON.stringify([book, entry, field, owner]);

const parsed = (key: string): KeptCopy | null => {
    try {
        const [book, entry, field] = JSON.parse(key.slice(PREFIX.length)) as unknown[];
        const copy = JSON.parse(read(key) ?? 'null') as Partial<Copy> | null;
        if (typeof book !== 'string' || typeof entry !== 'string' || (field !== 'text' && field !== 'title'))
            return null;
        if (!copy || typeof copy.text !== 'string' || typeof copy.version !== 'string') return null;
        return { book, entry, field, text: copy.text, version: copy.version, key };
    } catch {
        return null;
    }
};

export const copies = {
    keep(of: CopyOf, copy: Copy): void {
        write(keyOf(of, tabToken()), JSON.stringify(copy));
    },
    // The server has `text`: this tab's copy of just that is gone; one written since stays.
    confirm(of: CopyOf, text: string): void {
        const key = keyOf(of, tabToken());
        if (parsed(key)?.text === text) remove(key);
    },
    // Keeps this tab's copy apart from the one it writes next, to be carried as it is.
    setApart(of: CopyOf): void {
        const key = keyOf(of, tabToken());
        const kept = read(key);
        if (kept === null) return;
        write(keyOf(of, `${tabToken()}/${crypto.randomUUID()}`), kept);
        remove(key);
    },
    of(book: string, entry: string): KeptCopy[] {
        const storage = local();
        if (!storage) return [];
        const keys: string[] = [];
        try {
            for (let at = 0; at < storage.length; at++) {
                const key = storage.key(at);
                if (key?.startsWith(PREFIX) === true) keys.push(key);
            }
        } catch {
            return [];
        }
        return keys.flatMap((key) => {
            const copy = parsed(key);
            return copy && copy.book === book && copy.entry === entry ? [copy] : [];
        });
    },
    drop(copy: KeptCopy): void {
        remove(copy.key);
    },
};
