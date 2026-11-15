import { attachActions } from './new-ui-page.js';
import { nameNode } from './names.js';

let t = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => String.raw({ raw: strings }, ...values);

/**
 * @typedef {{ id: string, name: string, thing?: string }} ClosedFolder `thing`: its tag's, which its look is drawn by
 * @typedef {object} FolderSwitcherDeps
 * @property {() => string | null} getCase
 * @property {(folderCase: string) => void} setCase
 * @property {(term: string, cursor: string | null) => Promise<{ rows: ClosedFolder[], cursor: string | null } | null>} list
 * @property {(id: string) => Promise<ClosedFolder | null | undefined>} get
 */

/** @type {FolderSwitcherDeps | null} */
let deps = null;
/** @type {HTMLElement | null} */
let strip = null;
/** @type {HTMLElement | null} */
let popover = null;
/** @type {ClosedFolder[] | null} */
let firstPage = null;
let firstPageHasMore = false;
/** @type {ClosedFolder | null} */
let shownOutsideFirstPage = null;
let refreshRun = 0;

/**
 * @param {object} options
 * @param {HTMLElement} options.after
 * @param {FolderSwitcherDeps} options.deps
 * @param {typeof t} options.translate
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

/** @returns {{ name: string, thing?: string }} */
function shownLabel() {
    const shown = deps?.getCase() ?? 'none';
    if (shown === 'none') return { name: t`No folder` };
    return firstPage?.find(folder => folder.id === shown) ?? (shownOutsideFirstPage?.id === shown ? shownOutsideFirstPage : null) ?? { name: t`Folder` };
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
    strip.replaceChildren(caseChip({ id: 'none', name: t`No folder` }, shown === 'none'), ...firstPage.map(folder => caseChip(folder, shown === folder.id)));
    const overflows = strip.scrollWidth > strip.clientWidth + 1 || firstPageHasMore
        || (shown !== 'none' && !firstPage.some(folder => folder.id === shown));
    if (!overflows) return;
    strip.classList.add('folded');
    const button = document.createElement('div');
    button.className = 'menu_button folder_case_button';
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.setAttribute('aria-haspopup', 'listbox');
    const label = document.createElement('span');
    label.className = 'folder_case_label';
    const shownAs = shownLabel();
    label.append(nameNode(shownAs.thing, shownAs.name));
    button.title = t`Folder shown: ${shownAs.name}. Click to show another.`;
    const icon = document.createElement('i');
    icon.className = shown === 'none' ? 'fa-solid fa-folder-minus' : 'fa-solid fa-folder-closed';
    const caret = document.createElement('i');
    caret.className = 'fa-solid fa-caret-down';
    button.append(icon, label, caret);
    button.addEventListener('click', () => (popover ? closePopover() : void openPopover(button)));
    strip.replaceChildren(button);
}

/**
 * @param {ClosedFolder} folder
 * @param {boolean} current
 */
function caseChip({ id, name, thing }, current) {
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
    label.append(nameNode(thing, name));
    chip.append(icon, label);
    chip.title = id === 'none' ? t`Characters and groups in no closed folder` : t`What the closed folder "${name}" holds`;
    chip.addEventListener('click', () => choose(id));
    attachActions(chip, { activate: () => choose(id) });
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
    popover.popover = 'manual';
    popover.showPopover({ source: anchor });
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
        if (!more && !term) list.append(popoverRow({ id: 'none', name: t`No folder` }));
        for (const folder of page.rows) list.append(popoverRow(folder));
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
    attachActions(popover, {
        cancel: () => {
            closePopover();
            anchor.focus();
        },
    });
    search.focus();
    await load(false);
}

/** @param {ClosedFolder} folder */
function popoverRow({ id, name, thing }) {
    const row = document.createElement('div');
    row.className = 'view_picker_row';
    row.dataset.folderCase = id;
    row.setAttribute('role', 'option');
    const current = deps?.getCase() === id;
    row.setAttribute('aria-selected', String(current));
    row.classList.toggle('current', current);
    const label = document.createElement('span');
    label.className = 'view_picker_row_name';
    label.append(nameNode(thing, name));
    label.tabIndex = 0;
    label.addEventListener('click', () => choose(id));
    attachActions(label, { activate: () => choose(id) });
    row.append(label);
    return row;
}
