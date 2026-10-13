/**
 * The `extra` a client may send with a new user message (`user_message.extra` on a generate request), allowlisted
 * before it is stored or used in a prompt.
 */

const KNOWN_MEDIA_TYPES = ['image', 'video', 'audio'];
const KNOWN_MEDIA_SOURCES = ['api', 'upload', 'generated', 'captioned'];
// Defensive caps - a client asserting thousands of attachment entries onto a single message has no
// legitimate use case; this is not a hard product limit, just a sane bound on this one payload shape.
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
 * Allowlists/validates a CLIENT-SUPPLIED `extra` payload for a new user message before it is ever
 * persisted or handed to prompt assembly - the trust-boundary step `storedForm()` (chat-engine.js) does
 * NOT perform (that function protects storage/round-trip integrity for `extra` values the SERVER
 * itself already trusts, e.g. read back off disk or built from an already-validated tree row; this
 * function is the thing that decides whether a brand-new, client-asserted `extra` is safe to accept
 * in the first place).
 *
 * Real, narrow use case this exists for: the raw-action `/generate` routes (text-completion and
 * chat-completion) let the client forward a REFERENCE to a file/media attachment it already uploaded
 * via the existing `/api/files/upload`/`saveBase64AsFile()` flow (see public/scripts/chats.js's
 * `populateFileAttachment()`) - the client sends only `{url, ...}` metadata, never file bytes, but
 * that metadata is still attacker-controlled input from an authenticated client and must not be
 * stored/forwarded verbatim.
 *
 * Only the following shape survives; everything else (unknown top-level keys, wrong-typed fields,
 * malformed array entries) is silently dropped rather than rejected outright, matching this
 * codebase's general "a bad/foreign field doesn't fail the whole request" stance (see e.g.
 * `resolveName2AndGroupMemberNames()`'s own "a missing/corrupt file is skipped, not fatal" doc
 * comment elsewhere in this codebase):
 * - `files`: array of `{url: string, size?: number, name?: string, created?: number}` - entries
 *   missing a non-empty string `url`, or with a wrong-typed optional field, are dropped whole rather
 *   than partially kept (a half-validated entry is not obviously safer than dropping it).
 * - `media`: array of `{url: string, type?: 'image'|'video'|'audio', title?: string,
 *   source?: 'api'|'upload'|'generated'|'captioned'}` - entries missing a non-empty string `url`, or
 *   with a `type`/`source` outside the known enum, are dropped whole.
 * - `media_index`: a non-negative integer strictly less than the (already-filtered) `media` array's
 *   length - out-of-range or non-integer values are dropped (omitted) rather than clamped, since a
 *   clamped index would silently point at a different attachment than the one the client meant.
 * - `inline_image`: boolean.
 * Both arrays are capped at `MAX_USER_MESSAGE_EXTRA_ENTRIES` entries (excess entries dropped from the
 * end) - a defensive bound, not a documented product limit.
 *
 * @param {unknown} extra Raw, untrusted value from the request body (may be anything - not assumed
 *   to already be an object).
 * @returns {SanitizedUserMessageExtra} A fresh object containing only the validated fields above.
 *   Never throws; a completely invalid input yields `{}`.
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
