import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { VIEW, CHAT_VIEW, actions, COLUMNS, FITTINGS, SORT_ORDERS } from '@st/protocol/backgrounds';
import type { Background, BackgroundsView, ChatBackgroundsView, Folder, Ref } from '@st/protocol/backgrounds';
import type { Payload } from '@st/protocol';
import type { Client } from '../../client.ts';
import { classes } from '../../classes.ts';
import { useUi } from '../../context.ts';
import { ask } from '../../layers/dialog.tsx';

// The backgrounds drawer: the system's backgrounds (with folders) and the open chat's, each shown from the server's
// view. What's only this drawer's (the tab, the search, the folder open, what's ticked) is the drawer's own.

type Actions = typeof actions;

/**
 * Asks the model which system background suits the chat now, and selects the one its reply names; answers why
 * nothing was selected, or null.
 */
export async function pickByModel(
    client: Client,
    view: Accessor<BackgroundsView | undefined>,
    quietPrompt: (prompt: string) => Promise<string>,
    t: (text: string) => string,
): Promise<string | null> {
    const titles = (view()?.system ?? []).map((b) => b.title).filter((title) => title.length > 0);
    if (titles.length === 0)
        return t('No backgrounds to choose from. Please upload some images to the "backgrounds" folder.');
    const reply = await quietPrompt(AUTO_PROMPT + titles.map((title) => `- ${title}`).join('\n'));
    const result = await client.send('backgrounds.pickByTitle', { reply });
    return result.ok ? null : result.error;
}

export type BackgroundsOptions = {
    /** Asks the model a quiet question (the old page's quiet prompt); answers its reply. */
    quietPrompt: (prompt: string) => Promise<string>;
};

const AUTO_PROMPT =
    'Ignore previous instructions and choose a location ONLY from the provided list that is the most suitable for the current scene. Do not output any other text:\n';

const FITTING_LABELS: Record<(typeof FITTINGS)[number], string> = {
    classic: 'Classic',
    cover: 'Cover',
    contain: 'Contain',
    stretch: 'Stretch',
    center: 'Center',
};
const SORT_LABELS: Record<(typeof SORT_ORDERS)[number], string> = {
    az: 'A-Z',
    za: 'Z-A',
    newest: 'Newest',
    oldest: 'Oldest',
};

/** A video can be a background once a converter (the Video Background Loader extension) makes it an animated webp. */
type VideoConverter = (input: { buffer: Uint8Array; name: string }) => Promise<ArrayBuffer | Uint8Array>;

export type BackgroundsTab = 'system' | 'chat';

export function Backgrounds(props: {
    options: BackgroundsOptions;
    container: HTMLElement;
    /** Which tab shows (upstream's getActiveBackgroundTab() reads it). */
    tab: BackgroundsTab;
    onTab: (tab: BackgroundsTab) => void;
}) {
    const { client, t } = useUi();
    const view = client.view<BackgroundsView>(VIEW);
    const chatView = client.view<ChatBackgroundsView>(CHAT_VIEW);
    const tab = () => props.tab;
    const setTab = (next: BackgroundsTab) => props.onTab(next);
    const [search, setSearch] = createSignal('');
    const [folder, setFolder] = createSignal<string | null>(null);
    const [ticking, setTicking] = createSignal(false);
    const [ticked, setTicked] = createSignal<ReadonlySet<string>>(new Set());
    const [notice, setNotice] = createSignal<string | null>(null);
    const [busy, setBusy] = createSignal<string | null>(null);

    const act = async <T extends keyof Actions>(type: T, payload: Payload<Actions, T>, file?: File) => {
        setNotice(null);
        const result = await client.send(type, payload, file);
        if (!result.ok) setNotice(result.error);
        return result.ok;
    };

    const matches = (b: { title: string }) => b.title.toLowerCase().includes(search().trim().toLowerCase());
    // The folder open: the one chosen, while the view still has it (another tab may delete it).
    const openFolder = createMemo(() => view()?.folders.find((f) => f.id === folder()) ?? null);
    const activeFolder = () => openFolder()?.id ?? null;
    const system = createMemo(() => {
        const open = activeFolder();
        return (view()?.system ?? []).filter((b) => (open === null || b.folders.includes(open)) && matches(b));
    });
    const chatBackgrounds = createMemo(() => (chatView()?.chat?.backgrounds ?? []).filter(matches));
    const folders = createMemo(() =>
        (view()?.folders ?? []).filter((f) => f.name.toLowerCase().includes(search().trim().toLowerCase())),
    );
    const isSelected = (ref: Ref) => {
        const selected = view()?.selected;
        return !ref.chat && selected?.file === ref.file;
    };
    const isLocked = (ref: Ref) => {
        const locked = chatView()?.chat?.locked;
        return !!locked && locked.file === ref.file && locked.chat === ref.chat;
    };

    const setTick = (file: string, on: boolean) => {
        const next = new Set(ticked());
        if (on) next.add(file);
        else next.delete(file);
        setTicked(next);
    };
    const stopTicking = () => {
        setTicking(false);
        setTicked(new Set<string>());
    };

    const pick = (background: Background, chat: boolean, event: MouseEvent) => {
        if (ticking() && !chat) return setTick(background.file, !ticked().has(background.file));
        void act('backgrounds.select', { file: background.file, chat, forUser: event.shiftKey });
    };

    const rename = async (background: Background) => {
        const name = await ask({ kind: 'input', message: t('Enter new background name:'), value: background.title }, t);
        if (name !== null && name !== background.title) void act('backgrounds.rename', { file: background.file, name });
    };

    const remove = async (background: Background, chat: boolean) => {
        const answer = await ask(
            {
                kind: 'confirm',
                message: t('Delete the background?'),
                ...(chat ? { checkbox: { label: t('Also delete file from server'), checked: true } } : {}),
            },
            t,
        );
        if (answer) void act('backgrounds.delete', { file: background.file, chat, deleteFile: chat && answer.checked });
    };

    const copyToSystem = async (background: Background) => {
        const name = await ask({ kind: 'input', message: t('Enter new background name:'), value: background.title }, t);
        if (name !== null) void act('backgrounds.copyToSystem', { file: background.file, name });
    };

    const chooseFolders = (message: string, checked: (f: Folder) => boolean) => {
        const list = view()?.folders ?? [];
        if (list.length === 0) {
            setNotice(t('Create a folder first'));
            return Promise.resolve(null);
        }
        return ask(
            { kind: 'choose', message, options: list.map((f) => ({ id: f.id, label: f.name, checked: checked(f) })) },
            t,
        );
    };

    const assignFolders = async (background: Background) => {
        const chosen = await chooseFolders(t('Assign to folders'), (f) => background.folders.includes(f.id));
        if (chosen !== null) void act('backgrounds.folders.set', { file: background.file, folders: chosen });
    };

    const addTickedToFolders = async () => {
        const chosen = await chooseFolders(t('Add selected backgrounds to folders'), () => false);
        if (chosen === null || chosen.length === 0) return;
        if (await act('backgrounds.folders.add', { files: [...ticked()], folders: chosen })) stopTicking();
    };

    const removeTickedFromFolder = async () => {
        const open = activeFolder();
        if (open === null) return;
        if (await act('backgrounds.folders.remove', { files: [...ticked()], folder: open })) stopTicking();
    };

    const createFolder = async () => {
        const name = await ask({ kind: 'input', message: t('Enter folder name:'), value: '' }, t);
        if (name !== null) void act('backgrounds.folders.create', { name });
    };

    const renameFolder = async (target: Folder) => {
        const name = await ask({ kind: 'input', message: t('Enter new folder name:'), value: target.name }, t);
        if (name !== null && name !== target.name) void act('backgrounds.folders.rename', { id: target.id, name });
    };

    const deleteFolder = async (target: Folder) => {
        const answer = await ask(
            {
                kind: 'confirm',
                message: `${t('Delete folder')} "${target.name}"?`,
                detail: t('Images will not be deleted, only the folder grouping.'),
            },
            t,
        );
        if (!answer) return;
        if (await act('backgrounds.folders.delete', { id: target.id })) {
            if (activeFolder() === target.id) setFolder(null);
        }
    };

    const upload = async (input: HTMLInputElement) => {
        const files = [...(input.files ?? [])].filter((f) => f.size > 0);
        // The same file can be chosen again.
        input.value = '';
        for (const chosen of files) {
            const file = chosen.type.startsWith('video/') ? await videoAsImage(chosen) : chosen;
            if (file) await act('backgrounds.upload', { chat: tab() === 'chat' }, file);
        }
    };

    const videoAsImage = async (video: File): Promise<File | null> => {
        const convert = (globalThis as { convertVideoToAnimatedWebp?: VideoConverter }).convertVideoToAnimatedWebp;
        if (!convert) {
            setNotice(
                t('Video background uploads require a downloadable add-on') +
                    ': https://github.com/SillyTavern/Extension-VideoBackgroundLoader',
            );
            return null;
        }
        setBusy(t('Preparing video for upload. This may take several minutes.'));
        try {
            const converted = await convert({ buffer: new Uint8Array(await video.arrayBuffer()), name: video.name });
            return new File([new Uint8Array(converted)], video.name.replace(/\.[^/.]+$/, '.webp'), {
                type: 'image/webp',
            });
        } catch {
            setNotice(t('Error converting video to animated webp'));
            return null;
        } finally {
            setBusy(null);
        }
    };

    const autoSelect = async () => {
        setBusy(t('Choosing a background...'));
        try {
            const refused = await pickByModel(client, view, props.options.quietPrompt, t);
            if (refused) setNotice(refused);
        } finally {
            setBusy(null);
        }
    };

    // The user's column count, else the layout's own (the stylesheet's, by screen width).
    const chosenColumns = () => view()?.options.columns ?? null;
    const columns = () =>
        chosenColumns() ?? (Number(getComputedStyle(props.container).getPropertyValue('--bg-thumb-columns')) || 5);
    const setColumns = (count: number) => {
        const next = Math.min(COLUMNS.max, Math.max(COLUMNS.min, count));
        if (next !== columns()) void act('backgrounds.options', { columns: next });
    };

    // The drawer's own classes on the container the old page gave it (its CSS keys off them).
    createEffect(() => {
        props.container.classList.toggle('bg-selection-mode', ticking());
        props.container.classList.toggle('in-folder-view', activeFolder() !== null);
        const chosen = chosenColumns();
        if (chosen === null) props.container.style.removeProperty('--bg-thumb-columns');
        else props.container.style.setProperty('--bg-thumb-columns', String(chosen));
    });

    const [scrolled, setScrolled] = createSignal(false);
    let panels: HTMLDivElement | undefined;

    return (
        <>
            <div id="bg-header-fixed">
                <div class="bg-header-row-1">
                    <h3 class="margin0">
                        <span>{t('Backgrounds')}</span>
                    </h3>
                    <span class="expander" />
                    <select
                        id="background_fitting"
                        class="text_pole"
                        title={t('Background Fitting')}
                        value={view()?.options.fitting ?? 'classic'}
                        onChange={(event) => {
                            const select = event.currentTarget;
                            void act('backgrounds.options', {
                                fitting: select.value as (typeof FITTINGS)[number],
                            }).then(
                                // Refused: back to what the server has (the view didn't change, so nothing redraws it).
                                (ok) => ok || (select.value = view()?.options.fitting ?? 'classic'),
                            );
                        }}
                    >
                        <For each={FITTINGS}>
                            {(fitting) => <option value={fitting}>{t(FITTING_LABELS[fitting])}</option>}
                        </For>
                    </select>
                    <button
                        id="auto_background"
                        type="button"
                        class="menu_button menu_button_icon"
                        title={t('Automatically select a background based on the chat context')}
                        disabled={busy() !== null}
                        onClick={() => void autoSelect()}
                    >
                        <i class="fa-solid fa-wand-magic" />
                        <span>{t('Auto-select')}</span>
                    </button>
                    <button
                        id="bg_add_folder_button"
                        type="button"
                        class="menu_button menu_button_icon"
                        title={t('New Folder')}
                        onClick={() => void createFolder()}
                    >
                        <i class="fa-solid fa-folder-plus" />
                        <span>{t('New Folder')}</span>
                    </button>
                    <label
                        for="add_bg_button"
                        id="add_background_button_top"
                        class="menu_button menu_button_icon"
                        title={t('Add a new background')}
                    >
                        <i class="fa-solid fa-upload" />
                        <span>{t('Add Background')}</span>
                    </label>
                </div>
                <div class="bg-header-row-2">
                    <input
                        id="bg-filter"
                        class="text_pole"
                        type="search"
                        placeholder={t('Search...')}
                        value={search()}
                        onInput={(event) => setSearch(event.currentTarget.value)}
                    />
                    <select
                        id="bg-sort"
                        class="text_pole margin0"
                        title={t('Sort backgrounds')}
                        value={view()?.options.sortOrder ?? 'az'}
                        onChange={(event) => {
                            const select = event.currentTarget;
                            void act('backgrounds.options', {
                                sortOrder: select.value as (typeof SORT_ORDERS)[number],
                            }).then((ok) => ok || (select.value = view()?.options.sortOrder ?? 'az'));
                        }}
                    >
                        <For each={SORT_ORDERS}>
                            {(order) => <option value={order}>{t(SORT_LABELS[order])}</option>}
                        </For>
                    </select>
                </div>
                <Show when={busy() ?? notice()}>
                    {(text) => (
                        <div class="bg_notice" role="status">
                            {text()}
                        </div>
                    )}
                </Show>
            </div>
            <div
                id="bg_tabs"
                class="heading-container-with-controls tab-container"
                ref={(element: HTMLDivElement) => (panels = element)}
                onScroll={() => setScrolled((panels?.scrollTop ?? 0) > 200)}
            >
                <label class="tab-title">
                    <input
                        type="radio"
                        class="invisible-radio"
                        name="bg_tabs_tab"
                        value="0"
                        checked={tab() === 'system'}
                        onChange={() => setTab('system')}
                    />
                    <span>{t('Global')}</span>
                </label>
                <div id="bg_global_tab" class="bg_tab_panel tab-contents">
                    <Show when={openFolder()}>
                        {(open) => (
                            <div id="bg_folder_breadcrumb" class="bg_folder_breadcrumb">
                                <button
                                    id="bg_back_to_folders"
                                    type="button"
                                    class="menu_button menu_button_icon"
                                    onClick={() => {
                                        stopTicking();
                                        setFolder(null);
                                    }}
                                >
                                    <i class="fa-solid fa-arrow-left" />
                                    <span>{t('Back')}</span>
                                </button>
                                <span id="bg_current_folder_name" class="bg_current_folder_name">
                                    {open().name}
                                </span>
                                <span class="expander" />
                                <Show when={ticking() && ticked().size > 0}>
                                    {
                                        <button
                                            id="bg_folder_remove_selected_button"
                                            type="button"
                                            class="menu_button menu_button_icon"
                                            title={t('Remove selected backgrounds from this folder')}
                                            onClick={() => void removeTickedFromFolder()}
                                        >
                                            <i class="fa-solid fa-folder-minus" />
                                            <span>{t('Remove from Folder')}</span>
                                        </button>
                                    }
                                </Show>
                            </div>
                        )}
                    </Show>
                    <Show when={activeFolder() === null}>
                        {
                            <div id="bg_folder_grid" class="bg_list bg_folder_grid">
                                <For each={folders()}>
                                    {(target) => (
                                        <FolderTile
                                            folder={target}
                                            t={t}
                                            onOpen={(id) => {
                                                stopTicking();
                                                setFolder(id);
                                            }}
                                            onRename={(f) => void renameFolder(f)}
                                            onDelete={(f) => void deleteFolder(f)}
                                        />
                                    )}
                                </For>
                            </div>
                        }
                    </Show>
                    <div id="bg_menu_content" class="bg_list">
                        <For each={system()}>
                            {(background) => (
                                <Thumbnail
                                    background={background}
                                    chat={false}
                                    animation={view()?.options.animation ?? false}
                                    selected={isSelected({ file: background.file, chat: false })}
                                    locked={isLocked({ file: background.file, chat: false })}
                                    ticked={ticked().has(background.file)}
                                    t={t}
                                    onPick={(event) => pick(background, false, event)}
                                    onAction={(action) => {
                                        if (action === 'lock')
                                            void act('backgrounds.lock', {
                                                background: { file: background.file, chat: false },
                                            });
                                        else if (action === 'unlock') void act('backgrounds.unlock', {});
                                        else if (action === 'edit') void rename(background);
                                        else if (action === 'delete') void remove(background, false);
                                        else if (action === 'folder') void assignFolders(background);
                                        else if (action === 'set-cover') {
                                            const open = activeFolder();
                                            if (open !== null)
                                                void act('backgrounds.folders.cover', {
                                                    id: open,
                                                    file: background.file,
                                                });
                                        }
                                    }}
                                />
                            )}
                        </For>
                    </div>
                </div>
                <label class="tab-title">
                    <input
                        type="radio"
                        class="invisible-radio"
                        name="bg_tabs_tab"
                        value="1"
                        checked={tab() === 'chat'}
                        onChange={() => {
                            stopTicking();
                            setTab('chat');
                        }}
                    />
                    <span>{t('Chat')}</span>
                </label>
                <div id="bg_chat_tab" class="bg_tab_panel tab-contents">
                    <div id="bg_custom_content" class="bg_list">
                        <For each={chatBackgrounds()}>
                            {(background) => (
                                <Thumbnail
                                    background={background}
                                    chat={true}
                                    animation={view()?.options.animation ?? false}
                                    selected={false}
                                    locked={isLocked({ file: background.file, chat: true })}
                                    ticked={false}
                                    t={t}
                                    onPick={(event) => pick(background, true, event)}
                                    onAction={(action) => {
                                        if (action === 'lock')
                                            void act('backgrounds.lock', {
                                                background: { file: background.file, chat: true },
                                            });
                                        else if (action === 'unlock') void act('backgrounds.unlock', {});
                                        else if (action === 'copy') void copyToSystem(background);
                                        else if (action === 'delete') void remove(background, true);
                                    }}
                                />
                            )}
                        </For>
                    </div>
                    <div id="bg_chat_hint" class="wide100p textAlignCenter">
                        <Show
                            when={view() !== undefined && chatView()?.chat === null}
                            fallback={
                                <span>
                                    {t('bg_chat_hint_1')} Image Generation {t('bg_chat_hint_2')}
                                </span>
                            }
                        >
                            {<span>{t('Select a chat to upload a background for it')}</span>}
                        </Show>
                    </div>
                </div>
                <div class="heading-controls">
                    <Show when={tab() === 'system' && ticking() && ticked().size > 0}>
                        {
                            <button
                                id="bg_group_add_to_folder_button"
                                type="button"
                                class="menu_button menu_button_icon"
                                title={t('Add selected backgrounds to folder')}
                                onClick={() => void addTickedToFolders()}
                            >
                                <i class="fa-solid fa-folder-tree" />
                                <span>{t('Add to Folder')}</span>
                            </button>
                        }
                    </Show>
                    <Show when={tab() === 'system'}>
                        {
                            <button
                                id="bg_selection_mode_button"
                                type="button"
                                class={classes('menu_button menu_button_icon', { active: ticking() })}
                                title={t('Select backgrounds for bulk folder actions')}
                                onClick={() => (ticking() ? stopTicking() : setTicking(true))}
                            >
                                <i class="fa-solid fa-edit" />
                                <Show when={ticked().size > 0}>
                                    {<span id="bg_group_select_count">{` (${ticked().size})`}</span>}
                                </Show>
                            </button>
                        }
                    </Show>
                    <button
                        id="bg_thumb_zoom_out"
                        type="button"
                        class="menu_button menu_button_icon"
                        title={t('Make thumbnails smaller')}
                        disabled={columns() >= COLUMNS.max}
                        onClick={() => setColumns(columns() + 1)}
                    >
                        <i class="fa-solid fa-minus" />
                    </button>
                    <button
                        id="bg_thumb_zoom_in"
                        type="button"
                        class="menu_button menu_button_icon"
                        title={t('Make thumbnails larger')}
                        disabled={columns() <= COLUMNS.min}
                        onClick={() => setColumns(columns() - 1)}
                    >
                        <i class="fa-solid fa-plus" />
                    </button>
                </div>
            </div>
            <input
                type="file"
                id="add_bg_button"
                accept="image/*,video/*"
                multiple
                hidden
                onChange={(event) => void upload(event.currentTarget)}
            />
            <button
                id="bg-scroll-top"
                type="button"
                class={classes('menu_button menu_button_icon', { visible: scrolled() })}
                title={t('Scroll backgrounds to top')}
                onClick={() => panels?.scrollTo({ top: 0, behavior: 'smooth' })}
            >
                <i class="fa-solid fa-chevron-up" aria-hidden="true" />
            </button>
        </>
    );
}

type ThumbnailAction = 'lock' | 'unlock' | 'copy' | 'edit' | 'delete' | 'folder' | 'set-cover';

const THUMBNAIL_BUTTONS: { action: ThumbnailAction; icon: string; title: string }[] = [
    { action: 'lock', icon: 'jg-lock fa-lock', title: 'Lock' },
    { action: 'unlock', icon: 'jg-unlock fa-lock-open', title: 'Unlock' },
    { action: 'copy', icon: 'jg-copy fa-file-arrow-up', title: 'Copy to global backgrounds' },
    { action: 'edit', icon: 'jg-edit fa-pen-to-square', title: 'Rename Background' },
    { action: 'delete', icon: 'jg-delete fa-trash-can', title: 'Delete Background' },
    { action: 'folder', icon: 'jg-folder fa-folder', title: 'Add to folder' },
    { action: 'set-cover', icon: 'jg-set-cover fa-image', title: 'Set as folder cover' },
];

const buttonClass = (icon: string) => `jg-button fa-solid fa-fw pointer ${icon}`;

function Thumbnail(props: {
    background: Background;
    chat: boolean;
    animation: boolean;
    selected: boolean;
    locked: boolean;
    ticked: boolean;
    t: (text: string) => string;
    onPick: (event: MouseEvent) => void;
    onAction: (action: ThumbnailAction) => void;
}) {
    // Everything about the background is read where it's drawn: the list keeps one Thumbnail per background (by its
    // id), and its thumbnail's version or its metadata can change while it's shown.
    const [menuOpen, setMenuOpen] = createSignal(false);
    // An animated background shows its first frame unless animation is on: a still drawn from the image once loaded,
    // or a video's first frame.
    const isVideo = () => /\.mp4$/i.test(props.background.file);
    const still = () => props.background.animated && !props.animation && !isVideo();
    return (
        <div
            class={classes('bg_example flex-container', {
                'selected-background': props.selected,
                'locked-background': props.locked,
                'folder-group-selected': props.ticked,
                'mobile-menu-open': menuOpen(),
            })}
            tabIndex={0}
            title={props.background.title}
            attr:bgfile={props.background.file}
            attr:custom={String(props.chat)}
            attr:animated={String(props.background.animated)}
            style={props.background.aspect ? { 'aspect-ratio': String(props.background.aspect) } : {}}
            onClick={(event) => props.onPick(event)}
            onFocusOut={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false);
            }}
        >
            <div
                class="thumbnail-clipper"
                style={{
                    ...(props.background.color ? { 'background-color': props.background.color } : {}),
                    ...(still() || isVideo() ? {} : { 'background-image': `url("${props.background.thumbnail}")` }),
                }}
            >
                <Show when={still()}>{<Still url={props.background.url} />}</Show>
                <Show when={isVideo()}>
                    {<video src={props.background.url} muted preload="metadata" class="thumbnail-still" />}
                </Show>
                <div class="BGSampleTitle">{props.background.title}</div>
            </div>
            <div
                class="mobile-only-menu-toggle"
                onClick={(event) => {
                    event.stopPropagation();
                    setMenuOpen(!menuOpen());
                }}
            >
                <i class="fa-solid fa-ellipsis-vertical" />
            </div>
            <div class="jg-menu">
                <For each={THUMBNAIL_BUTTONS}>
                    {({ action, icon, title: label }) => {
                        const buttonClasses = buttonClass(icon);
                        return (
                            <div
                                class={buttonClasses}
                                attr:data-action={action}
                                title={props.t(label)}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    props.onAction(action);
                                }}
                            />
                        );
                    }}
                </For>
            </div>
        </div>
    );
}

/**
 * An animated image's first frame, drawn onto a canvas so it doesn't play. The image loads lazily (when it scrolls
 * near), like the thumbnails, and is dropped once drawn.
 */
function Still(props: { url: string }) {
    let canvas: HTMLCanvasElement | undefined;
    const draw = (image: HTMLImageElement) => {
        if (!canvas) return;
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d')?.drawImage(image, 0, 0);
        image.remove();
    };
    return (
        <>
            <canvas class="thumbnail-still" ref={(element: HTMLCanvasElement) => (canvas = element)} />
            <img
                class="thumbnail-still thumbnail-loading"
                loading="lazy"
                decoding="async"
                alt=""
                src={props.url}
                onLoad={(event) => draw(event.currentTarget)}
            />
        </>
    );
}

function FolderTile(props: {
    folder: Folder;
    t: (text: string) => string;
    onOpen: (id: string) => void;
    onRename: (folder: Folder) => void;
    onDelete: (folder: Folder) => void;
}) {
    const [menuOpen, setMenuOpen] = createSignal(false);
    return (
        <div
            class={classes('bg_folder_tile', { 'mobile-menu-open': menuOpen() })}
            tabIndex={0}
            attr:data-folder-id={props.folder.id}
            onClick={() => props.onOpen(props.folder.id)}
        >
            <div
                class="bg_folder_tile_cover"
                style={props.folder.cover ? { 'background-image': `url("${props.folder.cover}")` } : {}}
            />
            <div class="bg_folder_tile_overlay">
                <i class="fa-solid fa-folder" />
                <span class="bg_folder_tile_name">{props.folder.name}</span>
            </div>
            <div
                class="mobile-only-menu-toggle"
                onClick={(event) => {
                    event.stopPropagation();
                    setMenuOpen(!menuOpen());
                }}
            >
                <i class="fa-solid fa-ellipsis-vertical" />
            </div>
            <div class="bg_folder_tile_menu jg-menu">
                <div
                    class="jg-button fa-solid fa-pen-to-square fa-fw pointer"
                    attr:data-action="rename-folder"
                    title={props.t('Rename folder')}
                    onClick={(event) => {
                        event.stopPropagation();
                        props.onRename(props.folder);
                    }}
                />
                <div
                    class="jg-button fa-solid fa-trash-can fa-fw pointer"
                    attr:data-action="delete-folder"
                    title={props.t('Delete folder')}
                    onClick={(event) => {
                        event.stopPropagation();
                        props.onDelete(props.folder);
                    }}
                />
            </div>
        </div>
    );
}
