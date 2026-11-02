import { createSignal } from 'solid-js';
import type { ChatOwner, ViewPush } from '@st/protocol';

export type { ViewFrame } from '@st/protocol';
export { SERVER_OWNED } from '@st/settings/page';
export * from '@st/occlusion';
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
import { Alternatives, alternativesCompat } from '@st/alternatives/page';
import type { Look, OldPage } from '@st/alternatives/page';
import { Activations } from '@st/activations/page';
import type { Look as ActivationsLook, OldPage as ActivationsOldPage } from '@st/activations/page';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';

export type StartOptions = {
    headers: () => Record<string, string>;
    t: (text: string, key?: string) => string;
    quietPrompt: (prompt: string) => Promise<string>;
    currentChat: () => ChatOwner | null;
    alternatives: OldPage;
    activations: ActivationsOldPage;
    containers: {
        backgrounds: HTMLElement;
        backgroundLayer: HTMLElement;
        backgroundAnimation: HTMLElement;
        settingsLevels: HTMLElement;
        ccContext: HTMLElement;
        ccSamplers: HTMLElement;
        ccUtility: HTMLElement;
        ccOptions: HTMLElement;
        commonLengths: HTMLElement;
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

    const [look, setLook] = createSignal<Look | null>(null);
    const alternativesHost = document.createElement('div');
    document.body.append(alternativesHost);
    mount(alternativesHost, () => (
        <Alternatives look={look()} old={options.alternatives} onClose={() => setLook(null)} />
    ));

    const [activationsLook, setActivationsLook] = createSignal<ActivationsLook | null>(null);
    const activationsHost = document.createElement('div');
    document.body.append(activationsHost);
    mount(activationsHost, () => (
        <Activations look={activationsLook()} old={options.activations} onClose={() => setActivationsLook(null)} />
    ));

    return {
        receive: (push: ViewPush) => {
            client.receive(push);
        },
        reconnected: () => client.reconnected(options.currentChat()),
        closeChat: () => client.send('chat.close', {}),
        backgrounds: backgroundsCompat(client, tab, options.quietPrompt, options.t),
        alternatives: alternativesCompat(setLook),
        activations: {
            open: (message: string) => setActivationsLook({ message }),
            close: () => setActivationsLook(null),
        },
        settings: {
            ...settingsCompat(client),
            setSupport,
        },
    };
}

export type NewUi = ReturnType<typeof start>;
