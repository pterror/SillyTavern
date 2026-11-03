/**
 * @param {string} avatar
 * @returns {string}
 */
export function avatarFolderName(avatar) {
    return avatar.replace(/\.[^/.]+$/, '');
}

/**
 * @param {string} folderName avatarFolderName() of the character's avatar
 * @param {unknown} overrides extension_settings.expressionOverrides
 * @returns {string}
 */
export function spriteFolderOf(folderName, overrides) {
    const override = Array.isArray(overrides) ? overrides.find(e => e?.name == folderName) : undefined;
    return override?.path || folderName;
}
