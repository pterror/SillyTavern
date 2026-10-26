import type { Accessor } from 'solid-js';
import { VIEW, CHAT_VIEW } from '../protocol.ts';
import type { BackgroundsView, ChatBackgroundsView, Fitting, SortOrder } from '../protocol.ts';
import type { Client } from '@st/page/client';
import { pickByModel } from './Backgrounds.tsx';
import type { BackgroundsTab } from './Backgrounds.tsx';

// Upstream's public/scripts/backgrounds.js names, over the view: extensions import them from that path (now a stub).

/** Upstream's `background_settings`, read from the view; a write is sent as the action it means. */
export type BackgroundSettings = {
    name: string;
    url: string;
    fitting: Fitting;
    animation: boolean;
    sortOrder: SortOrder;
    thumbnailColumns: number | undefined;
};

export function backgroundsCompat(
    client: Client,
    tab: Accessor<BackgroundsTab>,
    quietPrompt: (prompt: string) => Promise<string>,
    t: (text: string) => string,
) {
    const view = client.view<BackgroundsView>(VIEW);
    const chatView = client.view<ChatBackgroundsView>(CHAT_VIEW);
    const options = () => view()?.options;
    const settings = {} as BackgroundSettings;
    Object.defineProperties(settings, {
        name: {
            enumerable: true,
            get: () => view()?.selected.file ?? '__transparent.png',
            set: (file: string) => void client.send('backgrounds.select', { file, chat: false, forUser: true }),
        },
        url: {
            enumerable: true,
            get: () => `url("backgrounds/${encodeURIComponent(view()?.selected.file ?? '__transparent.png')}")`,
        },
        fitting: {
            enumerable: true,
            get: () => options()?.fitting ?? 'classic',
            set: (fitting: Fitting) => void client.send('backgrounds.options', { fitting }),
        },
        animation: {
            enumerable: true,
            get: () => options()?.animation ?? false,
            set: (animation: boolean) => void client.send('backgrounds.options', { animation }),
        },
        sortOrder: {
            enumerable: true,
            get: () => options()?.sortOrder ?? 'az',
            set: (sortOrder: SortOrder) => void client.send('backgrounds.options', { sortOrder }),
        },
        thumbnailColumns: {
            enumerable: true,
            get: () => options()?.columns ?? undefined,
            set: (columns: number) => void client.send('backgrounds.options', { columns }),
        },
    });

    return {
        background_settings: settings,
        /**
         * The server pushes the view when the new page changes backgrounds; an extension that changed them through
         * an old route (or the folder) asks here, and the view is read again.
         */
        getBackgrounds: () => client.reread(VIEW),
        /** The drawer is mounted when the new page starts. */
        initBackgrounds: () => {},
        /** The settings' background is the server's (it isn't loaded from the page's copy any more). */
        loadBackgroundSettings: (_settings: unknown) => {},
        getBackgroundPath: (fileUrl: string) => `backgrounds/${encodeURIComponent(fileUrl)}`,
        isCustomBackgroundUrl: (fileUrl: string) =>
            (chatView()?.chat?.backgrounds ?? []).some((b) => b.file === fileUrl || `url("${b.url}")` === fileUrl),
        /** 0: the system's tab, 1: the chat's (upstream's BG_SOURCES). */
        getActiveBackgroundTab: () => (tab() === 'chat' ? 1 : 0),
        /** Every background there is to pick: the system's, then the open chat's (/bg and its suggestions). */
        listBackgroundFiles: () => [
            ...(view()?.system ?? []).map((b) => ({ file: b.file, chat: false })),
            ...(chatView()?.chat?.backgrounds ?? []).map((b) => ({ file: b.file, chat: true })),
        ],
        /** Picks one as a click on it would (/bg); answers why nothing was picked, or null. */
        selectBackground: async (file: string, chat: boolean) => {
            const result = await client.send('backgrounds.select', { file, chat, forUser: false });
            return result.ok ? null : result.error;
        },
        /** /lockbg, /unlockbg and /autobg; each answers why it did nothing, or null. */
        lock: async () => {
            const result = await client.send('backgrounds.lock', { background: null });
            return result.ok ? null : result.error;
        },
        unlock: async () => {
            const result = await client.send('backgrounds.unlock', {});
            return result.ok ? null : result.error;
        },
        autoSelect: () => pickByModel(client, view, quietPrompt, t),
        /** Upstream's FORCE_SET_BACKGROUND (`{ url, path }`): an image added to the chat's backgrounds and locked. */
        forceSetBackground: (background: { path: string }) =>
            client.send('backgrounds.addToChat', { file: background.path }),
    };
}

export type BackgroundsCompat = ReturnType<typeof backgroundsCompat>;
