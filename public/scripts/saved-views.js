import { contentHashOf } from './hash-utils.js';

let t = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => String.raw({ raw: strings }, ...values);

const CURRENT_ID_KEY = 'characterListViewId';
const CURRENT_NAME_KEY = 'characterListViewName';
const DRAFT_KEY = 'characterListViewDraft';
const KEPT_VIEW_KEY = 'characterListViewKept';
const PAGE_SIZE = 50;

/** @typedef {{ id: string, name: string, view: import('./character-view.js').CharacterView }} SavedView */

/**
 * @typedef {object} FolderReads
 * @property {(term: string, cursor: string | null) => Promise<{ rows: { id: string, name: string }[], cursor: string | null } | null>} list
 * @property {(id: string) => Promise<{ id: string, name: string } | null | undefined>} get
 */

/** @type {{ getView: () => import('./character-view.js').CharacterView, setView: (view: import('./character-view.js').CharacterView) => void, sameView: (a: any, b: any) => boolean, headers: () => Record<string, string>, storage: { getItem(key: string): string|null, setItem(key: string, value: string): void, removeItem(key: string): void }, folders: FolderReads, pinView: (id: string, view: import('./character-view.js').CharacterView | null) => void } | null} */
let deps = null;

const FOLDER_VIEW_PREFIX = 'folder:';

/** @param {string|null} id */
function isFolderViewId(id) {
    return typeof id === 'string' && id.startsWith(FOLDER_VIEW_PREFIX);
}

/**
 * @param {{ id: string, name: string }} folder
 * @returns {SavedView}
 */
function folderView(folder) {
    return { id: `${FOLDER_VIEW_PREFIX}${folder.id}`, name: folder.name, view: fullView({ tags: { include: [folder.id] } }) };
}

/** @type {{ id: string, name: string }[]} */
let loadedFolders = [];
let foldersCursor = /** @type {string|null} */ (null);

/** @type {string|null} */
let currentId = null;
let appliedView = null;
/** @type {{ target: SavedView|null }|null} */
let pendingSwitch = null;
let restored = false;
let keptApplied = /** @type {SavedView|null} */ (null);
let draftAtLoad = /** @type {{ id: string|null, view: object } | null} */ (null);
let draftShownAtLoad = false;
/** @type {SavedView[]} */
let loaded = [];
let nextCursor = /** @type {string|null} */ (null);
let firstPageOnly = false;
let listedFilter = '';
let filterText = '';

/** @type {HTMLElement|null} */
let picker = null;
/** @type {HTMLElement|null} */
let popover = null;
/** @type {{ id: string, row: HTMLElement, index: number } | null} */
let editing = null;

/**
 * @param {string} route
 * @param {object} body
 * @returns {Promise<any>}
 */
async function call(route, body) {
    try {
        const response = await fetch(`/api/views/${route}`, { method: 'POST', headers: deps.headers(), body: JSON.stringify(body) });
        if (response.status === 404) return { notFound: true };
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.error(`[views] ${route} failed:`, error);
        return null;
    }
}

function safeGet(/** @type {string} */ key) {
    try {
        return deps.storage.getItem(key);
    } catch {
        return null;
    }
}

function safeSet(/** @type {string} */ key, /** @type {string|null} */ value) {
    try {
        if (value === null) deps.storage.removeItem(key);
        else deps.storage.setItem(key, value);
    } catch {
        // Not remembered across reloads.
    }
}

/** @param {any} view */
function fullView(view) {
    const current = deps.getView();
    return {
        text: typeof view?.text === 'string' ? view.text : '',
        conditions: Array.isArray(view?.conditions) ? view.conditions : [],
        tags: {
            include: Array.isArray(view?.tags?.include) ? view.tags.include : [],
            exclude: Array.isArray(view?.tags?.exclude) ? view.tags.exclude : [],
            mode: view?.tags?.mode === 'or' ? 'or' : 'and',
        },
        fav: typeof view?.fav === 'boolean' ? view.fav : undefined,
        group: typeof view?.group === 'boolean' ? view.group : undefined,
        ranges: view?.ranges && typeof view.ranges === 'object' ? view.ranges : undefined,
        sort: view?.sort && typeof view.sort === 'object' ? view.sort : current.sort,
        folderCase: current.folderCase === null ? null : (typeof view?.folderCase === 'string' && view.folderCase ? view.folderCase : 'none'),
    };
}

function allCharactersView() {
    return fullView({});
}

function baseView() {
    return currentId && appliedView ? appliedView : allCharactersView();
}

function hasUnsavedViewChanges() {
    return !!deps && !deps.sameView(deps.getView(), baseView());
}

export function refreshSavedViewState() {
    if (!deps || !picker || !restored) return;
    const dirty = hasUnsavedViewChanges();
    picker.classList.toggle('unsaved', dirty);
    picker.title = dirty
        ? t`Views: ${picker.querySelector('.view_picker_name').textContent}, with unsaved changes. Click to save or discard them.`
        : t`Views: ${picker.querySelector('.view_picker_name').textContent}. Click to switch or save one.`;
    safeSet(DRAFT_KEY, dirty ? JSON.stringify({ id: currentId, view: deps.getView() }) : null);
    if (popover) drawUnsavedBar();
}

/**
 * @param {string|null} id
 * @param {string} name
 */
function setCurrent(id, name) {
    currentId = id;
    safeSet(CURRENT_ID_KEY, id);
    safeSet(CURRENT_NAME_KEY, id ? name : null);
    keepCurrentView(name);
    drawPicker(name);
}

/**
 * @param {string} [name]
 */
function keepCurrentView(name = safeGet(CURRENT_NAME_KEY) ?? '') {
    safeSet(KEPT_VIEW_KEY, currentId && appliedView ? JSON.stringify({ id: currentId, name, view: appliedView }) : null);
}

/** @param {string} [name] */
function drawPicker(name) {
    if (!picker) return;
    const label = currentId ? (name ?? safeGet(CURRENT_NAME_KEY) ?? t`Saved view`) : t`All characters`;
    picker.querySelector('.view_picker_name').textContent = label;
    picker.dataset.viewId = currentId ?? '';
    picker.title = t`Views: ${label}. Click to switch or save one.`;
}

/**
 * @param {SavedView|null} saved
 */
function applyView(saved) {
    const view = saved ? fullView(saved.view) : allCharactersView();
    appliedView = saved ? view : null;
    setCurrent(saved ? saved.id : null, saved ? saved.name : t`All characters`);
    deps.setView(view);
    if (saved && !isFolderViewId(saved.id)) deps.pinView(saved.id, view);
    refreshSavedViewState();
}

/**
 * @param {SavedView|null} target
 */
function switchTo(target) {
    if ((target?.id ?? null) !== currentId && hasUnsavedViewChanges()) {
        pendingSwitch = { target };
        drawUnsavedBar();
        return;
    }
    closePopover();
    applyView(target);
}

/** @returns {Promise<boolean>} */
async function saveCurrent() {
    if (!currentId || isFolderViewId(currentId)) return false;
    const answer = await call('change', { id: currentId, view: deps.getView() });
    if (!answer || answer.notFound) {
        toastr.error(t`The view could not be saved.`);
        return false;
    }
    appliedView = fullView(answer.view);
    setCurrent(answer.id, answer.name);
    deps.pinView(answer.id, appliedView);
    refreshSavedViewState();
    return true;
}

function discardChanges() {
    deps.setView(baseView());
    refreshSavedViewState();
}

function drawUnsavedBar() {
    if (!popover) return;
    popover.querySelector('.view_picker_unsaved')?.remove();
    const dirty = hasUnsavedViewChanges();
    if (!dirty) pendingSwitch = null;
    if (!dirty) return;
    const bar = document.createElement('div');
    bar.className = 'view_picker_unsaved';
    const label = document.createElement('span');
    const name = currentId ? picker.querySelector('.view_picker_name').textContent : t`All characters`;
    label.textContent = pendingSwitch ? t`Unsaved changes to "${name}":` : t`Unsaved changes to "${name}"`;
    bar.append(label);
    /**
     * @param {string} text
     * @param {string} action
     * @param {() => void | Promise<void>} onClick
     */
    const button = (text, action, onClick) => {
        const b = document.createElement('div');
        b.className = 'menu_button';
        b.dataset.action = action;
        b.textContent = text;
        b.addEventListener('click', () => void onClick());
        bar.append(b);
    };
    const thenSwitch = () => {
        const target = pendingSwitch?.target ?? null;
        pendingSwitch = null;
        closePopover();
        applyView(target);
    };
    if (currentId && !isFolderViewId(currentId)) {
        button(t`Save`, 'save', async () => {
            if (await saveCurrent() && pendingSwitch) thenSwitch();
        });
    }
    if (pendingSwitch || isFolderViewId(currentId)) {
        button(t`Save as new`, 'save-as', () => {
            const input = popover.querySelector('.view_picker_save input');
            if (input instanceof HTMLInputElement) input.focus();
        });
    }
    button(t`Discard`, 'discard', () => {
        if (pendingSwitch) {
            thenSwitch();
            return;
        }
        discardChanges();
    });
    if (pendingSwitch) {
        button(t`Keep editing`, 'keep', () => {
            pendingSwitch = null;
            closePopover();
        });
    }
    popover.prepend(bar);
}

/** @param {boolean} more */
async function readFolders(more) {
    const page = await deps.folders.list(filterText, more ? foldersCursor : null);
    if (!page) return false;
    loadedFolders = more ? [...loadedFolders, ...page.rows] : page.rows;
    foldersCursor = page.cursor;
    return true;
}

/** @param {boolean} more */
async function readViews(more) {
    const sameList = !more && listedFilter === filterText && firstPageOnly;
    const answer = await call('list', { contains: filterText, limit: PAGE_SIZE, cursor: more ? nextCursor : undefined, known: sameList ? contentHashOf(loaded) : undefined });
    if (!answer || answer.notFound) return false;
    listedFilter = filterText;
    if (answer.unchanged) return true;
    loaded = more ? [...loaded, ...answer.views] : answer.views;
    nextCursor = answer.cursor ?? null;
    firstPageOnly = !more;
    const current = loaded.find(view => view.id === currentId);
    if (current) setCurrent(current.id, current.name);
    return true;
}

function closePopover() {
    popover?.remove();
    popover = null;
    editing = null;
    pendingSwitch = null;
}

/**
 * @param {SavedView|null} saved
 * @param {number} index
 */
function makeRow(saved, index) {
    const row = document.createElement('div');
    row.className = 'view_picker_row';
    row.dataset.viewId = saved?.id ?? '';
    if ((saved?.id ?? null) === currentId) row.classList.add('current');
    const name = document.createElement('span');
    name.className = 'view_picker_row_name';
    name.textContent = saved ? saved.name : t`All characters`;
    name.tabIndex = 0;
    name.setAttribute('role', 'button');
    name.addEventListener('click', () => switchTo(saved));
    name.addEventListener('keydown', event => {
        if (event.key === 'Enter') name.click();
    });
    row.append(name);
    if (!saved) return row;

    /**
     * @param {string} icon
     * @param {string} title
     * @param {string} action
     * @param {() => void} onClick
     */
    const button = (icon, title, action, onClick) => {
        const b = document.createElement('i');
        b.className = `fa-solid ${icon} view_picker_action`;
        b.title = title;
        b.dataset.action = action;
        b.tabIndex = 0;
        b.setAttribute('role', 'button');
        b.addEventListener('click', event => {
            event.stopPropagation();
            onClick();
        });
        return b;
    };
    const previous = loaded[index - 1];
    const following = loaded[index + 1];
    if (previous) row.append(button('fa-arrow-up', t`Move up`, 'up', () => void moveView(saved, previous, 'before')));
    if (following) row.append(button('fa-arrow-down', t`Move down`, 'down', () => void moveView(saved, following, 'after')));
    row.append(button('fa-pencil', t`Rename`, 'rename', () => startRename(row, saved, index)));
    row.append(button('fa-trash-can', t`Delete`, 'delete', () => confirmDelete(row, saved, index)));
    return row;
}

/**
 * @param {SavedView} saved
 * @param {SavedView} anchor
 * @param {'before'|'after'} side
 */
async function moveView(saved, anchor, side) {
    const answer = await call('move', { id: saved.id, anchor: anchor.id, side });
    if (!answer || answer.notFound) toastr.error(t`The view could not be moved.`);
    await refreshPopover();
}

/**
 * @param {HTMLElement} row
 * @param {SavedView} saved
 * @param {number} index
 */
function startRename(row, saved, index) {
    editing = { id: saved.id, row, index };
    row.replaceChildren();
    const input = document.createElement('input');
    input.className = 'text_pole textarea_compact view_picker_rename';
    input.value = saved.name;
    const finish = async (/** @type {boolean} */ keep) => {
        const name = input.value.trim();
        if (keep && name && name !== saved.name) {
            const answer = await call('change', { id: saved.id, name });
            if (!answer || answer.notFound) toastr.error(t`The view could not be renamed.`);
            else if (saved.id === currentId) setCurrent(saved.id, answer.name);
        }
        editing = null;
        await refreshPopover();
    };
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void finish(true);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            void finish(false);
        }
    });
    row.append(input);
    input.focus();
    input.select();
}

/**
 * @param {HTMLElement} row
 * @param {SavedView} saved
 * @param {number} index
 */
function confirmDelete(row, saved, index) {
    editing = { id: saved.id, row, index };
    row.replaceChildren();
    const text = document.createElement('span');
    text.textContent = t`Delete "${saved.name}"?`;
    const yes = document.createElement('div');
    yes.className = 'menu_button view_picker_confirm';
    yes.textContent = t`Delete`;
    const no = document.createElement('div');
    no.className = 'menu_button';
    no.textContent = t`Keep`;
    yes.addEventListener('click', async () => {
        const answer = await call('delete', { id: saved.id });
        if (!answer) toastr.error(t`The view could not be deleted.`);
        else {
            deps.pinView(saved.id, null);
            if (saved.id === currentId) setCurrent(null, t`All characters`);
        }
        editing = null;
        await refreshPopover();
    });
    no.addEventListener('click', () => {
        editing = null;
        void refreshPopover();
    });
    row.append(text, yes, no);
}

function makeSaveRow() {
    const row = document.createElement('div');
    row.className = 'view_picker_save';
    const input = document.createElement('input');
    input.className = 'text_pole textarea_compact';
    input.placeholder = t`Name for a new view`;
    const save = document.createElement('div');
    save.className = 'menu_button';
    save.textContent = t`Save as new view`;
    const submit = async () => {
        const name = input.value.trim();
        if (!name) {
            input.focus();
            return;
        }
        const view = deps.getView();
        const answer = await call('create', { name, view });
        if (!answer || answer.notFound) {
            toastr.error(t`The view could not be saved.`);
            return;
        }
        appliedView = fullView(answer.view);
        setCurrent(answer.id, answer.name);
        deps.pinView(answer.id, appliedView);
        refreshSavedViewState();
        const target = pendingSwitch ? pendingSwitch.target : undefined;
        pendingSwitch = null;
        closePopover();
        if (target !== undefined) applyView(target);
    };
    save.addEventListener('click', () => void submit());
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            closePopover();
            picker?.focus();
        }
    });
    row.append(input, save);
    return row;
}

function drawPopover() {
    if (!popover) return;
    const list = popover.querySelector('.view_picker_list');
    const focused = editing && editing.row.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement) : null;
    list.replaceChildren();
    if (!filterText) list.append(makeRow(null, -1));
    const rows = loaded.map((view, index) => (editing?.id === view.id ? editing.row : makeRow(view, index)));
    if (editing && !loaded.some(view => view.id === editing.id)) rows.splice(Math.min(editing.index, rows.length), 0, editing.row);
    list.append(...rows);
    focused?.focus();
    if (loaded.length === 0 && filterText) {
        const empty = document.createElement('div');
        empty.className = 'view_picker_empty';
        empty.textContent = t`No view has that name.`;
        list.append(empty);
    }
    if (nextCursor) {
        const more = document.createElement('div');
        more.className = 'menu_button view_picker_more';
        more.textContent = t`Show more`;
        more.addEventListener('click', async () => {
            if (await readViews(true)) drawPopover();
        });
        list.append(more);
    }
    if (loadedFolders.length === 0) return;
    const heading = document.createElement('div');
    heading.className = 'view_picker_heading';
    heading.textContent = t`Folders`;
    list.append(heading);
    for (const folder of loadedFolders) list.append(makeFolderRow(folder));
    if (foldersCursor) {
        const more = document.createElement('div');
        more.className = 'menu_button view_picker_more';
        more.textContent = t`Show more folders`;
        more.addEventListener('click', async () => {
            if (await readFolders(true)) drawPopover();
        });
        list.append(more);
    }
}

/**
 * @param {{ id: string, name: string }} folder
 */
function makeFolderRow(folder) {
    const saved = folderView(folder);
    const row = document.createElement('div');
    row.className = 'view_picker_row view_picker_folder';
    row.dataset.viewId = saved.id;
    if (saved.id === currentId) row.classList.add('current');
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-folder-open';
    const name = document.createElement('span');
    name.className = 'view_picker_row_name';
    name.textContent = folder.name;
    name.tabIndex = 0;
    name.setAttribute('role', 'button');
    name.addEventListener('click', () => switchTo(saved));
    name.addEventListener('keydown', event => {
        if (event.key === 'Enter') name.click();
    });
    row.append(icon, name);
    return row;
}

async function refreshPopover() {
    const [views, folders] = await Promise.all([readViews(false), readFolders(false)]);
    if (!views) toastr.error(t`Views could not be loaded.`);
    if (!folders) toastr.error(t`Folders could not be loaded.`);
    drawPopover();
}

async function openPopover() {
    closePopover();
    popover = document.createElement('div');
    popover.className = 'view_pill_popover view_picker_popover';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole textarea_compact';
    search.placeholder = t`Find a view`;
    search.value = filterText;
    let timer = 0;
    search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => {
            filterText = search.value.trim();
            void refreshPopover();
        }, 150);
    });
    search.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closePopover();
            picker?.focus();
        }
    });
    const list = document.createElement('div');
    list.className = 'view_picker_list';
    popover.append(search, list, makeSaveRow());
    document.body.append(popover);
    const box = picker.getBoundingClientRect();
    popover.style.left = `${Math.max(4, Math.min(box.left, window.innerWidth - popover.offsetWidth - 4))}px`;
    popover.style.top = `${box.bottom + 4}px`;
    search.focus();
    drawUnsavedBar();
    await refreshPopover();
}

export async function onSavedViewsChanged() {
    if (!deps) return;
    if (popover) await refreshPopover();
    if (!currentId || isFolderViewId(currentId)) return;
    const answer = await call('get', { id: currentId });
    if (!answer) return;
    if (answer.notFound) {
        deps.pinView(currentId, null);
        appliedView = null;
        setCurrent(null, t`All characters`);
        refreshSavedViewState();
        toastr.info(t`The view you were using was deleted.`);
        return;
    }
    const saved = fullView(answer.view);
    setCurrent(answer.id, answer.name);
    if (appliedView && !deps.sameView(appliedView, saved)) {
        const unchanged = deps.sameView(appliedView, deps.getView());
        appliedView = saved;
        keepCurrentView(answer.name);
        deps.pinView(answer.id, saved);
        if (unchanged) deps.setView(saved);
    }
    refreshSavedViewState();
}

/**
 * @param {object} options
 * @param {HTMLElement} options.before
 * @param {() => import('./character-view.js').CharacterView} options.getView
 * @param {(view: import('./character-view.js').CharacterView) => void} options.setView
 * @param {(a: any, b: any) => boolean} options.sameView
 * @param {() => Record<string, string>} options.headers
 * @param {{ getItem(key: string): string|null, setItem(key: string, value: string): void, removeItem(key: string): void }} options.storage
 * @param {typeof t} options.translate
 * @param {FolderReads} options.folders
 * @param {(id: string, view: import('./character-view.js').CharacterView | null) => void} options.pinView
 */
export function initSavedViews({ before, getView, setView, sameView, headers, storage, translate, folders, pinView }) {
    document.addEventListener('pointerdown', event => {
        if (popover && event.target instanceof Node && !popover.contains(event.target) && !picker?.contains(event.target)) closePopover();
    }, true);
    t = translate;
    deps = { getView, setView, sameView, headers, storage, folders, pinView };
    picker = document.createElement('div');
    picker.id = 'character_view_picker';
    picker.className = 'menu_button view_picker';
    picker.tabIndex = 0;
    picker.setAttribute('role', 'button');
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-layer-group';
    const name = document.createElement('span');
    name.className = 'view_picker_name';
    picker.append(icon, name);
    picker.addEventListener('click', () => (popover ? closePopover() : void openPopover()));
    picker.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            picker.click();
        }
    });
    before.before(picker);
    window.addEventListener('pagehide', () => refreshSavedViewState());
    drawPicker();
}

export function applyKeptView() {
    if (!deps) return;
    currentId = safeGet(CURRENT_ID_KEY);
    draftAtLoad = readDraft();
    const kept = readKeptView();
    if (kept && kept.id === currentId) {
        keptApplied = kept;
        applyView(kept);
    } else {
        drawPicker();
    }
    if (draftAtLoad && draftAtLoad.id === currentId) {
        draftShownAtLoad = true;
        deps.setView(fullView(draftAtLoad.view));
    }
}

/** @returns {SavedView|null} */
function readKeptView() {
    try {
        const kept = JSON.parse(safeGet(KEPT_VIEW_KEY) ?? 'null');
        return kept && typeof kept.id === 'string' && kept.view && typeof kept.view === 'object' ? kept : null;
    } catch {
        return null;
    }
}

export async function restoreCurrentView() {
    if (!deps) return;
    const draft = keptApplied || draftShownAtLoad ? draftAtLoad : readDraft();
    const showing = keptApplied;
    keptApplied = null;
    let reapplied = !draftShownAtLoad;
    draftShownAtLoad = false;
    const apply = (/** @type {SavedView} */ saved) => {
        if (showing && showing.id === saved.id && showing.name === saved.name && deps.sameView(fullView(showing.view), fullView(saved.view))) return;
        reapplied = true;
        applyView(saved);
    };
    if (isFolderViewId(currentId)) {
        const folder = await deps.folders.get(currentId.slice(FOLDER_VIEW_PREFIX.length));
        if (folder === undefined) {
            toastr.warning(t`The folder you were looking at could not be loaded. The list shows all characters until it can be.`);
            return;
        }
        restored = true;
        if (folder === null) setCurrent(null, t`All characters`);
        else apply(folderView(folder));
    } else if (currentId) {
        const answer = await call('get', { id: currentId });
        if (!answer) {
            toastr.warning(t`The view you were using could not be loaded. The list shows all characters until it can be.`);
            return;
        }
        restored = true;
        if (answer.notFound) {
            reapplied = true;
            applyView(null);
        } else {
            apply(answer);
        }
    }
    restored = true;
    if (reapplied && draft && draft.id === currentId) deps.setView(fullView(draft.view));
    refreshSavedViewState();
}

/** @returns {{ id: string|null, view: object } | null} */
function readDraft() {
    try {
        const draft = JSON.parse(safeGet(DRAFT_KEY) ?? 'null');
        return draft && typeof draft === 'object' && draft.view && typeof draft.view === 'object' ? { id: typeof draft.id === 'string' ? draft.id : null, view: draft.view } : null;
    } catch {
        return null;
    }
}

