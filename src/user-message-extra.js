const KNOWN_MEDIA_TYPES = ['image', 'video', 'audio'];
const KNOWN_MEDIA_SOURCES = ['api', 'upload', 'generated', 'captioned'];
const MAX_USER_MESSAGE_EXTRA_ENTRIES = 50;

/**
 * @typedef {object} SanitizedFileEntry
 * @property {string} url
 * @property {number} [size]
 * @property {string} [name]
 * @property {number} [created]
 */
/**
 * @typedef {object} SanitizedMediaEntry
 * @property {string} url
 * @property {'image' | 'video' | 'audio'} [type]
 * @property {string} [title]
 * @property {'api' | 'upload' | 'generated' | 'captioned'} [source]
 */
/**
 * @typedef {object} SanitizedUserMessageExtra
 * @property {SanitizedFileEntry[]} [files]
 * @property {SanitizedMediaEntry[]} [media]
 * @property {number} [media_index]
 * @property {boolean} [inline_image]
 */

/**
 * @param {unknown} extra
 * @returns {SanitizedUserMessageExtra}
 */
export function sanitizeUserMessageExtra(extra) {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
        return {};
    }
    const raw = /** @type {Record<string, unknown>} */ (extra);

    /** @type {SanitizedUserMessageExtra} */
    const result = {};

    if (Array.isArray(raw.files)) {
        const files = /** @type {unknown[]} */ (raw.files)
            .slice(0, MAX_USER_MESSAGE_EXTRA_ENTRIES)
            .filter(/** @returns {file is Record<string, unknown> & { url: string }} */ file =>
                !!file && typeof file === 'object' && typeof (/** @type {any} */ (file).url) === 'string' && /** @type {any} */ (file).url.length > 0)
            .map(file => {
                /** @type {SanitizedFileEntry} */
                const entry = { url: file.url };
                if (typeof file.size === 'number' && Number.isFinite(file.size)) entry.size = file.size;
                if (typeof file.name === 'string') entry.name = file.name;
                if (typeof file.created === 'number' && Number.isFinite(file.created)) entry.created = file.created;
                return entry;
            });
        if (files.length) result.files = files;
    }

    if (Array.isArray(raw.media)) {
        const media = /** @type {unknown[]} */ (raw.media)
            .slice(0, MAX_USER_MESSAGE_EXTRA_ENTRIES)
            .filter(/** @returns {item is Record<string, unknown> & { url: string }} */ item =>
                !!item && typeof item === 'object' && typeof (/** @type {any} */ (item).url) === 'string' && /** @type {any} */ (item).url.length > 0
                && (/** @type {any} */ (item).type === undefined || KNOWN_MEDIA_TYPES.includes(/** @type {any} */ (item).type))
                && (/** @type {any} */ (item).source === undefined || KNOWN_MEDIA_SOURCES.includes(/** @type {any} */ (item).source)))
            .map(item => {
                /** @type {SanitizedMediaEntry} */
                const entry = { url: item.url };
                if (typeof item.type === 'string') entry.type = /** @type {SanitizedMediaEntry['type']} */ (item.type);
                if (typeof item.title === 'string') entry.title = item.title;
                if (typeof item.source === 'string') entry.source = /** @type {SanitizedMediaEntry['source']} */ (item.source);
                return entry;
            });
        if (media.length) result.media = media;
    }

    if (typeof raw.media_index === 'number' && Number.isInteger(raw.media_index)
        && raw.media_index >= 0 && Array.isArray(result.media) && raw.media_index < result.media.length) {
        result.media_index = raw.media_index;
    }

    if (typeof raw.inline_image === 'boolean') {
        result.inline_image = raw.inline_image;
    }

    return result;
}
