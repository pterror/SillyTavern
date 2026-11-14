import { For, Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { useUi } from '@st/page/context';
import { ask } from '@st/page/dialog';
import { WORLDS_VIEW } from '../protocol.ts';
import type { ExportedWorld, WorldsView } from '../protocol.ts';
import { Picture } from './Cards.tsx';
import { useWb } from './context.ts';
import { dismissOn } from './dismiss.ts';
import { Icon } from './icons.tsx';
import { openedView } from './views.ts';
import { count, fill } from './words.ts';

export type ShownWorld = {
    id: string;
    name: string;
    picture: string | null;
    usedInEveryChat: boolean;
    // The character whose own lorebook this is: it can't be renamed, duplicated or exported as a world, and deleting
    // it takes it off the character.
    ownBookOf: string | null;
};

export function chooseFile(accept: string): Promise<File | null> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.addEventListener(
            'change',
            () => {
                resolve(input.files?.[0] ?? null);
            },
            { once: true },
        );
        input.addEventListener(
            'cancel',
            () => {
                resolve(null);
            },
            { once: true },
        );
        input.click();
    });
}

function download({ fileName, json }: ExportedWorld) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(link.href);
}

export function Switcher(props: {
    world: ShownWorld | null;
    onOpen: (book: string) => void;
    activationSettings: () => JSX.Element;
}) {
    const { t } = useUi();
    const [open, setOpen] = createSignal(false);
    const [settings, setSettings] = createSignal(false);
    let button: HTMLButtonElement | undefined;
    return (
        <div class="wb-switch-at">
            <button
                ref={(element) => (button = element)}
                type="button"
                class="menu_button menu_button_icon margin0 whitespacenowrap wb-switch"
                aria-label={t('Switch world')}
                aria-expanded={open()}
                onClick={() => setOpen(!open())}
            >
                <Show when={props.world?.picture !== null && props.world !== null}>
                    <Picture url={props.world?.picture ?? null} class="wb-switch-pic" />
                </Show>
                <span class="wb-switch-name">{props.world?.name ?? ''}</span>
                <Icon name="chevron" />
            </button>
            <Show when={open()}>
                <WorldsMenu
                    world={props.world}
                    opener={() => button}
                    onClose={() => setOpen(false)}
                    onSettings={() => {
                        setOpen(false);
                        setSettings(true);
                    }}
                    onOpen={(book) => {
                        setOpen(false);
                        props.onOpen(book);
                    }}
                />
            </Show>
            <Show when={settings()}>
                <SettingsPanel opener={() => button} onClose={() => setSettings(false)}>
                    {props.activationSettings()}
                </SettingsPanel>
            </Show>
        </div>
    );
}

function SettingsPanel(props: { opener: () => HTMLElement | undefined; onClose: () => void; children: JSX.Element }) {
    const { t } = useUi();
    let panel: HTMLDivElement | undefined;
    dismissOn(() => panel, props.onClose, props.opener);
    return (
        <div
            class="wb-menu wb-activation-settings"
            role="dialog"
            aria-label={t('Activation settings')}
            ref={(element) => (panel = element)}
        >
            <div class="wb-menu-head">{t('Activation settings')}</div>
            {props.children}
        </div>
    );
}

function WorldsMenu(props: {
    world: ShownWorld | null;
    opener: () => HTMLElement | undefined;
    onClose: () => void;
    onSettings: () => void;
    onOpen: (book: string) => void;
}) {
    const { client, t } = useUi();
    const wb = useWb();
    const worlds = openedView<WorldsView>(client, WORLDS_VIEW);
    let menu: HTMLDivElement | undefined;
    dismissOn(() => menu, props.onClose, props.opener);
    const overview = () => wb.firstRead();
    // The action starts before the menu closes, so what it reads of the menu's props is read while they are there.
    const run = (action: () => Promise<unknown>) => {
        const started = action();
        props.onClose();
        void started;
    };
    return (
        <div class="wb-menu list-group wb-worlds" role="menu" ref={(element) => (menu = element)}>
            <For each={worlds()?.worlds ?? []}>
                {(world) => (
                    <div class="list-group-item wb-world-row" classList={{ 'wb-on': world.id === props.world?.id }}>
                        <button
                            type="button"
                            role="menuitem"
                            class="wb-world-row-open"
                            onClick={() => props.onOpen(world.id)}
                        >
                            <Picture url={world.picture} class="wb-switch-pic" />
                            <span class="wb-world-row-name">{world.name}</span>
                            <span class="wb-world-row-count">{count(world.entries)}</span>
                        </button>
                        <input
                            type="checkbox"
                            class="wb-world-row-used"
                            checked={world.usedInEveryChat}
                            aria-label={fill(t('${0}: used in every chat'), world.name)}
                            title={t('Used in every chat')}
                            onChange={() =>
                                void wb.act('worldbuilding.setUsedInEveryChat', {
                                    changes: [{ book: world.id, used: !world.usedInEveryChat }],
                                })
                            }
                        />
                    </div>
                )}
            </For>
            <hr />
            <button
                class="list-group-item"
                type="button"
                role="menuitem"
                onClick={() =>
                    run(async () => {
                        const name = await ask({ kind: 'input', message: t('World name'), value: '' }, t);
                        if (name !== null) await wb.act('worldbuilding.createWorld', { name, overview: overview() });
                    })
                }
            >
                {t('New world…')}
            </button>
            <button
                class="list-group-item"
                type="button"
                role="menuitem"
                onClick={() =>
                    run(async () => {
                        const file = await chooseFile('.json,.png,application/json,image/png');
                        if (file) await wb.act('worldbuilding.importWorld', { overview: overview() }, file);
                    })
                }
            >
                {t('Import world…')}
            </button>
            <button class="list-group-item" type="button" role="menuitem" onClick={() => props.onSettings()}>
                {t('Activation settings…')}
            </button>
            <Show when={props.world} keyed>
                {(world) => (
                    <>
                        <hr />
                        <button
                            class="list-group-item"
                            type="button"
                            role="menuitem"
                            onClick={() =>
                                run(async () => {
                                    const file = await chooseFile('image/*');
                                    if (file)
                                        await wb.act('worldbuilding.setPicture', { book: world.id, entry: null }, file);
                                })
                            }
                        >
                            {t('Set picture…')}
                        </button>
                        <Show when={world.picture !== null}>
                            <button
                                class="list-group-item"
                                type="button"
                                role="menuitem"
                                onClick={() =>
                                    run(() => wb.act('worldbuilding.removePicture', { book: world.id, entry: null }))
                                }
                            >
                                {t('Remove picture')}
                            </button>
                        </Show>
                        <Show when={world.ownBookOf === null}>
                            <button
                                class="list-group-item"
                                type="button"
                                role="menuitem"
                                onClick={() =>
                                    run(() =>
                                        wb.act('worldbuilding.duplicateWorld', {
                                            book: world.id,
                                            overview: overview(),
                                        }),
                                    )
                                }
                            >
                                {t('Duplicate')}
                            </button>
                        </Show>
                        <button
                            class="list-group-item"
                            type="button"
                            role="menuitem"
                            onClick={() =>
                                run(async () => {
                                    const done = await wb.act('worldbuilding.exportWorld', { book: world.id });
                                    if (done.ok && done.answer !== undefined) download(done.answer as ExportedWorld);
                                })
                            }
                        >
                            {t('Export')}
                        </button>
                        <button
                            type="button"
                            role="menuitem"
                            class="list-group-item wb-danger"
                            onClick={() =>
                                run(async () => {
                                    const sure = await ask(
                                        world.ownBookOf === null
                                            ? {
                                                  kind: 'confirm',
                                                  message: fill(t('Delete “${0}”?'), world.name),
                                                  detail: t('Its entries are deleted too.'),
                                              }
                                            : {
                                                  kind: 'confirm',
                                                  message: fill(t('Remove the lorebook from “${0}”?'), world.ownBookOf),
                                                  detail: t('Its entries are deleted too.'),
                                              },
                                        t,
                                    );
                                    if (sure) await wb.act('worldbuilding.deleteWorld', { book: world.id });
                                })
                            }
                        >
                            {world.ownBookOf === null ? t('Delete') : fill(t('Remove from ${0}'), world.ownBookOf)}
                        </button>
                    </>
                )}
            </Show>
        </div>
    );
}
