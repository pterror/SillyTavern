import { parseTimestamp } from './timestamps.js';

/**
 * A message as the engine stores it (build path 5b), and back: exactly what upstream's message object holds, so it
 * comes back byte for byte, each value its own record, at the fewest bytes.
 *
 * The append (`messageAppend`) holds the message's fixed values: its text (`mes`), the speaker by id with a name
 * only where it differs from the speaker's, the server's receive time, and `flags`, the shape of the fixed values
 * (engine/src/store/chat.rs). Every other top-level value and every `extra` key is a value of its own: a known key by
 * code, any other by its key. `send_date` and the generation times are deltas from the receive time where they are
 * ISO strings or numbers. The key order is one of three usual orders, else an order value of its own.
 */

/** Top-level keys' field codes; the engine reads `mes` to `gen_finished` and the time codes (chat.rs). */
export const TOP = Object.freeze({
    mes: 1,
    is_user: 2,
    is_system: 3,
    is_name: 4,
    name: 5,
    send_date: 6,
    extra: 7,
    gen_started: 8,
    gen_finished: 9,
    force_avatar: 12,
    original_avatar: 13,
    title: 14,
    persona: 15,
});

/**
 * Codes of values the writer keeps about a message: its order and `extra`'s; after a change, its shape, its speaker,
 * and that its name is the speaker's again (the append's own name aside); the times it read and number times.
 */
export const META = Object.freeze({
    order: 10,
    extraOrder: 11,
    flags: 16,
    nameFromSpeaker: 17,
    speaker: 18,
    sendAt: 20,
    genStartedAt: 21,
    genFinishedAt: 22,
    sendDateNum: 23,
    genStartedNum: 24,
    genFinishedNum: 25,
});

/** `extra`'s known keys' field codes. */
export const EXTRA = Object.freeze({
    api: 64,
    model: 65,
    reasoning: 66,
    reasoning_duration: 67,
    reasoning_signature: 68,
    reasoning_type: 69,
    isSmallSys: 70,
    bias: 71,
    display_text: 72,
    gen_id: 73,
    type: 74,
    media: 75,
    media_display: 76,
    media_index: 77,
    inline_image: 78,
    files: 79,
    image: 80,
    file: 81,
    title: 82,
    tool_invocations: 83,
    append_title: 84,
    swipeable: 85,
    image_swipes: 86,
    inline: 87,
});

const TOP_BY_CODE = new Map(Object.entries(TOP).map(([k, c]) => [c, k]));
const EXTRA_BY_CODE = new Map(Object.entries(EXTRA).map(([k, c]) => [c, k]));

/** Flag shifts (chat.rs `FLAG_*`). */
const F = Object.freeze({ isUser: 0, sendDate: 2, order: 4, isSystem: 6, mes: 8, extra: 10, name: 12, isName: 14, originalAvatar: 16, forceAvatar: 17 });

/** The usual key orders: a message the page sends, a reply the server stores, a reply upstream's page made. */
const ORDERS = Object.freeze([
    ['name', 'is_user', 'is_system', 'send_date', 'mes', 'extra', 'force_avatar', 'original_avatar'],
    ['name', 'is_user', 'mes', 'extra', 'send_date', 'gen_started', 'gen_finished', 'force_avatar', 'original_avatar'],
    ['extra', 'name', 'is_user', 'send_date', 'mes', 'title', 'gen_started', 'gen_finished', 'force_avatar', 'original_avatar'],
]);

/** `extra`'s usual key order: its known keys in code order, then the rest by name. */
const EXTRA_ORDER = Object.keys(EXTRA);

/** A key not known at the top level is stored with this first character; one in `extra` that starts with it or ESC, after ESC. */
const TOP_MARK = '\u0001';
const ESC = '\u0002';

/**
 * @param {string} key
 * @returns {number | string} The field a top-level key is stored under.
 */
export function topField(key) {
    return Object.hasOwn(TOP, key) ? TOP[/** @type {keyof typeof TOP} */ (key)] : TOP_MARK + key;
}

/**
 * @param {string} key
 * @returns {number | string} The field an `extra` key is stored under.
 */
export function extraField(key) {
    if (Object.hasOwn(EXTRA, key)) return EXTRA[/** @type {keyof typeof EXTRA} */ (key)];
    return key.startsWith(TOP_MARK) || key.startsWith(ESC) ? ESC + key : key;
}

/**
 * What a stored field is: a top-level key, an `extra` key, or one of the writer's own (`META`).
 * @param {number | string} field
 * @returns {{ top: string } | { extra: string } | { meta: number }}
 */
export function fieldKey(field) {
    if (typeof field === 'number') {
        if (TOP_BY_CODE.has(field)) return { top: /** @type {string} */ (TOP_BY_CODE.get(field)) };
        if (EXTRA_BY_CODE.has(field)) return { extra: /** @type {string} */ (EXTRA_BY_CODE.get(field)) };
        return { meta: field };
    }
    if (field.startsWith(TOP_MARK)) return { top: field.slice(1) };
    if (field.startsWith(ESC)) return { extra: field.slice(1) };
    return { extra: field };
}

/**
 * Whether `s` is exactly the ISO string of the time it names.
 * @param {unknown} s
 * @returns {s is string}
 */
function isCanonicalIso(s) {
    if (typeof s !== 'string') return false;
    const t = Date.parse(s);
    return Number.isFinite(t) && new Date(t).toISOString() === s;
}

/**
 * The order string of `keys` against the usual order `base` (each key present there in that order, then the rest by
 * name): one character per key, its place in that list plus one. Empty when `keys` already are in that order.
 * @param {string[]} keys
 * @param {readonly string[]} base
 */
function orderOf(keys, base) {
    const usual = [...base.filter(k => keys.includes(k)), ...keys.filter(k => !base.includes(k)).sort()];
    if (usual.every((k, i) => keys[i] === k)) return '';
    return keys.map(k => String.fromCharCode(usual.indexOf(k) + 1)).join('');
}

/**
 * `keys` in the order an order string (or the usual order, for '') gives.
 * @param {string[]} keys
 * @param {readonly string[]} base
 * @param {string} order
 */
function applyOrder(keys, base, order) {
    const usual = [...base.filter(k => keys.includes(k)), ...keys.filter(k => !base.includes(k)).sort()];
    if (order === '') return usual;
    return Array.from(order, c => usual[c.charCodeAt(0) - 1]);
}

/**
 * @typedef {object} Speaker
 * @property {bigint} id The character's entity id.
 * @property {string} name Its name now.
 * @property {{ until: number, name: string }[]} [renames] Names it had before, oldest first: a message sent before `until` (ms) shows the first such entry's `name`.
 * @property {string} avatar Its avatar (the entity's key).
 */

/**
 * The name a speaker's message sent at `time` shows: what it was called then.
 * @param {Speaker} speaker
 * @param {number} time
 */
export function speakerNameAt(speaker, time) {
    return speaker.renames?.find(r => time < r.until)?.name ?? speaker.name;
}

/**
 * @typedef {object} Encoded A message as the engine's values.
 * @property {number} flags
 * @property {string} text The append's text ('' when `mes` isn't a string).
 * @property {string | null} name The append's name: null when it is the speaker's (or not a string).
 * @property {bigint | null} speaker
 * @property {Map<number | string, string>} values Field → JSON.
 * @property {Map<number | string, number>} times Field → delta from the append's time.
 */

/**
 * The engine's values of a message, as stored today (upstream's message object after `sanitizeForStorage()`).
 * @param {Record<string, any>} message A plain JSON object (parsed from its stored JSON).
 * @param {number} time The append's time (ms).
 * @param {Speaker | null} speaker Who said it, by id, when known.
 * @returns {Encoded}
 */
export function encodeMessage(message, time, speaker) {
    let flags = 0;
    /** @type {Map<number | string, string>} */
    const values = new Map();
    /** @type {Map<number | string, number>} */
    const times = new Map();
    const has = (/** @type {string} */ k) => Object.hasOwn(message, k);
    const json = (/** @type {number | string} */ field, /** @type {unknown} */ v) => values.set(field, JSON.stringify(v));

    /**
     * @param {string} key
     * @param {number} shift
     * @param {[number, number, number]} states The flag states of false, true and absent.
     */
    const bool = (key, shift, [no, yes, absent]) => {
        if (!has(key)) flags |= absent << shift;
        else if (message[key] === true) flags |= yes << shift;
        else if (message[key] === false) flags |= no << shift;
        else {
            flags |= 3 << shift;
            json(topField(key), message[key]);
        }
    };
    bool('is_user', F.isUser, [0, 1, 2]);
    bool('is_system', F.isSystem, [1, 2, 0]);
    if (!has('is_name')) flags |= 0 << F.isName;
    else if (message.is_name === true) flags |= 1 << F.isName;
    else if (message.is_name === false) flags |= 2 << F.isName;
    else {
        flags |= 3 << F.isName;
        json(TOP.is_name, message.is_name);
    }

    // send_date: the receive time as a number or ISO string, a delta, or a JSON value with the time it reads as.
    if (!has('send_date')) flags |= 3 << F.sendDate;
    else if (message.send_date === time) flags |= 1 << F.sendDate;
    else if (isCanonicalIso(message.send_date) && Date.parse(message.send_date) === time) flags |= 2 << F.sendDate;
    else timeValue('send_date', TOP.send_date, META.sendDateNum, META.sendAt);

    for (const [key, code, num, at] of /** @type {const} */ ([['gen_started', TOP.gen_started, META.genStartedNum, META.genStartedAt], ['gen_finished', TOP.gen_finished, META.genFinishedNum, META.genFinishedAt]])) {
        if (has(key)) timeValue(key, code, num, at);
    }

    /**
     * @param {string} key
     * @param {number} code The field of its ISO delta or JSON value.
     * @param {number} num The field of its number delta.
     * @param {number} at The field of the time a JSON value reads as.
     */
    function timeValue(key, code, num, at) {
        const v = message[key];
        if (isCanonicalIso(v)) times.set(code, Date.parse(v) - time);
        else if (typeof v === 'number' && Number.isSafeInteger(v) && Number.isSafeInteger(v - time)) times.set(num, v - time);
        else {
            json(code, v);
            const parsed = v ? parseTimestamp(v) : 0;
            if (parsed > 0 && Number.isSafeInteger(parsed - time)) times.set(at, parsed - time);
        }
    }

    let text = '';
    if (!has('mes')) flags |= 1 << F.mes;
    else if (typeof message.mes === 'string') text = message.mes;
    else {
        flags |= 2 << F.mes;
        json(TOP.mes, message.mes);
    }

    let name = null;
    if (!has('name')) flags |= 1 << F.name;
    else if (typeof message.name !== 'string') {
        flags |= 2 << F.name;
        json(TOP.name, message.name);
    } else if (!speaker || speakerNameAt(speaker, time) !== message.name) name = message.name;

    if (speaker && message.original_avatar === speaker.avatar) flags |= 1 << F.originalAvatar;
    if (speaker && message.force_avatar === `/thumbnail?type=avatar&file=${encodeURIComponent(speaker.avatar)}`) flags |= 1 << F.forceAvatar;

    const extraKeys = [];
    if (!has('extra')) flags |= 1 << F.extra;
    else if (message.extra === null || typeof message.extra !== 'object' || Array.isArray(message.extra)) {
        flags |= 2 << F.extra;
        json(TOP.extra, message.extra);
    } else {
        for (const [k, v] of Object.entries(message.extra)) {
            extraKeys.push(k);
            json(extraField(k), v);
        }
        const order = orderOf(extraKeys, EXTRA_ORDER);
        if (order) values.set(META.extraOrder, JSON.stringify(order));
    }

    const keys = Object.keys(message);
    for (const k of keys) {
        if (['is_user', 'is_system', 'is_name', 'send_date', 'gen_started', 'gen_finished', 'mes', 'name', 'extra'].includes(k)) continue;
        if (k === 'original_avatar' && flags & (1 << F.originalAvatar)) continue;
        if (k === 'force_avatar' && flags & (1 << F.forceAvatar)) continue;
        json(topField(k), message[k]);
    }
    let usual = ORDERS.findIndex(base => orderOf(keys, base) === '');
    if (usual < 0) {
        usual = 3;
        values.set(META.order, JSON.stringify(orderOf(keys, ORDERS[0])));
    }
    flags |= usual << F.order;
    return { flags, text, name, speaker: speaker?.id ?? null, values, times };
}

/**
 * @typedef {object} Stored A message as `chatRead('messages')` answers it.
 * @property {bigint} id
 * @property {number} time
 * @property {number} flags
 * @property {bigint | null} speaker
 * @property {string | null} name
 * @property {{ field: number | string, text: string }[]} texts
 * @property {{ field: number | string, json: string }[]} values
 * @property {{ field: number | string, delta: number }[]} times
 */

/**
 * A stored message's upstream JSON, exactly as it was written.
 * @param {Stored} stored
 * @param {(id: bigint) => Speaker | null} speakerOf The speaker's name and avatar now.
 * @returns {string}
 */
export function decodeMessage(stored, speakerOf) {
    /** @type {Map<number | string, string>} */
    const values = new Map(stored.values.map(v => [v.field, v.json]));
    /** @type {Map<number | string, number>} */
    const times = new Map(stored.times.map(t => [t.field, t.delta]));
    const text = stored.texts.find(t => t.field === TOP.mes)?.text;
    const flags = values.has(META.flags) ? Number(JSON.parse(/** @type {string} */ (values.get(META.flags)))) : stored.flags;
    const speakerId = values.has(META.speaker) ? JSON.parse(/** @type {string} */ (values.get(META.speaker))) : stored.speaker;
    const speaker = speakerId === null || speakerId === undefined ? null : speakerOf(BigInt(speakerId));
    const state = (/** @type {number} */ shift) => (flags >>> shift) & 3;
    const bit = (/** @type {number} */ shift) => (flags >>> shift) & 1;
    /** @type {Map<string, string>} Top-level key → JSON. */
    const top = new Map();
    /** @type {Map<string, string>} */
    const extra = new Map();

    const boolState = (/** @type {string} */ key, /** @type {number} */ s, /** @type {[number, number, number]} */ [no, yes, absent]) => {
        if (s === absent) return;
        if (s === yes) top.set(key, 'true');
        else if (s === no) top.set(key, 'false');
        else top.set(key, /** @type {string} */ (values.get(topField(key))));
    };
    boolState('is_user', state(F.isUser), [0, 1, 2]);
    boolState('is_system', state(F.isSystem), [1, 2, 0]);
    const isName = state(F.isName);
    if (isName === 1) top.set('is_name', 'true');
    else if (isName === 2) top.set('is_name', 'false');
    else if (isName === 3) top.set('is_name', /** @type {string} */ (values.get(TOP.is_name)));

    const sendDate = state(F.sendDate);
    if (sendDate === 1) top.set('send_date', JSON.stringify(stored.time));
    else if (sendDate === 2) top.set('send_date', JSON.stringify(new Date(stored.time).toISOString()));
    else if (sendDate === 0) top.set('send_date', timeJson(TOP.send_date, META.sendDateNum));
    for (const [key, code, num] of /** @type {const} */ ([['gen_started', TOP.gen_started, META.genStartedNum], ['gen_finished', TOP.gen_finished, META.genFinishedNum]])) {
        if (times.has(code) || times.has(num) || values.has(code)) top.set(key, timeJson(code, num));
    }

    /**
     * @param {number} code
     * @param {number} num
     */
    function timeJson(code, num) {
        if (times.has(code)) return JSON.stringify(new Date(stored.time + /** @type {number} */ (times.get(code))).toISOString());
        if (times.has(num)) return JSON.stringify(stored.time + /** @type {number} */ (times.get(num)));
        return /** @type {string} */ (values.get(code));
    }

    const mes = state(F.mes);
    if (mes === 0) top.set('mes', JSON.stringify(text ?? ''));
    else if (mes === 2) top.set('mes', /** @type {string} */ (values.get(TOP.mes)));

    const nameState = state(F.name);
    const storedName = values.has(META.nameFromSpeaker) ? null : stored.texts.find(t => t.field === TOP.name)?.text ?? stored.name;
    if (nameState === 0) top.set('name', JSON.stringify(storedName ?? (speaker ? speakerNameAt(speaker, stored.time) : '')));
    else if (nameState === 2) top.set('name', /** @type {string} */ (values.get(TOP.name)));

    if (bit(F.originalAvatar) && speaker) top.set('original_avatar', JSON.stringify(speaker.avatar));
    if (bit(F.forceAvatar) && speaker) top.set('force_avatar', JSON.stringify(`/thumbnail?type=avatar&file=${encodeURIComponent(speaker.avatar)}`));

    const extraState = state(F.extra);
    for (const [field, j] of values) {
        const k = fieldKey(field);
        if ('extra' in k) extra.set(k.extra, j);
        else if ('top' in k && !top.has(k.top) && !['is_user', 'is_system', 'is_name', 'send_date', 'gen_started', 'gen_finished', 'mes', 'name', 'extra'].includes(k.top)) top.set(k.top, j);
    }
    if (extraState === 0) {
        const keys = applyOrder([...extra.keys()], EXTRA_ORDER, values.has(META.extraOrder) ? JSON.parse(/** @type {string} */ (values.get(META.extraOrder))) : '');
        top.set('extra', `{${keys.map(k => `${JSON.stringify(k)}:${extra.get(k)}`).join(',')}}`);
    } else if (extraState === 2) top.set('extra', /** @type {string} */ (values.get(TOP.extra)));

    const usual = state(F.order);
    const keys = usual === 3
        ? applyOrder([...top.keys()], ORDERS[0], JSON.parse(/** @type {string} */ (values.get(META.order))))
        : applyOrder([...top.keys()], ORDERS[usual], '');
    return `{${keys.map(k => `${JSON.stringify(k)}:${top.get(k)}`).join(',')}}`;
}

/**
 * The records storing a new message: its append, then its values and times.
 * @param {bigint} id
 * @param {Encoded} enc
 * @param {{ parent: bigint | null, owner: bigint, time: number, session?: bigint | null, user: bigint, sendKey?: Uint8Array | null }} at
 * @returns {object[]}
 */
export function messageRecords(id, enc, { parent, owner, time, session = null, user, sendKey = null }) {
    /** @type {Record<string, unknown>} */
    const append = { kind: 'messageAppend', id, owner, time, text: enc.text, flags: enc.flags, user };
    if (parent !== null) append.parent = parent;
    if (enc.speaker !== null) append.speaker = enc.speaker;
    if (enc.name !== null) append.name = enc.name;
    if (session !== null) append.session = session;
    if (sendKey) append.sendKey = sendKey;
    const records = [append];
    for (const [field, json] of enc.values) records.push({ kind: 'jsonValue', message: id, field, json });
    for (const [field, delta] of enc.times) records.push({ kind: 'messageTime', message: id, field, delta });
    return records;
}
