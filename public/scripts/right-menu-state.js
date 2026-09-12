// Tracks "open" separately from "visible" - a panel switched away from can still be logically open.

const openMenus = new Set();

/** Strips a leading '#' so callers can pass either a bare id or a jQuery-style selector. */
function normalizeMenuId(menuId) {
    return String(menuId).replace(/^#/, '');
}

export function openRightMenu(menuId) {
    openMenus.add(normalizeMenuId(menuId));
}

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
