import { createSignal } from 'solid-js';
import type { ChatOwner, ViewPush } from '@st/protocol';

export type { ViewFrame } from '@st/protocol';
export { SERVER_OWNED } from '@st/settings/page';
import { createClient } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import type { Ui } from '@st/page/context';
import { AnimationOption, BackgroundLayer, Backgrounds, backgroundsCompat } from '@st/backgrounds/page';
import type { BackgroundsTab } from '@st/backgrounds/page';
import {
    CcContext,
    CcOptions,
    CcSamplers,
    CcUtility,
    CommonLengths,
    LevelSlider,
    TgCfg,
    TgSamplers,
    TgTop,
    settingsCompat,
} from '@st/settings/page';
import type { Support } from '@st/settings/page';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';

// The new page, started by the old one (public/scripts/new-ui.js), which hands it what only the old page has yet,
// and the containers its surfaces replace. It's the page's loader: the core (@st/page) and each area's page half
// (packages/areas/*), mounted in the old page's containers.

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
        /** The fields the text APIs share (response length, context size, streaming), before the prompt cost line. */
        commonLengths: HTMLElement;
        /** The text generation fields, likewise (between them the logit bias editor, after them the sampler orders). */
        tgTop: HTMLElement;
        tgSamplers: HTMLElement;
        tgCfg: HTMLElement;
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

    const { settingsLevels, ccContext, ccSamplers, ccUtility, ccOptions, tgTop, tgSamplers, tgCfg, commonLengths } =
        options.containers;
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
    mount(commonLengths, () => <CommonLengths />);
    mount(tgTop, () => <TgTop />);
    mount(tgSamplers, () => <TgSamplers />);
    mount(tgCfg, () => <TgCfg />);

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
