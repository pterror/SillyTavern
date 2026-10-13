/**
 * What a chat edit drops besides its messages: the bookmarks and the state changes that go with them, as the
 * server's preview answers them.
 * @typedef {{ bookmarks: { id: string, name: string | null }[], changes: { id: string, key: string | number, variable: boolean }[] }} Drops
 */

/** i18n's tagged template, passed by the caller so this module stays a leaf. @typedef {(strings: TemplateStringsArray, ...values: any[]) => string} Translate */

/** @param {Drops | undefined} drops */
export function hasDrops(drops) {
    return !!drops && (drops.bookmarks.length > 0 || drops.changes.length > 0);
}

/**
 * Each dropped thing as a line.
 * @param {Drops} drops
 * @param {Translate} t
 * @returns {string[]}
 */
export function dropLines(drops, t) {
    return [
        // Named as the chat picker names it: its label, else its compat id.
        ...drops.bookmarks.map(b => t`Bookmark: ${b.name ?? `b${b.id}`}`),
        ...drops.changes.map(c => (c.variable ? t`Chat variable: ${String(c.key)}` : t`Chat setting: ${String(c.key)}`)),
    ];
}

/**
 * The confirm to send for these drops: exactly their ids.
 * @param {Drops} drops
 */
export function confirmOf(drops) {
    return { bookmarks: drops.bookmarks.map(b => b.id), changes: drops.changes.map(c => c.id) };
}

/**
 * Asks whether to go on with an edit that drops these; true to go on.
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
 * Tells the user what an edit nobody could confirm (an extension's or a command's) dropped.
 * @param {Drops} drops
 * @param {Translate} t
 */
export function warnDropped(drops, t) {
    toastr.warning(dropLines(drops, t).join('\n'), t`Also deleted`, { timeOut: 0, extendedTimeOut: 0 });
}
