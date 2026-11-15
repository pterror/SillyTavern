import { isRefusal, sanitizeDeclaration, storedLook } from '@st/looks/look';
import { LOOK_FIELD, TAG_KEY_PREFIX } from './library-codes.js';

// Upstream's formatting of a tag: `color` paints its chip, `color2` its text.
const COLOR_PROPERTIES = Object.freeze({ color: 'background-color', color2: 'color' });

export const TAG_COLOR_KEYS = Object.freeze(Object.keys(COLOR_PROPERTIES));

// The fields upstream's colors were stored in before a tag's look held them.
export const TAG_COLOR_FIELDS = Object.freeze(TAG_COLOR_KEYS.map(key => `${TAG_KEY_PREFIX}${key}`));

/**
 * A tag's look with upstream's colors in its rest layer: each of `color` and `color2` that is a non-empty text becomes
 * a declaration; `over` says whether it replaces one the look sets (a value written now) or only fills a property the
 * look leaves unset (a value stored before the look was). A tag has no world, so only the app's fonts are allowed.
 * @param {unknown} stored the tag's look as stored
 * @param {Record<string, unknown>} colors holding `color` and `color2`, either or both
 * @param {{ over: boolean }} how
 * @returns {{ look: unknown, refused: number }} `look`: `stored` itself when no declaration changes it; `refused`: the
 * declarations the sanitizer didn't let in
 */
export function tagColorsIntoLook(stored, colors, { over }) {
    const look = storedLook(stored, new Set()).look ?? {};
    const layer = new Map((look.rest ?? []).map(d => [d.property, d.value]));
    let changed = false;
    let refused = 0;
    for (const [key, property] of Object.entries(COLOR_PROPERTIES)) {
        const value = colors[key];
        if (typeof value !== 'string' || value.trim() === '' || (!over && layer.has(property))) continue;
        const checked = sanitizeDeclaration(property, value, new Set());
        if (isRefusal(checked)) {
            refused++;
            continue;
        }
        if (layer.get(checked.property) === checked.value) continue;
        layer.delete(checked.property);
        layer.set(checked.property, checked.value);
        changed = true;
    }
    if (!changed) return { look: stored, refused };
    return { look: { ...look, rest: [...layer].map(([property, value]) => ({ property, value })) }, refused };
}

/**
 * The look a write of `tag` leaves the stored tag with: the colors still in its old fields go under its look, then the
 * colors `tag` carries over it.
 * @param {import('./entity-values.js').StoredEntity | null} stored
 * @param {Record<string, unknown>} tag
 * @returns {{ look: unknown, changed: boolean, refused: number }} `changed`: the look isn't the one stored
 */
export function tagLookWritten(stored, tag) {
    const valueOf = (/** @type {string} */ field) => {
        const json = stored?.values.find(v => v.field === field)?.json;
        return json === undefined || json === '' ? undefined : JSON.parse(json);
    };
    const before = valueOf(LOOK_FIELD);
    const kept = tagColorsIntoLook(before, Object.fromEntries(TAG_COLOR_KEYS.map((key, i) => [key, valueOf(TAG_COLOR_FIELDS[i])])), { over: false });
    const written = tagColorsIntoLook(kept.look, tag, { over: true });
    return { look: written.look, changed: written.look !== before, refused: kept.refused + written.refused };
}

/**
 * @param {Record<string, unknown>} tag
 * @returns {Record<string, unknown>} its fields but upstream's colors
 */
export function withoutTagColors(tag) {
    const rest = { ...tag };
    for (const key of TAG_COLOR_KEYS) delete rest[key];
    return rest;
}
