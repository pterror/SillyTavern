import { createSignal } from 'solid-js';
import type { ChatOwner, ViewPush } from '@st/protocol';

export type { ViewFrame } from '@st/protocol';
export { SERVER_OWNED } from '@st/settings/page';
export { TRIGGER_MARK_CLASS, TRIGGER_MARK_EARLIER_CLASS } from '@st/protocol/looks';
export * from '@st/occlusion';
import { createClient } from '@st/page/client';
import { createCommands } from '@st/page/commands';
import type { BindingStorage, Command } from '@st/page/commands';
import { commandSurfaces } from '@st/page/command-surfaces';
import type { Anchor } from '@st/page/command-surfaces';
import { documentLookSheet } from '@st/page/looks';
import { inlineName, nameElement } from '@st/page/name';
import { DRAWN_VIEW } from '@st/protocol/looks';
import type { Declaration, LookState } from '@st/protocol/looks';
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
    WorldInfoSettings,
    settingsCompat,
} from '@st/settings/page';
import type { Support } from '@st/settings/page';
import { Alternatives, alternativesCompat } from '@st/alternatives/page';
import type { Look, OldPage } from '@st/alternatives/page';
import { Activations, activationsCompat } from '@st/activations/page';
import type { Look as ActivationsLook, OldPage as ActivationsOldPage } from '@st/activations/page';
import { UsageStats } from '@st/usage-stats/page';
import type { Buttons as UsageStatsButtons, OldPage as UsageStatsOldPage } from '@st/usage-stats/page';
import { Help, Hotkeys, helpCompat } from '@st/help/page';
import { LookScreen, looksCompat } from '@st/looks/page';
import { Worldbuilding, worldbuildingCompat } from '@st/worldbuilding/page';
import type { OldPage as HelpOldPage } from '@st/help/page';
import type { OldPage as WorldbuildingOldPage } from '@st/worldbuilding/page';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';

export type StartOptions = {
    headers: () => Record<string, string>;
    t: (text: string, key?: string) => string;
    quietPrompt: (prompt: string) => Promise<string>;
    currentChat: () => ChatOwner | null;
    /** Whether holding Ctrl (Cmd on a Mac) shows the cheatsheet */
    holdShowsKeys: () => boolean;
    alternatives: OldPage;
    activations: ActivationsOldPage;
    usageStats: UsageStatsOldPage;
    help: HelpOldPage;
    worldbuilding: WorldbuildingOldPage;
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
        worldbuilding: HTMLElement;
        usageStats: UsageStatsButtons;
    };
};

export function start(options: StartOptions) {
    const looks = documentLookSheet(document);
    const client = createClient({ headers: options.headers, looks });
    // Brings the trigger mark's rules, which every chat draws.
    client.view(DRAWN_VIEW);
    const commands = createCommands();
    const surfaces = commandSurfaces({ commands, holdShowsKeys: options.holdShowsKeys, t: options.t });
    const ui: Ui = { client, commands, t: options.t };
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
    const activations = activationsCompat(client, setActivationsLook);
    const activationsHost = document.createElement('div');
    document.body.append(activationsHost);
    mount(activationsHost, () => (
        <Activations look={activationsLook()} old={options.activations} onClose={() => activations.close()} />
    ));

    const usageStatsHost = document.createElement('div');
    document.body.append(usageStatsHost);
    mount(usageStatsHost, () => <UsageStats buttons={options.containers.usageStats} old={options.usageStats} />);

    const worldbuilding = worldbuildingCompat(client, options.worldbuilding);
    mount(options.containers.worldbuilding, () => (
        <Worldbuilding
            shown={worldbuilding.shown()}
            everShown={worldbuilding.everShown()}
            target={worldbuilding.target()}
            onTargetTaken={worldbuilding.targetTaken}
            notify={(words, action) => options.worldbuilding.notify(words, action)}
            activationSettings={() => <WorldInfoSettings />}
        />
    ));

    const chatCardHost = document.createElement('div');
    document.body.append(chatCardHost);
    mount(chatCardHost, () => <worldbuilding.ChatCard />);

    const lookHost = document.createElement('div');
    document.body.append(lookHost);
    mount(lookHost, () => <LookScreen />);

    const help = helpCompat(client);
    const helpHost = document.createElement('div');
    document.body.append(helpHost);
    mount(helpHost, () => (
        <Help
            shown={help.shown()}
            old={options.help}
            onRaise={(raise) => help.onRaise(raise)}
            onClose={() => help.close()}
        />
    ));

    return {
        receive: (push: ViewPush) => {
            client.receive(push);
        },
        reconnected: () => client.reconnected(options.currentChat()),
        closeChat: () => client.send('chat.close', {}),
        commands: {
            register: commands.register,
            all: commands.all,
            available: commands.available,
            conflicts: commands.conflicts,
            keepBindingsIn: (storage: BindingStorage) => {
                commands.keepBindingsIn(storage);
            },
            openMenu: (anchor: Anchor, list: readonly Command[]) => {
                surfaces.openMenu(anchor, list);
            },
            openPalette: () => {
                surfaces.palette.set(true);
            },
            holdChanged: surfaces.holdChanged,
            overrides: commands.overrides,
        },
        backgrounds: backgroundsCompat(client, tab, options.quietPrompt, options.t),
        alternatives: alternativesCompat(setLook),
        activations,
        worldbuilding,
        help: {
            open: (name: string) => help.open(name),
            /** @returns what takes the list off again */
            hotkeys: async (into: HTMLElement): Promise<() => void> => {
                await help.hotkeysRead();
                return mount(into, () => <Hotkeys />);
            },
        },
        names: {
            element: nameElement,
            inline: inlineName,
            hold: looks.hold,
            add: looks.add,
            drop: looks.drop,
        },
        looks: {
            ...looksCompat(client),
            setDeclarations: async (
                level: { theme: true } | { thing: string },
                state: LookState,
                set: Declaration[],
                reset: string[],
            ): Promise<string | null> => {
                const answer = await client.send('looks.setDeclarations', { level, state, set, reset });
                return answer.ok ? null : answer.error;
            },
        },
        settings: {
            ...settingsCompat(client),
            setSupport,
        },
    };
}

export type NewUi = ReturnType<typeof start>;
