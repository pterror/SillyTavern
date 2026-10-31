const openMenus = new Set();

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
 * @returns {boolean}
 */
export function isRightMenuOpen(menuId) {
    return openMenus.has(normalizeMenuId(menuId));
}

/** @returns {string[]} */
export function getOpenRightMenus() {
    return Array.from(openMenus);
}

export function resetRightMenuState() {
    openMenus.clear();
}
