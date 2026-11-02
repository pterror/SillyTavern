import type { Accessor } from 'solid-js';
import { VIEW, CHAT_VIEW } from '../protocol.ts';
import type { BackgroundsView, ChatBackgroundsView, Fitting, SortOrder } from '../protocol.ts';
import type { Client } from '@st/page/client';
import { pickByModel } from './Backgrounds.tsx';
import type { BackgroundsTab } from './Backgrounds.tsx';

export type BackgroundSettings = {
    name: string;
    url: string;
    fitting: Fitting;
    animatedThumbnails: boolean;
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
        animatedThumbnails: {
            enumerable: true,
            get: () => options()?.animatedThumbnails ?? true,
            set: (animatedThumbnails: boolean) => void client.send('backgrounds.options', { animatedThumbnails }),
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
        getBackgrounds: () => client.reread(VIEW),
        initBackgrounds: () => {},
        loadBackgroundSettings: (_settings: unknown) => {},
        getBackgroundPath: (fileUrl: string) => `backgrounds/${encodeURIComponent(fileUrl)}`,
        isCustomBackgroundUrl: (fileUrl: string) =>
            (chatView()?.chat?.backgrounds ?? []).some((b) => b.file === fileUrl || `url("${b.url}")` === fileUrl),
        getActiveBackgroundTab: () => (tab() === 'chat' ? 1 : 0),
        listBackgroundFiles: () => [
            ...(view()?.system ?? []).map((b) => ({ file: b.file, chat: false })),
            ...(chatView()?.chat?.backgrounds ?? []).map((b) => ({ file: b.file, chat: true })),
        ],
        selectBackground: async (file: string, chat: boolean) => {
            const result = await client.send('backgrounds.select', { file, chat, forUser: false });
            return result.ok ? null : result.error;
        },
        lock: async () => {
            const result = await client.send('backgrounds.lock', { background: null });
            return result.ok ? null : result.error;
        },
        unlock: async () => {
            const result = await client.send('backgrounds.unlock', {});
            return result.ok ? null : result.error;
        },
        autoSelect: () => pickByModel(client, view, quietPrompt, t),
        forceSetBackground: (background: { path: string }) =>
            client.send('backgrounds.addToChat', { file: background.path }),
    };
}

export type BackgroundsCompat = ReturnType<typeof backgroundsCompat>;
