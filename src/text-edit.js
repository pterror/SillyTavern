/** Text edits as the engine records them (`textEdit`): offsets and lengths in WTF-8 bytes. */

/**
 * Bytes of `text` in WTF-8 (UTF-8 with lone surrogates encoded as their code points), the unit of a text edit.
 * @param {string} text
 */
export function wtf8Length(text) {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
            n += 4;
            i++;
        } else n += 3;
    }
    return n;
}

/**
 * The one edit turning `before` into `after`: what lies between their common start and end, never splitting a
 * surrogate pair.
 * @param {string} before
 * @param {string} after
 * @returns {{ offset: number, removed: number, text: string }} WTF-8 byte offset and length.
 */
export function textEdit(before, after) {
    const max = Math.min(before.length, after.length);
    let start = 0;
    while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
    if (start > 0 && (before.charCodeAt(start - 1) & 0xfc00) === 0xd800) start--;
    let end = 0;
    while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
    if (end > 0 && (before.charCodeAt(before.length - end) & 0xfc00) === 0xdc00) end--;
    return {
        offset: wtf8Length(before.slice(0, start)),
        removed: wtf8Length(before.slice(start, before.length - end)),
        text: after.slice(start, after.length - end),
    };
}
