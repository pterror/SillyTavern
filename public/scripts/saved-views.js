/**
 * The character list's saved views: a picker by the search box listing "All characters" and the user's views, which
 * are kept on the server (/api/views). Each change is one action on one view.
 */

/** Translates a tagged template; the caller passes i18n's `t`, so this module stays a leaf. */
let t = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => String.raw({ raw: strings }, ...values);

const CURRENT_ID_KEY = 'characterListViewId';
const CURRENT_NAME_KEY = 'characterListViewName';
const PAGE_SIZE = 50;

/**
 * @typedef {{ id: string, name: string, view: import('./character-view.js').CharacterView, updatedAt: number }} SavedView
 */

/** @type {{ getView: () => import('./character-view.js').CharacterView, setView: (view: import('./character-view.js').CharacterView) => void, sameView: (a: any, b: any) => boolean, headers: () => Record<string, string>, storage: { getItem(key: string): string|null, setItem(key: string, value: string): void, removeItem(key: string): void } } | null} */
let deps = null;

/** The saved view the list shows, or null for "All characters". @type {string|null} */
let currentId = null;
/** What the current view was when it was applied or read: the list differs from it once the user changes something. */
let appliedView = null;
/** The views read so far, in order, and where the next page starts. @type {SavedView[]} */
let loaded = [];
let nextCursor = /** @type {string|null} */ (null);
let listedVersion = /** @type {number|null} */ (null);
let listedFilter = '';
let filterText = '';

/** @type {HTMLElement|null} */
let picker = null;
/** @type {HTMLElement|null} */
let popover = null;

/**
 * @param {string} route
 * @param {object} body
 * @returns {Promise<any>} The answer, or null when the request failed.
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

/** A saved view object, with every field a view has. @param {any} view */
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
        folderCase: null,
    };
}

/** "All characters": no filters, the sort kept. */
function allCharactersView() {
    return fullView({});
}

/** @param {string|null} id @param {string} name */
function setCurrent(id, name) {
    currentId = id;
    safeSet(CURRENT_ID_KEY, id);
    safeSet(CURRENT_NAME_KEY, id ? name : null);
    drawPicker(name);
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
 * Shows a view in the list and makes it current.
 * @param {SavedView|null} saved null for "All characters".
 */
function applyView(saved) {
    const view = saved ? fullView(saved.view) : allCharactersView();
    appliedView = view;
    setCurrent(saved ? saved.id : null, saved ? saved.name : t`All characters`);
    deps.setView(view);
}

/** Reads the first page of views (or the next one), for the picker. @param {boolean} more */
async function readViews(more) {
    // The first page is asked for with the version it was read at, so an unchanged list isn't downloaded again.
    const sameList = !more && listedFilter === filterText && nextCursor === null && listedVersion !== null;
    const answer = await call('list', { contains: filterText, limit: PAGE_SIZE, cursor: more ? nextCursor : undefined, ifVersion: sameList ? listedVersion : undefined });
    if (!answer || answer.notFound) return false;
    listedFilter = filterText;
    if (answer.unchanged) return true;
    loaded = more ? [...loaded, ...answer.views] : answer.views;
    nextCursor = answer.cursor ?? null;
    listedVersion = answer.version;
    const current = loaded.find(view => view.id === currentId);
    if (current) setCurrent(current.id, current.name);
    return true;
}

function closePopover() {
    popover?.remove();
    popover = null;
}

document.addEventListener('pointerdown', event => {
    if (popover && event.target instanceof Node && !popover.contains(event.target) && !picker?.contains(event.target)) closePopover();
}, true);

/**
 * A row of the picker.
 * @param {SavedView|null} saved
 * @param {number} index Its place among the loaded views.
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
    name.addEventListener('click', () => {
        closePopover();
        applyView(saved);
    });
    name.addEventListener('keydown', event => {
        if (event.key === 'Enter') name.click();
    });
    row.append(name);
    if (!saved) return row;

    /** @param {string} icon @param {string} title @param {string} action @param {() => void} onClick */
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
    row.append(button('fa-pencil', t`Rename`, 'rename', () => startRename(row, saved)));
    row.append(button('fa-trash-can', t`Delete`, 'delete', () => confirmDelete(row, saved)));
    return row;
}

/** @param {SavedView} saved @param {SavedView} anchor @param {'before'|'after'} side */
async function moveView(saved, anchor, side) {
    const answer = await call('move', { id: saved.id, anchor: anchor.id, side });
    if (!answer || answer.notFound) toastr.error(t`The view could not be moved.`);
    await refreshPopover();
}

/** @param {HTMLElement} row @param {SavedView} saved */
function startRename(row, saved) {
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

/** @param {HTMLElement} row @param {SavedView} saved */
function confirmDelete(row, saved) {
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
        else if (saved.id === currentId) setCurrent(null, t`All characters`);
        await refreshPopover();
    });
    no.addEventListener('click', () => void refreshPopover());
    row.append(text, yes, no);
}

/** The "save the list as a new view" row. */
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
        closePopover();
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
    list.replaceChildren();
    if (!filterText) list.append(makeRow(null, -1));
    loaded.forEach((view, index) => list.append(makeRow(view, index)));
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
}

async function refreshPopover() {
    if (!(await readViews(false))) {
        toastr.error(t`Views could not be loaded.`);
    }
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
    await refreshPopover();
}

/**
 * Another tab or device changed the user's views: the picker reads them again, and when the view on screen was
 * changed elsewhere and the list still shows it as it was, the list shows the new version.
 */
export async function onSavedViewsChanged() {
    if (!deps) return;
    if (popover) await refreshPopover();
    if (!currentId) return;
    const answer = await call('get', { id: currentId });
    if (!answer) return;
    if (answer.notFound) {
        setCurrent(null, t`All characters`);
        toastr.info(t`The view you were using was deleted.`);
        return;
    }
    const saved = fullView(answer.view);
    setCurrent(answer.id, answer.name);
    if (appliedView && !deps.sameView(appliedView, saved) && deps.sameView(appliedView, deps.getView())) {
        appliedView = saved;
        deps.setView(saved);
    }
}

/**
 * Puts the view picker before the search box and restores the view that was in use.
 * @param {object} options
 * @param {HTMLElement} options.before The element the picker goes in front of.
 * @param {() => import('./character-view.js').CharacterView} options.getView
 * @param {(view: import('./character-view.js').CharacterView) => void} options.setView
 * @param {(a: any, b: any) => boolean} options.sameView
 * @param {() => Record<string, string>} options.headers
 * @param {{ getItem(key: string): string|null, setItem(key: string, value: string): void, removeItem(key: string): void }} options.storage
 * @param {typeof t} options.translate i18n's `t`.
 */
export function initSavedViews({ before, getView, setView, sameView, headers, storage, translate }) {
    t = translate;
    deps = { getView, setView, sameView, headers, storage };
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
    currentId = safeGet(CURRENT_ID_KEY);
    drawPicker();
}

/** Shows the saved view that was in use when the page was left, once the list can show views. */
export async function restoreCurrentView() {
    if (!deps || !currentId) return;
    const answer = await call('get', { id: currentId });
    if (!answer) return;
    if (answer.notFound) {
        setCurrent(null, t`All characters`);
        return;
    }
    applyView(answer);
}

/** The saved view the list shows, or null for "All characters". */
export function getCurrentSavedViewId() {
    return currentId;
}
