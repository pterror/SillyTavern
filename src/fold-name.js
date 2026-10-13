/**
 * NFKD-normalizes and strips combining marks so "É"/"e" sort and prefix-match the same as "é"/"e".
 * @param {unknown} name
 * @returns {string}
 */
export function foldName(name) {
    return String(name ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '');
}
