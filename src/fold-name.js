/**
 * @param {unknown} name
 * @returns {string}
 */
export function foldName(name) {
    return String(name ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '');
}
