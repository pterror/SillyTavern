/**
 * Logical open/closed state for #right-nav-panel's mutually-exclusive menu panels (character list,
 * character create/edit, group chat edit, settings, etc). Only one panel is ever *visible* at a time -
 * script.js's selectRightMenuWithAnimation() enforces that in the DOM, because with panel translucency
 * enabled two overlapping panels blend into an unreadable mess. But "visible" and "open" are different
 * things: switching the visible panel away from, say, the character create/edit panel does not erase
 * whatever the user was typing there - the DOM keeps the field values (display:none doesn't destroy
 * elements) - so the create panel is still logically "open" underneath, just not the one currently shown.
 *
 * This module is the explicit, queryable version of that distinction. openRightMenu() marks a panel open
 * (call it whenever a panel becomes the visible one - being visible implies being open). closeRightMenu()
 * is for the different, rarer case where a panel's underlying data actually stopped being valid (e.g. the
 * character it was editing got deleted, or the chat was closed) and it should NOT be considered open
 * anymore even though nothing is currently switching away from it.
 *
 * Dependency-free by design (no jQuery/DOM, no other app modules) so it stays importable in a plain Node
 * test environment - see tests/right-menu-state.test.js.
 */

const openMenus = new Set();

/** Strips a leading '#' so callers can pass either a bare id or a jQuery-style selector. */
function normalizeMenuId(menuId) {
    return String(menuId).replace(/^#/, '');
}

/**
 * Marks a right-nav-panel menu as logically open. Idempotent.
 * @param {string} menuId
 */
export function openRightMenu(menuId) {
    openMenus.add(normalizeMenuId(menuId));
}

/**
 * Marks a right-nav-panel menu as logically closed - distinct from merely being hidden behind whichever
 * menu is currently visible. Idempotent.
 * @param {string} menuId
 */
export function closeRightMenu(menuId) {
    openMenus.delete(normalizeMenuId(menuId));
}

/**
 * @param {string} menuId
 * @returns {boolean} Whether the menu is logically open (it may still be hidden behind the visible menu).
 */
export function isRightMenuOpen(menuId) {
    return openMenus.has(normalizeMenuId(menuId));
}

/** @returns {string[]} IDs of every currently-open menu. */
export function getOpenRightMenus() {
    return Array.from(openMenus);
}

/** Test-only: clears all tracked state. Not used by app code. */
export function resetRightMenuState() {
    openMenus.clear();
}
