import { TYPE } from './library-codes.js';
import { CROP_FIELDS, parseThumbnailUrl, thumbnailsOf } from './thumbnail-urls.js';

const NONE = Object.freeze({ fields: [...CROP_FIELDS], lists: [] });
export const SHOWN = 'force_avatar_url';
export const SHOWN_STILL = 'force_avatar_url_still';
/** @type {Readonly<Record<number, string>>} */
const NO_IMAGE = Object.freeze({ [TYPE.character]: 'img/ai4.png', [TYPE.personaImage]: 'img/user-default.png' });
const REF = /^\/thumbnail\?(.+)$/;

/** @type {Readonly<Record<string, number>>} */
const TYPE_OF_KIND = Object.freeze({ avatar: TYPE.character, persona: TYPE.personaImage });
/** @type {ReadonlyMap<number, string>} */
const KIND_OF_TYPE = new Map(Object.entries(TYPE_OF_KIND).map(([kind, type]) => [type, kind]));

/**
 * @param {unknown} value
 * @returns {{ type: number, key: string } | null}
 */
export function avatarRef(value) {
    if (typeof value !== 'string') return null;
    const match = REF.exec(value);
    if (!match) return null;
    const query = new URLSearchParams(match[1]);
    const type = TYPE_OF_KIND[query.get('type') ?? ''];
    const key = query.get('file');
    return type === undefined || !key ? null : { type, key };
}

/**
 * @param {number} type
 * @param {string} key
 */
export function avatarRefString(type, key) {
    return `/thumbnail?type=${KIND_OF_TYPE.get(type)}&file=${encodeURIComponent(key)}`;
}

/**
 * @param {Record<string, any>[]} messages
 */
function refsIn(messages) {
    /** @type {Map<string, { type: number, key: string }>} */
    const refs = new Map();
    for (const m of messages) {
        const ref = avatarRef(m?.force_avatar);
        if (ref) refs.set(m.force_avatar, ref);
    }
    return refs;
}

/**
 * @param {Record<string, any>[]} messages
 * @param {Map<string, { type: number, key: string }>} refs
 * @param {(bigint | null)[]} ids
 * @param {any[]} entities
 */
function apply(messages, refs, ids, entities) {
    const byId = new Map(entities.filter(Boolean).map(e => [e.id, e]));
    /** @type {Map<string, { thumbnail: string, thumbnail_still: string | null }>} */
    const urls = new Map();
    [...refs.entries()].forEach(([value, ref], i) => {
        const shown = ids[i] === null ? null : thumbnailsOf(byId.get(ids[i]), 'avatar');
        urls.set(value, { thumbnail: shown?.thumbnail ?? NO_IMAGE[ref.type], thumbnail_still: shown?.thumbnail_still ?? null });
    });
    for (const m of messages) {
        const shown = typeof m?.force_avatar === 'string' ? urls.get(m.force_avatar) : undefined;
        if (shown === undefined) continue;
        m[SHOWN] = shown.thumbnail;
        if (shown.thumbnail_still) m[SHOWN_STILL] = shown.thumbnail_still;
        else delete m[SHOWN_STILL];
    }
    return messages;
}

/**
 * @param {any} store
 * @param {Record<string, any>[]} messages
 */
export async function resolveAvatars(store, messages) {
    const refs = refsIn(messages);
    if (refs.size === 0) return messages;
    const ids = await store.libraryIds([...refs.values()].map(r => [r.type, r.key]));
    const present = ids.filter((/** @type {bigint | null} */ id) => id !== null);
    return apply(messages, refs, ids, present.length ? await store.libraryEntities(present, NONE) : []);
}

/**
 * @param {Record<string, any>} message
 * @returns {Record<string, any>}
 */
export function withoutShownAvatar(message) {
    if (parseThumbnailUrl(message?.force_avatar) !== null) throw new ShownAvatarError();
    if (!message || !(SHOWN in message || SHOWN_STILL in message)) return message;
    const stored = { ...message };
    delete stored[SHOWN];
    delete stored[SHOWN_STILL];
    return stored;
}

export class ShownAvatarError extends Error {
    constructor() {
        super('force_avatar is the reference the message was given, not the thumbnail shown for it');
    }
}
