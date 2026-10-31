/** @typedef {{ bookmarks: { id: string, name: string | null }[], changes: { id: string, key: string | number, variable: boolean }[] }} Drops */

/** @typedef {(strings: TemplateStringsArray, ...values: any[]) => string} Translate */

/** @param {Drops | undefined} drops */
export function hasDrops(drops) {
    return !!drops && (drops.bookmarks.length > 0 || drops.changes.length > 0);
}

/**
 * @param {Drops} drops
 * @param {Translate} t
 * @returns {string[]}
 */
export function dropLines(drops, t) {
    return [
        ...drops.bookmarks.map(b => t`Bookmark: ${b.name ?? `b${b.id}`}`),
        ...drops.changes.map(c => (c.variable ? t`Chat variable: ${String(c.key)}` : t`Chat setting: ${String(c.key)}`)),
    ];
}

/**
 * @param {Drops} drops
 */
export function confirmOf(drops) {
    return { bookmarks: drops.bookmarks.map(b => b.id), changes: drops.changes.map(c => c.id) };
}

/**
 * @param {Drops} drops
 * @param {Translate} t
 * @returns {Promise<boolean>}
 */
export async function askToDrop(drops, t) {
    const { callGenericPopup, POPUP_TYPE } = await import('./popup.js');
    const list = document.createElement('ul');
    for (const line of dropLines(drops, t)) {
        const item = document.createElement('li');
        item.textContent = line;
        list.append(item);
    }
    const body = document.createElement('div');
    const lead = document.createElement('p');
    lead.textContent = t`This also deletes:`;
    body.append(lead, list);
    return !!await callGenericPopup(body, POPUP_TYPE.CONFIRM, '', { okButton: t`Delete`, cancelButton: t`Cancel` });
}

/**
 * @param {Drops} drops
 * @param {Translate} t
 */
export function warnDropped(drops, t) {
    toastr.warning(dropLines(drops, t).join('\n'), t`Also deleted`, { timeOut: 0, extendedTimeOut: 0 });
}
