/**
 * The character list's closed-folder switcher: "No folder" (everything no closed folder holds) and one case per
 * closed folder, shown above the list while "Tags as Folders" is on and some tag is a closed folder. The cases sit in
 * a strip while they fit on one row; past that the strip folds into one button opening a searchable, paged list.
 */

/** Translates a tagged template; the caller passes i18n's `t`, so this module stays a leaf. */
let t = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => String.raw({ raw: strings }, ...values);

/**
 * @typedef {{ id: string, name: string }} ClosedFolder
 * @typedef {object} FolderSwitcherDeps
 * @property {() => string | null} getCase The case shown: 'none', a closed folder's tag id, or null while "Tags as
 *   Folders" is off.
 * @property {(folderCase: string) => void} setCase Shows a case, as a change the user made.
 * @property {(term: string, cursor: string | null) => Promise<{ rows: ClosedFolder[], cursor: string | null } | null>} list
 *   A page of closed folders whose names hold `term`, in the tag sort order; null when the read failed.
 * @property {(id: string) => Promise<ClosedFolder | null | undefined>} get A closed folder by id: null when no closed
 *   folder has it, undefined when the read failed.
 */

/** @type {FolderSwitcherDeps | null} */
let deps = null;
/** @type {HTMLElement | null} */
let strip = null;
/** @type {HTMLElement | null} */
let popover = null;
/** The first page of closed folders, as last read; null before the first read. @type {ClosedFolder[] | null} */
let firstPage = null;
let firstPageHasMore = false;
/** The shown case's folder when it isn't on the first page. @type {ClosedFolder | null} */
let shownOutsideFirstPage = null;
/** Bumped by each refresh; an answer for an older one is dropped. */
let refreshRun = 0;

/**
 * Puts the switcher after `after` (hidden until a refresh finds closed folders).
 * @param {object} options
 * @param {HTMLElement} options.after
 * @param {FolderSwitcherDeps} options.deps
 * @param {typeof t} options.translate i18n's `t`.
 */
export function initFolderSwitcher({ after, deps: given, translate }) {
    document.addEventListener('pointerdown', event => {
        if (popover && event.target instanceof Node && !popover.contains(event.target) && !strip?.contains(event.target)) closePopover();
    }, true);
    t = translate;
    deps = given;
    strip = document.createElement('div');
    strip.id = 'character_folder_switcher';
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-label', t`Folders`);
    strip.hidden = true;
    after.after(strip);
    new ResizeObserver(() => draw()).observe(strip.parentElement ?? strip);
}

/**
 * Reads the closed folders again and redraws. A shown case whose folder is gone or no longer closed goes back to
 * "No folder".
 */
export async function refreshFolderSwitcher() {
    if (!deps || !strip) return;
    const run = ++refreshRun;
    const shown = deps.getCase();
    if (shown === null) {
        firstPage = null;
        closePopover();
        draw();
        return;
    }
    const page = await deps.list('', null);
    if (run !== refreshRun) return;
    if (page === null) {
        // The strip keeps what it showed; a failed read hides nothing that was there.
        return;
    }
    firstPage = page.rows;
    firstPageHasMore = page.cursor !== null;
    shownOutsideFirstPage = null;
    if (shown !== 'none' && !firstPage.some(folder => folder.id === shown)) {
        const folder = await deps.get(shown);
        if (run !== refreshRun) return;
        if (folder === null) {
            deps.setCase('none');
            return;
        }
        if (folder) shownOutsideFirstPage = folder;
    }
    draw();
}

/** The shown case's label. */
function shownLabel() {
    const shown = deps?.getCase() ?? 'none';
    if (shown === 'none') return t`No folder`;
    return firstPage?.find(folder => folder.id === shown)?.name ?? shownOutsideFirstPage?.name ?? t`Folder`;
}

function draw() {
    if (!deps || !strip) return;
    const shown = deps.getCase();
    if (shown === null || firstPage === null || firstPage.length === 0) {
        strip.hidden = true;
        strip.replaceChildren();
        return;
    }
    strip.hidden = false;
    strip.classList.remove('folded');
    strip.replaceChildren(caseChip('none', t`No folder`, shown === 'none'), ...firstPage.map(folder => caseChip(folder.id, folder.name, shown === folder.id)));
    // One row only: past it, or with more folders than one page, the strip folds into a button.
    const overflows = strip.scrollWidth > strip.clientWidth + 1 || firstPageHasMore
        || (shown !== 'none' && !firstPage.some(folder => folder.id === shown));
    if (!overflows) return;
    strip.classList.add('folded');
    const button = document.createElement('div');
    button.className = 'menu_button folder_case_button';
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.setAttribute('aria-haspopup', 'listbox');
    button.title = t`Folder shown: ${shownLabel()}. Click to show another.`;
    const icon = document.createElement('i');
    icon.className = shown === 'none' ? 'fa-solid fa-folder-minus' : 'fa-solid fa-folder-closed';
    const label = document.createElement('span');
    label.className = 'folder_case_label';
    label.textContent = shownLabel();
    const caret = document.createElement('i');
    caret.className = 'fa-solid fa-caret-down';
    button.append(icon, label, caret);
    button.addEventListener('click', () => (popover ? closePopover() : void openPopover(button)));
    button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            button.click();
        }
    });
    strip.replaceChildren(button);
}

/**
 * One case in the strip.
 * @param {string} id
 * @param {string} name
 * @param {boolean} current
 */
function caseChip(id, name, current) {
    const chip = document.createElement('div');
    chip.className = 'folder_case';
    chip.dataset.folderCase = id;
    chip.tabIndex = 0;
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(current));
    chip.classList.toggle('current', current);
    const icon = document.createElement('i');
    icon.className = id === 'none' ? 'fa-solid fa-folder-minus' : 'fa-solid fa-folder-closed';
    const label = document.createElement('span');
    label.textContent = name;
    chip.append(icon, label);
    chip.title = id === 'none' ? t`Characters and groups in no closed folder` : t`What the closed folder "${name}" holds`;
    chip.addEventListener('click', () => choose(id));
    chip.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            choose(id);
        }
    });
    return chip;
}

/** @param {string} id */
function choose(id) {
    closePopover();
    if (!deps || deps.getCase() === id) return;
    deps.setCase(id);
    draw();
}

function closePopover() {
    popover?.remove();
    popover = null;
}

/** @param {HTMLElement} anchor */
async function openPopover(anchor) {
    closePopover();
    popover = document.createElement('div');
    popover.className = 'view_pill_popover folder_case_popover';
    popover.setAttribute('role', 'listbox');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole textarea_compact';
    search.placeholder = t`Find a folder`;
    const list = document.createElement('div');
    list.className = 'view_picker_list';
    popover.append(search, list);
    document.body.append(popover);
    const box = anchor.getBoundingClientRect();
    popover.style.left = `${Math.max(4, Math.min(box.left, window.innerWidth - popover.offsetWidth - 4))}px`;
    popover.style.top = `${box.bottom + 4}px`;

    const own = popover;
    let term = '';
    let cursor = /** @type {string | null} */ (null);
    let read = 0;
    /** @param {boolean} more */
    const load = async (more) => {
        const run = ++read;
        const page = await deps.list(term, more ? cursor : null);
        if (run !== read || popover !== own) return;
        if (!more) list.replaceChildren();
        list.querySelector('.view_picker_more')?.remove();
        if (page === null) {
            const failed = document.createElement('div');
            failed.className = 'view_picker_empty';
            failed.textContent = t`Folders could not be loaded.`;
            list.append(failed);
            return;
        }
        if (!more && !term) list.append(popoverRow('none', t`No folder`));
        for (const folder of page.rows) list.append(popoverRow(folder.id, folder.name));
        if (!more && page.rows.length === 0 && term) {
            const empty = document.createElement('div');
            empty.className = 'view_picker_empty';
            empty.textContent = t`No closed folder has that name.`;
            list.append(empty);
        }
        cursor = page.cursor;
        if (cursor) {
            const moreButton = document.createElement('div');
            moreButton.className = 'menu_button view_picker_more';
            moreButton.textContent = t`Show more`;
            moreButton.addEventListener('click', () => void load(true));
            list.append(moreButton);
        }
    };
    let timer = 0;
    search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => {
            term = search.value.trim();
            void load(false);
        }, 150);
    });
    popover.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closePopover();
            anchor.focus();
        }
    });
    search.focus();
    await load(false);
}

/**
 * @param {string} id
 * @param {string} name
 */
function popoverRow(id, name) {
    const row = document.createElement('div');
    row.className = 'view_picker_row';
    row.dataset.folderCase = id;
    row.setAttribute('role', 'option');
    const current = deps?.getCase() === id;
    row.setAttribute('aria-selected', String(current));
    row.classList.toggle('current', current);
    const label = document.createElement('span');
    label.className = 'view_picker_row_name';
    label.textContent = name;
    label.tabIndex = 0;
    label.addEventListener('click', () => choose(id));
    label.addEventListener('keydown', event => {
        if (event.key === 'Enter') choose(id);
    });
    row.append(label);
    return row;
}
