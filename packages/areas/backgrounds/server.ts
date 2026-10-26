import { actions, FITTINGS, SORT_ORDERS, COLUMNS, VIEW, CHAT_VIEW } from './protocol.ts';
import type { Background, BackgroundsView, ChatBackgroundsView, Fitting, Ref, SortOrder } from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { ActionContext, ActionResult, Upload, User, ViewContext } from '@st/server-ui';

// Backgrounds (packages/areas/backgrounds/protocol.ts), over what old server code stores: system backgrounds are files
// in the user's backgrounds folder with metadata beside them; the user's choice and options are the settings'
// `background`; a chat's backgrounds and lock are keys of its state, in upstream's form (`chat_backgrounds`, a list
// of image paths, and `custom_background`, a CSS `url("...")`).

export type SystemFile = {
    file: string;
    animated: boolean;
    color: string | null;
    aspect: number | null;
    /** When it was added (ms), for sorting by age; null when unknown. */
    added: number | null;
    folders: string[];
    /** The thumbnail route's version of its thumbnail, when one is made. */
    thumbnailVersion: string | null;
};

/** The settings' `background`, as upstream stores it. */
export type StoredOptions = {
    name?: string;
    url?: string;
    fitting?: string;
    animation?: boolean;
    sortOrder?: string;
    thumbnailColumns?: number;
};

/** What old server code does for this area. */
export type Ports = {
    files: {
        list(user: User): Promise<SystemFile[]>;
        folders(user: User): Promise<{ id: string; name: string; cover: string | null }[]>;
        /** Stores an upload as a system background; answers the file name it got. */
        save(user: User, upload: Upload): Promise<string>;
        /** Copies an image (a chat background's path) in as a system background named `name`. */
        copyIn(user: User, path: string, name: string): Promise<string>;
        /** false: no such file, or the new name is taken. */
        rename(user: User, file: string, to: string): Promise<boolean>;
        remove(user: User, file: string): Promise<void>;
        createFolder(user: User, name: string): Promise<void>;
        renameFolder(user: User, id: string, name: string): Promise<void>;
        deleteFolder(user: User, id: string): Promise<void>;
        setCover(user: User, id: string, file: string): Promise<void>;
        addToFolder(user: User, id: string, files: string[]): Promise<void>;
        removeFromFolder(user: User, id: string, files: string[]): Promise<void>;
        setFolders(user: User, file: string, ids: string[]): Promise<void>;
    };
    /** The open chat's state keys; null: the tab has no chat open. */
    chat: {
        read(context: ViewContext): Promise<{ list: string[]; locked: string | null } | null>;
        write(context: ViewContext, change: { list?: string[]; locked?: string | null }): Promise<void>;
        /** Stores an upload as one of the chat's images; answers its path. */
        saveImage(context: ViewContext, upload: Upload): Promise<string>;
        deleteImage(context: ViewContext, path: string): Promise<void>;
    };
    options: {
        read(user: User): Promise<StoredOptions>;
        write(user: User, options: StoredOptions): Promise<void>;
    };
};

const ANIMATED = /\.(mp4|webp|gif|apng)$/i;
const DEFAULT_FILE = '__transparent.png';

/** The user's stored background, or the default where there's none (an empty name is none). */
const fileOrDefault = (name: string | undefined) => (name === undefined || name === '' ? DEFAULT_FILE : name);

/** Whether a chat has a background locked to it (an empty lock is none). */
const isLocked = (chat: { locked: string | null } | null) =>
    chat !== null && chat.locked !== null && chat.locked !== '';

const systemUrl = (file: string) => `backgrounds/${encodeURIComponent(file)}`;
const chatUrl = (path: string) => encodeURI(path);
const css = (url: string) => `url("${url}")`;
const titleOf = (file: string) => {
    const name = file.split('/').pop() ?? file;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
};

/** A URL's escapes undone, or the text as it is when they aren't valid ones (an upstream lock written by hand). */
const decoded = (text: string, decode: (text: string) => string) => {
    try {
        return decode(text);
    } catch {
        return text;
    }
};

/** Upstream's stored CSS url back to what it names. */
export function refOfCss(value: string | null | undefined): Ref | null {
    const url = /^url\(["']?(.*?)["']?\)$/.exec(value ?? '')?.[1];
    if (url === undefined || url === '') return null;
    const system = /^\/?backgrounds\/(.+)$/.exec(url)?.[1];
    if (system !== undefined) return { file: decoded(system, decodeURIComponent), chat: false };
    return { file: decoded(url, decodeURI), chat: true };
}

const cssOfRef = (ref: Ref) => css(ref.chat ? chatUrl(ref.file) : systemUrl(ref.file));

function sortBy<T>(items: T[], order: SortOrder, title: (item: T) => string, age: (item: T, index: number) => number) {
    const rows = items.map((item, index) => ({ item, title: title(item), age: age(item, index) }));
    type Row = (typeof rows)[number];
    const byTitle = (a: Row, b: Row) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    const byAge = (a: Row, b: Row) => a.age - b.age;
    const compare =
        order === 'az'
            ? byTitle
            : order === 'za'
              ? (a: Row, b: Row) => byTitle(b, a)
              : order === 'oldest'
                ? byAge
                : (a: Row, b: Row) => byAge(b, a);
    return rows.sort(compare).map((row) => row.item);
}

function optionsOf(stored: StoredOptions): BackgroundsView['options'] {
    return {
        fitting: (FITTINGS as readonly string[]).includes(stored.fitting ?? '')
            ? (stored.fitting as Fitting)
            : 'classic',
        animation: stored.animation === true,
        sortOrder: (SORT_ORDERS as readonly string[]).includes(stored.sortOrder ?? '')
            ? (stored.sortOrder as SortOrder)
            : 'az',
        columns:
            typeof stored.thumbnailColumns === 'number' && Number.isFinite(stored.thumbnailColumns)
                ? Math.min(COLUMNS.max, Math.max(COLUMNS.min, Math.round(stored.thumbnailColumns)))
                : null,
    };
}

export function backgroundsArea(ports: Ports) {
    const read = async (context: ViewContext): Promise<BackgroundsView> => {
        const [files, folders, stored] = await Promise.all([
            ports.files.list(context.user),
            ports.files.folders(context.user),
            ports.options.read(context.user),
        ]);
        const options = optionsOf(stored);
        const system: Background[] = sortBy(
            files,
            options.sortOrder,
            (f) => f.file,
            (f) => f.added ?? 0,
        ).map((f) => ({
            id: f.file,
            file: f.file,
            title: titleOf(f.file),
            url: systemUrl(f.file),
            thumbnail: `/thumbnail?type=bg&file=${encodeURIComponent(f.file)}${f.thumbnailVersion !== null && f.thumbnailVersion !== '' ? `&v=${encodeURIComponent(f.thumbnailVersion)}` : ''}${f.animated && options.animation ? '&animated=true' : ''}`,
            animated: f.animated,
            color: f.color,
            aspect: f.aspect,
            folders: f.folders,
        }));
        return {
            system,
            folders: folders.map((f) => {
                const cover = f.cover ?? files.find((x) => x.folders.includes(f.id))?.file;
                return {
                    id: f.id,
                    name: f.name,
                    cover: cover !== undefined ? `/thumbnail?type=bg&file=${encodeURIComponent(cover)}` : null,
                };
            }),
            selected: { file: fileOrDefault(stored.name), chat: false },
            options,
        };
    };

    // What depends on the open chat, kept apart from the system's list so a change of chat (or of its state) reads
    // only the chat's state and the user's options, never the backgrounds folder.
    const readChat = async (context: ViewContext): Promise<ChatBackgroundsView> => {
        const [stored, chat] = await Promise.all([ports.options.read(context.user), ports.chat.read(context)]);
        const { sortOrder } = optionsOf(stored);
        const locked = chat ? refOfCss(chat.locked) : null;
        const shown = locked ?? { file: fileOrDefault(stored.name), chat: false };
        return {
            chat: chat
                ? {
                      backgrounds: sortBy(
                          chat.list,
                          sortOrder,
                          (path) => titleOf(path),
                          // A chat lists its backgrounds in the order they were added.
                          (_path, index) => index,
                      ).map((path) => ({
                          id: path,
                          file: path,
                          title: titleOf(path),
                          url: chatUrl(path),
                          thumbnail: chatUrl(path),
                          animated: ANIMATED.test(path),
                          color: null,
                          aspect: null,
                          folders: [],
                      })),
                      locked,
                  }
                : null,
            shown: { url: shown.chat ? chatUrl(shown.file) : systemUrl(shown.file) },
        };
    };

    const changed: ActionResult = { changed: [VIEW, CHAT_VIEW] };
    const noChat: ActionResult = { refused: "Open a chat first: this is the chat's." };

    const setUsers = async (user: User, file: string) => {
        const stored = await ports.options.read(user);
        await ports.options.write(user, { ...stored, name: file, url: css(systemUrl(file)) });
    };

    const lock = async (context: ActionContext, ref: Ref | null) => {
        const chat = await ports.chat.read(context);
        if (!chat) return noChat;
        const target = ref ?? { file: fileOrDefault((await ports.options.read(context.user)).name), chat: false };
        await ports.chat.write(context, { locked: cssOfRef(target) });
        return changed;
    };

    return defineArea({
        schemas: actions,
        views: { [VIEW]: read, [CHAT_VIEW]: readChat },
        followChat: [CHAT_VIEW],
        actions: {
            'backgrounds.select': async (context, { file, chat: isChat, forUser }) => {
                const chat = await ports.chat.read(context);
                if (isChat || (isLocked(chat) && !forUser)) return lock(context, { file, chat: isChat });
                await setUsers(context.user, file);
                return changed;
            },
            'backgrounds.lock': async (context, { background }) => lock(context, background),
            'backgrounds.unlock': async (context) => {
                if (!(await ports.chat.read(context))) return noChat;
                await ports.chat.write(context, { locked: null });
                return changed;
            },
            'backgrounds.upload': async (context, { chat: toChat }) => {
                if (!context.upload) return { refused: 'No file came with the upload.' };
                if (!context.upload.type.startsWith('image/')) return { refused: 'A background is an image.' };
                if (!toChat) {
                    const file = await ports.files.save(context.user, context.upload);
                    await setUsers(context.user, file);
                    return changed;
                }
                const chat = await ports.chat.read(context);
                if (!chat) return noChat;
                const path = await ports.chat.saveImage(context, context.upload);
                await ports.chat.write(context, { list: [...chat.list, path] });
                return changed;
            },
            'backgrounds.rename': async (context, { file, name }) => {
                const extension = /\.[^./]+$/.exec(file)?.[0] ?? '';
                const to = `${name}${extension}`;
                if (to === file) return changed;
                if (!(await ports.files.rename(context.user, file, to)))
                    return { refused: `Can't rename it to ${to}: that name is taken, or the file is gone.` };
                const stored = await ports.options.read(context.user);
                if (stored.name === file) await setUsers(context.user, to);
                const chat = await ports.chat.read(context);
                const locked = refOfCss(chat?.locked);
                if (locked && !locked.chat && locked.file === file)
                    await ports.chat.write(context, { locked: cssOfRef({ file: to, chat: false }) });
                return changed;
            },
            'backgrounds.delete': async (context, { file, chat: isChat, deleteFile }) => {
                const chat = await ports.chat.read(context);
                const locked = refOfCss(chat?.locked);
                const wasLocked = locked !== null && locked.file === file && locked.chat === isChat;
                if (isChat) {
                    if (!chat) return noChat;
                    await ports.chat.write(context, {
                        list: chat.list.filter((path) => path !== file),
                        ...(wasLocked ? { locked: null } : {}),
                    });
                    if (deleteFile) await ports.chat.deleteImage(context, file);
                    return changed;
                }
                const before = (await read(context)).system.map((b) => b.file);
                await ports.files.remove(context.user, file);
                if (wasLocked) await ports.chat.write(context, { locked: null });
                const stored = await ports.options.read(context.user);
                if (stored.name === file) {
                    // The one after it in the list takes its place, else the one before.
                    const at = before.indexOf(file);
                    const next = before[at + 1] ?? before[at - 1];
                    await setUsers(context.user, next ?? DEFAULT_FILE);
                }
                return changed;
            },
            'backgrounds.copyToSystem': async (context, { file, name }) => {
                const chat = await ports.chat.read(context);
                if (!chat) return noChat;
                const extension = /\.[^./]+$/.exec(file)?.[0] ?? '';
                await ports.files.copyIn(context.user, file, `${name}${extension}`);
                await ports.chat.write(context, { list: chat.list.filter((path) => path !== file) });
                return changed;
            },
            'backgrounds.addToChat': async (context, { file }) => {
                const chat = await ports.chat.read(context);
                if (!chat) return noChat;
                await ports.chat.write(context, {
                    list: chat.list.includes(file) ? chat.list : [...chat.list, file],
                    locked: cssOfRef({ file, chat: true }),
                });
                return changed;
            },
            'backgrounds.pickByTitle': async (context, { reply }) => {
                const files = await ports.files.list(context.user);
                const match = bestTitle(
                    files.map((f) => f.file),
                    reply,
                );
                if (match === null) return { refused: 'No background matches that.' };
                // As picking it by hand would: the open chat's lock, when it has one, else the user's.
                if (isLocked(await ports.chat.read(context))) return lock(context, { file: match, chat: false });
                await setUsers(context.user, match);
                return changed;
            },
            'backgrounds.options': async (context, change) => {
                const stored = await ports.options.read(context.user);
                await ports.options.write(context.user, {
                    ...stored,
                    ...(change.fitting === undefined ? {} : { fitting: change.fitting }),
                    ...(change.animation === undefined ? {} : { animation: change.animation }),
                    ...(change.sortOrder === undefined ? {} : { sortOrder: change.sortOrder }),
                    ...(change.columns === undefined ? {} : { thumbnailColumns: change.columns }),
                });
                return changed;
            },
            'backgrounds.folders.create': async (context, { name }) => {
                await ports.files.createFolder(context.user, name);
                return changed;
            },
            'backgrounds.folders.rename': async (context, { id, name }) => {
                await ports.files.renameFolder(context.user, id, name);
                return changed;
            },
            'backgrounds.folders.delete': async (context, { id }) => {
                await ports.files.deleteFolder(context.user, id);
                return changed;
            },
            'backgrounds.folders.cover': async (context, { id, file }) => {
                await ports.files.setCover(context.user, id, file);
                return changed;
            },
            'backgrounds.folders.add': async (context, { files, folders }) => {
                for (const id of folders) await ports.files.addToFolder(context.user, id, files);
                return changed;
            },
            'backgrounds.folders.remove': async (context, { files, folder }) => {
                await ports.files.removeFromFolder(context.user, folder, files);
                return changed;
            },
            'backgrounds.folders.set': async (context, { file, folders }) => {
                await ports.files.setFolders(context.user, file, folders);
                return changed;
            },
        },
    });
}

/**
 * The file whose title the reply names: the title the reply contains, longest first (so "Forest at night" wins
 * over "Forest"), else the title sharing the most words with it.
 */
export function bestTitle(files: string[], reply: string): string | null {
    const said = reply.toLowerCase();
    const titled = files
        .map((file) => ({ file, title: titleOf(file).toLowerCase() }))
        .filter((t) => t.title.length > 0);
    const contained = titled.filter((t) => said.includes(t.title)).sort((a, b) => b.title.length - a.title.length)[0];
    if (contained) return contained.file;
    const words = new Set(said.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    let best: { file: string; shared: number } | null = null;
    for (const t of titled) {
        const shared = t.title.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '' && words.has(w)).length;
        if (shared > 0 && (!best || shared > best.shared)) best = { file: t.file, shared };
    }
    return best?.file ?? null;
}
