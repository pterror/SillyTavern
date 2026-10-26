import { createSignal } from 'solid-js';
import type { ChatOwner, ViewPush } from '@st/protocol';

export type { ViewFrame } from '@st/protocol';
export { SERVER_OWNED } from './areas/settings/compat.ts';
import { createClient } from './client.ts';
import { UiProvider } from './context.ts';
import type { Ui } from './context.ts';
import { Backgrounds } from './areas/backgrounds/Backgrounds.tsx';
import type { BackgroundsTab } from './areas/backgrounds/Backgrounds.tsx';
import { AnimationOption, BackgroundLayer } from './areas/backgrounds/Layer.tsx';
import { backgroundsCompat } from './areas/backgrounds/compat.ts';
import { CcContext, CcOptions, CcSamplers, CcUtility } from './areas/settings/cc.tsx';
import type { Support } from './areas/settings/cc.tsx';
import { LevelSlider } from './areas/settings/LevelSlider.tsx';
import { settingsCompat } from './areas/settings/compat.ts';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';

// The new page, started by the old one (public/scripts/new-ui.js), which hands it what only the old page has yet,
// and the containers its surfaces replace.

export type StartOptions = {
    headers: () => Record<string, string>;
    t: (text: string, key?: string) => string;
    quietPrompt: (prompt: string) => Promise<string>;
    /** The chat the old page shows now (null: none), told to the server when the tab's stream reconnects. */
    currentChat: () => ChatOwner | null;
    containers: {
        /** The backgrounds drawer's content (`#Backgrounds`). */
        backgrounds: HTMLElement;
        /** The background behind the chat (`#bg1`). */
        backgroundLayer: HTMLElement;
        /** Where the user settings' animated-thumbnails option goes. */
        backgroundAnimation: HTMLElement;
        /** Over the AI response configuration panel: the levels slider. */
        settingsLevels: HTMLElement;
        /** The chat completion fields, where the old markup's runs of them were (between them the old page's). */
        ccContext: HTMLElement;
        ccSamplers: HTMLElement;
        ccUtility: HTMLElement;
        ccOptions: HTMLElement;
    };
};

export function start(options: StartOptions) {
    const client = createClient({ headers: options.headers });
    const ui: Ui = { client, t: options.t };
    const mount = (container: HTMLElement, surface: () => JSX.Element) =>
        render(() => <UiProvider value={ui}>{surface()}</UiProvider>, container);

    const [tab, setTab] = createSignal<BackgroundsTab>('system');
    const backgroundsOptions = { quietPrompt: options.quietPrompt };
    const { backgrounds, backgroundLayer, backgroundAnimation } = options.containers;
    mount(backgrounds, () => (
        <Backgrounds options={backgroundsOptions} container={backgrounds} tab={tab()} onTab={(next) => setTab(next)} />
    ));
    mount(backgroundLayer, () => <BackgroundLayer element={backgroundLayer} />);
    mount(backgroundAnimation, () => <AnimationOption />);

    const { settingsLevels, ccContext, ccSamplers, ccUtility, ccOptions } = options.containers;
    const [support, setSupport] = createSignal<Support>({
        functionCalling: false,
        image: false,
        video: false,
        audio: false,
    });
    mount(settingsLevels, () => <LevelSlider />);
    mount(ccContext, () => <CcContext />);
    mount(ccSamplers, () => <CcSamplers />);
    mount(ccUtility, () => <CcUtility />);
    mount(ccOptions, () => <CcOptions support={support} />);

    return {
        /** Views the server pushed on the tab's stream. */
        receive: (push: ViewPush) => {
            client.receive(push);
        },
        /** The tab's stream (re)connected. */
        reconnected: () => client.reconnected(options.currentChat()),
        /** The old page closed its chat (no chat shows now). */
        closeChat: () => client.send('chat.close', {}),
        backgrounds: backgroundsCompat(client, tab, options.quietPrompt, options.t),
        settings: {
            ...settingsCompat(client),
            /** What the current model supports, as the old page knows it (its toggles show it). */
            setSupport,
        },
    };
}

export type NewUi = ReturnType<typeof start>;
