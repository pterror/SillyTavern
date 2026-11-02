import { HASH } from './library-codes.js';

/**
 * @typedef {'avatar' | 'bg'} ThumbnailKind
 * @typedef {{ name: string, cover?: { w: number, h: number }, fit?: number }} ThumbnailSpec
 * @typedef {{ x: number, y: number, width: number, height: number }} Crop
 * @typedef {{ hex: string, which: number, spec: ThumbnailSpec, crop: Crop | null, animate: boolean }} ThumbnailName
 */

/** @type {Readonly<Record<ThumbnailKind, ThumbnailSpec>>} */
export const THUMBNAIL_SPECS = Object.freeze({
    avatar: { name: 'c120x180', cover: { w: 120, h: 180 } },
    bg: { name: 'f200', fit: 200 },
});

export const THUMBNAIL_QUALITY = 75;

export const CROP_FIELDS = Object.freeze(['ext:avatar_crop', 'crop']);

const SPEC_BY_NAME = new Map(Object.values(THUMBNAIL_SPECS).map(s => [s.name, s]));
const NAME = /^([sa])([0-9a-f]{64})\.([a-z0-9]+)\.(full|\d+-\d+-\d+-\d+)\.webp$/;

/**
 * @param {unknown} value
 * @returns {Crop | null}
 */
export function normalizeCrop(value) {
    if (!value || typeof value !== 'object') return null;
    const { x, y, width, height } = /** @type {Record<string, unknown>} */ (value);
    const parts = [x, y, width, height].map(n => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : NaN));
    if (parts.some(n => Number.isNaN(n) || n < 0) || parts[2] < 1 || parts[3] < 1) return null;
    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/**
 * @param {Crop | null} crop
 */
function cropToken(crop) {
    return crop ? `${crop.x}-${crop.y}-${crop.width}-${crop.height}` : 'full';
}

/**
 * @param {'s' | 'a'} which
 * @param {string} hex
 * @param {ThumbnailKind} kind
 * @param {Crop | null} crop
 */
function url(which, hex, kind, crop) {
    return `/thumbnail/${which}${hex}.${THUMBNAIL_SPECS[kind].name}.${cropToken(crop)}.webp`;
}

/**
 * @param {string} hex
 * @param {ThumbnailKind} kind
 * @param {Crop | null} [crop]
 */
export function stillUrl(hex, kind, crop = null) {
    return url('s', hex, kind, crop);
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
 * @param {{ values?: { field: string, json?: string }[] } | null | undefined} entity
 * @returns {Crop | null}
 */
export function cropOf(entity) {
    const value = entity?.values?.find(v => CROP_FIELDS.includes(v.field) && v.json !== undefined);
    if (!value?.json) return null;
    try {
        return normalizeCrop(JSON.parse(value.json));
    } catch {
        return null;
    }
}

/**
 * @typedef {{ thumbnail: string | null, thumbnail_still: string | null }} Thumbnails
 */

/**
 * @param {{ still: string | null, animated: string | null }} hashes
 * @param {ThumbnailKind} kind
 * @param {Crop | null} crop
 * @returns {Thumbnails}
 */
export function thumbnailsFor({ still, animated }, kind, crop) {
    const first = still === null ? null : url('s', still, kind, crop);
    if (animated !== null) return { thumbnail: url('a', animated, kind, crop), thumbnail_still: first };
    return { thumbnail: first, thumbnail_still: null };
}

/**
 * @param {string} hex
 * @param {ThumbnailKind} kind
 * @param {Crop | null} [crop]
 */
export function animatedUrl(hex, kind, crop = null) {
    return url('a', hex, kind, crop);
}

/**
 * @param {{ hashes?: { which: number, hash: Buffer }[], values?: { field: string, json?: string }[] } | null | undefined} entity
 * @param {ThumbnailKind} kind
 * @param {Crop | null} [crop]
 * @returns {Thumbnails}
 */
export function thumbnailsOf(entity, kind, crop = cropOf(entity)) {
    return thumbnailsFor({ still: hashHex(entity, HASH.avatarIdentity), animated: hashHex(entity, HASH.animated) }, kind, crop);
}

/**
 * @param {Record<string, unknown>} target
 * @param {Thumbnails} thumbnails
 * @param {string} [prefix]
 */
export function assignThumbnails(target, thumbnails, prefix = 'thumbnail') {
    target[prefix] = thumbnails.thumbnail;
    if (thumbnails.thumbnail_still !== null) target[`${prefix}_still`] = thumbnails.thumbnail_still;
    else delete target[`${prefix}_still`];
    return target;
}

/**
 * @param {string} name
 * @returns {ThumbnailName | null}
 */
export function parseThumbnailName(name) {
    const match = NAME.exec(name);
    if (!match) return null;
    const spec = SPEC_BY_NAME.get(match[3]);
    if (!spec) return null;
    const animated = match[1] === 'a';
    const crop = match[4] === 'full' ? null : normalizeCrop(Object.fromEntries(match[4].split('-').map((n, i) => [['x', 'y', 'width', 'height'][i], Number(n)])));
    if (match[4] !== 'full' && crop === null) return null;
    return { hex: match[2], which: animated ? HASH.animated : HASH.avatarIdentity, spec, crop, animate: animated };
}

const URL_NAME = /^\/thumbnail\/([sa][0-9a-f]{64}\.[a-z0-9]+\.[0-9a-z-]+\.webp)$/;

/**
 * @param {unknown} value
 * @returns {ThumbnailName | null}
 */
export function parseThumbnailUrl(value) {
    if (typeof value !== 'string') return null;
    const match = URL_NAME.exec(value);
    return match ? parseThumbnailName(match[1]) : null;
}
