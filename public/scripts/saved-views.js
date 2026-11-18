import { contentHashOf } from './hash-utils.js';
import { newUi, newUiStarted } from './new-ui-page.js';

let t = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => String.raw({ raw: strings }, ...values);

const CURRENT_ID_KEY = 'characterListViewId';
const CURRENT_NAME_KEY = 'characterListViewName';
const DRAFT_KEY = 'characterListViewDraft';
const KEPT_VIEW_KEY = 'characterListViewKept';
const PAGE_SIZE = 50;

/** @typedef {{ id: string, name: string, view: import('./character-view.js').CharacterView }} SavedView */

/**
 * @typedef {object} FolderReads
 * @property {(term: string, cursor: string | null) => Promise<{ rows: OpenFolder[], cursor: string | null } | null>} list
 * @property {(id: string) => Promise<OpenFolder | null | undefined>} get
 */

/**
 * @typedef {{ id: string, name: string, thing?: string }} OpenFolder `thing`: its tag's, which its look is drawn by
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

/** @type {OpenFolder[]} */
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

let picker = false;
let popover = false;
let currentName = '';

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
        folderCase: typeof view?.folderCase === 'string' && view.folderCase ? view.folderCase : 'none',
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

function publish() {
    if (!newUiStarted()) return;
    newUi().characterBrowser.controls.showSaved({
        current: currentId, name: currentId ? currentName || safeGet(CURRENT_NAME_KEY) || t`Saved view` : t`All characters`,
        dirty: restored && hasUnsavedViewChanges(), pending: pendingSwitch !== null, open: popover,
        filter: filterText, views: loaded.map(({ id, name }) => ({ id, name })), folders: loadedFolders,
        more: nextCursor !== null, moreFolders: foldersCursor !== null,
    });
}

export function refreshSavedViewState() {
    if (!deps || !picker) return;
    if (restored) safeSet(DRAFT_KEY, hasUnsavedViewChanges() ? JSON.stringify({ id: currentId, view: deps.getView() }) : null);
    publish();
}

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
    currentName = currentId ? name ?? safeGet(CURRENT_NAME_KEY) ?? t`Saved view` : t`All characters`;
    publish();
}

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

async function readFolders(more) {
    const term = filterText;
    const page = await deps.folders.list(term, more ? foldersCursor : null);
    if (term !== filterText) return true;
    if (!page) return false;
    loadedFolders = more ? [...loadedFolders, ...page.rows] : page.rows;
    foldersCursor = page.cursor;
    return true;
}

/** @param {boolean} more */
async function readViews(more) {
    const sameList = !more && listedFilter === filterText && firstPageOnly;
    const term = filterText;
    const answer = await call('list', { contains: term, limit: PAGE_SIZE, cursor: more ? nextCursor : undefined, known: sameList ? contentHashOf(loaded) : undefined });
    if (term !== filterText) return true;
    if (!answer || answer.notFound) return false;
    listedFilter = term;
    if (answer.unchanged) return true;
    loaded = more ? [...loaded, ...answer.views] : answer.views;
    nextCursor = answer.cursor ?? null;
    firstPageOnly = !more;
    const current = loaded.find(view => view.id === currentId);
    if (current) setCurrent(current.id, current.name);
    return true;
}

async function moveView(saved, anchor, side) {
    const answer = await call('move', { id: saved.id, anchor: anchor.id, side });
    if (!answer || answer.notFound) toastr.error(t`The view could not be moved.`);
    await refreshPopover();
}

function drawUnsavedBar() {
    if (!hasUnsavedViewChanges()) pendingSwitch = null;
    publish();
}

function closePopover() {
    popover = false;
    pendingSwitch = null;
    publish();
}

async function refreshPopover() {
    const [views, folders] = await Promise.all([readViews(false), readFolders(false)]);
    if (!views) toastr.error(t`Views could not be loaded.`);
    if (!folders) toastr.error(t`Folders could not be loaded.`);
    publish();
}

function finishSwitch() {
    const target = pendingSwitch?.target ?? null;
    pendingSwitch = null;
    closePopover();
    applyView(target);
}

export function savedViewsUi() {
    return {
        async open() { popover = true; publish(); await refreshPopover(); },
        close: closePopover,
        choose(id) {
            let target = null;
            if (id?.startsWith(FOLDER_VIEW_PREFIX)) {
                const folder = loadedFolders.find(folder => `${FOLDER_VIEW_PREFIX}${folder.id}` === id);
                if (!folder) return;
                target = folderView(folder);
            } else if (id !== null) {
                target = loaded.find(view => view.id === id);
                if (!target) return;
            }
            switchTo(target);
        },
        async search(term) { filterText = term.trim(); await refreshPopover(); },
        async more(folders) { if (folders) await readFolders(true); else await readViews(true); publish(); },
        async save(name) {
            if (name === undefined) {
                if (await saveCurrent() && pendingSwitch) finishSwitch();
                return;
            }
            if (!name.trim()) return;
            const answer = await call('create', { name: name.trim(), view: deps.getView() });
            if (!answer || answer.notFound) { toastr.error(t`The view could not be saved.`); return; }
            appliedView = fullView(answer.view);
            setCurrent(answer.id, answer.name);
            deps.pinView(answer.id, appliedView);
            refreshSavedViewState();
            const target = pendingSwitch ? pendingSwitch.target : undefined;
            pendingSwitch = null;
            closePopover();
            if (target !== undefined) applyView(target);
        },
        discard() { if (pendingSwitch) finishSwitch(); else discardChanges(); },
        keep() { pendingSwitch = null; closePopover(); },
        async rename(id, name) {
            if (!name) return;
            const answer = await call('change', { id, name });
            if (!answer || answer.notFound) toastr.error(t`The view could not be renamed.`);
            else if (id === currentId) setCurrent(id, answer.name);
            await refreshPopover();
        },
        async remove(id) {
            const answer = await call('delete', { id });
            if (!answer) toastr.error(t`The view could not be deleted.`);
            else { deps.pinView(id, null); if (id === currentId) setCurrent(null, t`All characters`); }
            await refreshPopover();
        },
        async move(id, direction) {
            const index = loaded.findIndex(view => view.id === id);
            const saved = loaded[index], anchor = loaded[index + direction];
            if (saved && anchor) await moveView(saved, anchor, direction < 0 ? 'before' : 'after');
        },
    };
}

export function initSavedViews({ getView, setView, sameView, headers, storage, translate, folders, pinView }) {
    t = translate;
    deps = { getView, setView, sameView, headers, storage, folders, pinView };
    picker = true;
    window.addEventListener('pagehide', () => refreshSavedViewState());
    drawPicker();
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

