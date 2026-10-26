import * as v from 'valibot';
import type { ActionSchemas } from './index.ts';

// Backgrounds: the system's (files in the user's backgrounds folder, grouped into folders) and a chat's own (images
// the chat lists in its state). The user has a selected background; a chat can lock one of either kind, which then
// shows instead while that chat is open.

/** The system's backgrounds, the folders, the user's choice and options. */
export const VIEW = 'backgrounds';
/** The open chat's backgrounds and lock, and what shows behind the chat: read again whenever the chat changes. */
export const CHAT_VIEW = 'backgrounds.chat';

export const FITTINGS = ['classic', 'cover', 'contain', 'stretch', 'center'] as const;
export const SORT_ORDERS = ['az', 'za', 'newest', 'oldest'] as const;
export const COLUMNS = { min: 2, max: 8 } as const;

export type Fitting = (typeof FITTINGS)[number];
export type SortOrder = (typeof SORT_ORDERS)[number];

/** A background as the view lists it. */
export type Background = {
    /** Which it is, for the page to keep it in place as the list changes (its `file`). */
    id: string;
    /** What actions name it by: a system background's file name, or a chat background's path. */
    file: string;
    /** Its name without the extension, as shown. */
    title: string;
    /** The image itself (a URL the page can load). */
    url: string;
    /** A small version to show in the list; the image itself when there is none. */
    thumbnail: string;
    /** Animated formats (gif, animated webp, apng, mp4) show their first frame unless animation is on. */
    animated: boolean;
    /** For the list to hold its place before the thumbnail loads. */
    color: string | null;
    aspect: number | null;
    /** System backgrounds only: the folders it's in. */
    folders: string[];
};

export type Folder = { id: string; name: string; cover: string | null };

/** What a background is, wherever it's named: the system's or the chat's. */
export type Ref = { file: string; chat: boolean };

export type BackgroundsView = {
    /** Sorted by `options.sortOrder`. */
    system: Background[];
    folders: Folder[];
    /** The user's background. */
    selected: Ref;
    /** `columns`: how many thumbnails a row has, when the user chose (null: the layout's own, by screen width). */
    options: { fitting: Fitting; animation: boolean; sortOrder: SortOrder; columns: number | null };
};

export type ChatBackgroundsView = {
    /** The open chat's backgrounds (sorted as the system's) and lock; null when no chat is open. */
    chat: { backgrounds: Background[]; locked: Ref | null } | null;
    /** What shows behind the chat now: the chat's lock, else the user's. */
    shown: { url: string };
};

const ref = v.object({ file: v.pipe(v.string(), v.minLength(1)), chat: v.boolean() });
const name = v.pipe(v.string(), v.trim(), v.minLength(1));

export const actions = {
    /**
     * Picks a background: a chat's own, or any while the open chat has a lock, becomes the chat's lock; otherwise
     * (or with `forUser`, a system background) it becomes the user's.
     */
    'backgrounds.select': v.object({ ...ref.entries, forUser: v.boolean() }),
    /** Locks the open chat to a background (none named: the user's). */
    'backgrounds.lock': v.object({ background: v.nullable(ref) }),
    'backgrounds.unlock': v.object({}),
    /** Takes the uploaded file as a system background, or as one of the open chat's. */
    'backgrounds.upload': v.object({ chat: v.boolean() }),
    /** Renames a system background (the extension stays). */
    'backgrounds.rename': v.object({ file: v.pipe(v.string(), v.minLength(1)), name }),
    /** Removes a background: a system one's file, or a chat one from the chat's list (and its file, with `file`). */
    'backgrounds.delete': v.object({ ...ref.entries, deleteFile: v.boolean() }),
    /** Copies one of the chat's backgrounds into the system's, under `name`, and takes it off the chat's list. */
    'backgrounds.copyToSystem': v.object({ file: v.pipe(v.string(), v.minLength(1)), name }),
    /** An image made elsewhere (image generation's "set as background"): added to the chat's list and locked. */
    'backgrounds.addToChat': v.object({ file: v.pipe(v.string(), v.minLength(1)) }),
    /** Selects the system background whose title best matches `reply` (an LLM's choice of location). */
    'backgrounds.pickByTitle': v.object({ reply: v.string() }),
    'backgrounds.options': v.partial(
        v.object({
            fitting: v.picklist(FITTINGS),
            animation: v.boolean(),
            sortOrder: v.picklist(SORT_ORDERS),
            columns: v.pipe(v.number(), v.integer(), v.minValue(COLUMNS.min), v.maxValue(COLUMNS.max)),
        }),
    ),
    'backgrounds.folders.create': v.object({ name }),
    'backgrounds.folders.rename': v.object({ id: v.string(), name }),
    'backgrounds.folders.delete': v.object({ id: v.string() }),
    'backgrounds.folders.cover': v.object({ id: v.string(), file: v.string() }),
    /** Puts system backgrounds into, or takes them out of, folders. */
    'backgrounds.folders.add': v.object({ files: v.array(v.string()), folders: v.array(v.string()) }),
    'backgrounds.folders.remove': v.object({ files: v.array(v.string()), folder: v.string() }),
    /** Sets exactly which folders one background is in. */
    'backgrounds.folders.set': v.object({ file: v.string(), folders: v.array(v.string()) }),
} satisfies ActionSchemas;

/** The actions that carry a file: sent as multipart, the file under `avatar` (the server parses uploads by that name). */
export const fileActions: ReadonlySet<keyof typeof actions> = new Set(['backgrounds.upload']);
