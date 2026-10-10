/**
 * `/query`'s hash-only mode (`want: ['hashes']`) answer, decoded.
 */

/**
 * Search-backend enum codes for `/query`'s binary hash-mode response - mirrors HASH_QUERY_SEARCH_BACKEND_CODES
 * server-side (src/endpoints/characters.js). 0 means "absent".
 */
const HASH_QUERY_SEARCH_BACKEND_NAMES = { 1: 'tantivy', 2: 'native', 3: 'wasm', 4: 'unavailable' };

/**
 * Decodes `/query`'s hash-only mode (`want: ['hashes']`) binary response. See
 * `serializeQueryHashesBinary()` server-side (src/endpoints/characters.js) for the matching encoder and the
 * field-by-field layout spec this just walks with a `DataView`.
 * @param {ArrayBuffer} buffer
 * @returns {{seq: number, token: string|null, total: number|undefined, totalApprox: boolean, hidden: number|undefined, hiddenApprox: boolean, searchBackend: string|undefined, more: boolean, cursor: string|undefined, tagMatches: {id: string, name: string, carriers: number}[]|undefined, tagMatchesExact: boolean|undefined, hashRows: {id:string, isGroup:boolean, version:number|null, favHash:number, tagIdsHash:number, contentHash:number, date_added:number, create_date:number|null, date_last_chat:number, chat_size:number, data_size:number, chat:string|null}[]}}
 */
export function deserializeQueryHashesBinary(buffer) {
    const view = new DataView(buffer);
    const decoder = new TextDecoder();
    let offset = 0;

    const headerFlags = view.getUint8(offset); offset += 1;
    const hasTotal = (headerFlags & 0b01) !== 0;
    const totalApprox = (headerFlags & 0b10) !== 0;
    const more = (headerFlags & 0b100) !== 0;
    const hasCursor = (headerFlags & 0b1000) !== 0;
    const hasTagMatches = (headerFlags & 0b10000) !== 0;
    const searchBackendCode = view.getUint8(offset); offset += 1;
    const searchBackend = HASH_QUERY_SEARCH_BACKEND_NAMES[searchBackendCode];
    const seq = view.getFloat64(offset, true); offset += 8;
    const total = view.getFloat64(offset, true); offset += 8;
    const rowCount = view.getUint16(offset, true); offset += 2;

    const hashRows = [];
    for (let i = 0; i < rowCount; i++) {
        const flags = view.getUint8(offset); offset += 1;
        const isGroup = (flags & 0b1) !== 0;
        const hasCreateDate = (flags & 0b10) !== 0;

        const idLen = view.getUint16(offset, true); offset += 2;
        const id = decoder.decode(new Uint8Array(buffer, offset, idLen)); offset += idLen;

        // A character's cache key is its version; a group's, its three digests.
        let version = null, favHash = 0, tagIdsHash = 0, contentHash = 0;
        if (isGroup) {
            favHash = view.getUint32(offset, true); offset += 4;
            tagIdsHash = view.getUint32(offset, true); offset += 4;
            contentHash = view.getUint32(offset, true); offset += 4;
        } else {
            version = view.getFloat64(offset, true); offset += 8;
        }

        const date_added = view.getFloat64(offset, true); offset += 8;
        const createDateRaw = view.getFloat64(offset, true); offset += 8;
        const date_last_chat = view.getFloat64(offset, true); offset += 8;
        const chat_size = view.getFloat64(offset, true); offset += 8;
        const data_size = view.getFloat64(offset, true); offset += 8;

        const chatLen = view.getUint16(offset, true); offset += 2;
        const chat = chatLen > 0 ? decoder.decode(new Uint8Array(buffer, offset, chatLen)) : null;
        offset += chatLen;

        hashRows.push({
            id, isGroup, version, favHash, tagIdsHash, contentHash,
            date_added, create_date: hasCreateDate ? createDateRaw : null, date_last_chat, chat_size, data_size, chat,
        });
    }

    // Trailer: tokenLen(2) + token(tokenLen, utf8); tokenLen 0 means a null token.
    const tokenLen = view.getUint16(offset, true); offset += 2;
    const token = tokenLen > 0 ? decoder.decode(new Uint8Array(buffer, offset, tokenLen)) : null;
    offset += tokenLen;

    let cursor;
    if (hasCursor) {
        const cursorLen = view.getUint16(offset, true); offset += 2;
        cursor = decoder.decode(new Uint8Array(buffer, offset, cursorLen));
        offset += cursorLen;
    }

    // Present with the header's tag-matches bit: exact(1) count(1), then per tag idLen(2) id nameLen(2) name carriers(8).
    let tagMatches;
    let tagMatchesExact;
    if (hasTagMatches) {
        tagMatchesExact = view.getUint8(offset) === 1; offset += 1;
        const count = view.getUint8(offset); offset += 1;
        tagMatches = [];
        for (let i = 0; i < count; i++) {
            const idLen = view.getUint16(offset, true); offset += 2;
            const id = decoder.decode(new Uint8Array(buffer, offset, idLen)); offset += idLen;
            const nameLen = view.getUint16(offset, true); offset += 2;
            const name = decoder.decode(new Uint8Array(buffer, offset, nameLen)); offset += nameLen;
            const carriers = view.getFloat64(offset, true); offset += 8;
            tagMatches.push({ id, name, carriers });
        }
    }

    // Present only when the request wanted 'hidden': hiddenFlags(1) [bit0=approx] + hidden(8).
    let hidden;
    let hiddenApprox = false;
    if (offset + 9 <= buffer.byteLength) {
        hiddenApprox = (view.getUint8(offset) & 0b1) !== 0; offset += 1;
        hidden = view.getFloat64(offset, true); offset += 8;
    }

    return { seq, token, total: hasTotal ? total : undefined, totalApprox, searchBackend, hashRows, hidden, hiddenApprox, more, cursor, tagMatches, tagMatchesExact };
}
