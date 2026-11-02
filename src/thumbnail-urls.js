import { HASH } from './library-codes.js';

/**
 * @typedef {'avatar' | 'bg'} ThumbnailKind
 * @typedef {{ name: string, cover?: { w: number, h: number }, fit?: number }} ThumbnailSpec
 */

/** @type {Readonly<Record<ThumbnailKind, ThumbnailSpec>>} */
export const THUMBNAIL_SPECS = Object.freeze({
    avatar: { name: 'c120x180', cover: { w: 120, h: 180 } },
    bg: { name: 'f200', fit: 200 },
});

export const THUMBNAIL_QUALITY = 75;

const SPEC_BY_NAME = new Map(Object.values(THUMBNAIL_SPECS).map(s => [s.name, s]));
const NAME = /^([0-9a-f]{64})\.(?:([a-z0-9]+)\.webp|(anim))$/;

/**
 * @param {string} hex
 * @param {ThumbnailKind} kind
 */
export function stillUrl(hex, kind) {
    return `/thumbnail/${hex}.${THUMBNAIL_SPECS[kind].name}.webp`;
}

/**
 * @param {string} hex
 */
export function animatedUrl(hex) {
    return `/thumbnail/${hex}.anim`;
}

/**
 * @param {{ hashes?: { which: number, hash: Buffer }[] } | null | undefined} entity
 * @param {number} which
 * @returns {string | null}
 */
export function hashHex(entity, which) {
    const found = entity?.hashes?.find(h => h.which === which);
    return found ? Buffer.from(found.hash).toString('hex') : null;
}

/**
 * @param {{ hashes?: { which: number, hash: Buffer }[] } | null | undefined} entity
 * @param {ThumbnailKind} kind
 * @returns {string | null}
 */
export function thumbnailOf(entity, kind) {
    const still = hashHex(entity, HASH.avatarIdentity);
    return still === null ? null : stillUrl(still, kind);
}

/**
 * @param {{ hashes?: { which: number, hash: Buffer }[] } | null | undefined} entity
 * @returns {string | null}
 */
export function animatedOf(entity) {
    const animated = hashHex(entity, HASH.animated);
    return animated === null ? null : animatedUrl(animated);
}

/**
 * @param {string} name
 * @returns {{ hex: string, which: number, spec: ThumbnailSpec | null } | null}
 */
export function parseThumbnailName(name) {
    const match = NAME.exec(name);
    if (!match) return null;
    if (match[3]) return { hex: match[1], which: HASH.animated, spec: null };
    const spec = SPEC_BY_NAME.get(match[2]);
    return spec ? { hex: match[1], which: HASH.avatarIdentity, spec } : null;
}

const URL_NAME = /^\/thumbnail\/([0-9a-f]{64}\.(?:[a-z0-9]+\.webp|anim))$/;

/**
 * @param {unknown} url
 * @returns {{ hex: string, which: number, spec: ThumbnailSpec | null } | null}
 */
export function parseThumbnailUrl(url) {
    if (typeof url !== 'string') return null;
    const match = URL_NAME.exec(url);
    return match ? parseThumbnailName(match[1]) : null;
}
