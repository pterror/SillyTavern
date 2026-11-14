import { ROW_FIELDS } from '@st/worldbuilding/protocol';
import { TYPE } from '../library-codes.js';
import { READER_VIEWS_FIELD } from '../world-info-engine.js';

// The author's views: a field of the book, carried by a world file as `views`, each target named by its entry's key.
export const WORLD_VIEWS_FIELD = 'views';

const VIEW_ID = /^[a-z0-9-]{1,40}$/;
const DEPTHS = new Set(['directly', 'anyDepth']);
const FIELDS = new Set(ROW_FIELDS);

const isRecord = (/** @type {unknown} */ value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const kindOf = (/** @type {unknown} */ kind) => (Number.isSafeInteger(kind) && /** @type {number} */ (kind) > 0 ? String(kind) : typeof kind === 'string' && /^[1-9]\d{0,15}$/.test(kind) ? kind : null);
const targetOf = (/** @type {unknown} */ target) => (Number.isSafeInteger(target) && /** @type {number} */ (target) >= 0 ? String(target) : typeof target === 'string' && /^\d+$/.test(target) ? target : null);

/**
 * A stored view as the protocol has it, its targets as stored (keys in a world file, entity ids in the reader's layer);
 * null for anything that isn't one, so a world file's malformed view is left out rather than refused.
 * @param {unknown} value
 * @returns {import('@st/worldbuilding/protocol').SavedView | null}
 */
export function viewOf(value) {
    if (!isRecord(value)) return null;
    const v = /** @type {Record<string, unknown>} */ (value);
    if (typeof v.id !== 'string' || !VIEW_ID.test(v.id) || typeof v.name !== 'string' || v.name.trim() === '') return null;
    const groupBy = v.groupBy === null || v.groupBy === undefined ? null : kindOf(v.groupBy);
    if (v.groupBy !== null && v.groupBy !== undefined && groupBy === null) return null;
    const chips = (Array.isArray(v.chips) ? v.chips : []).flatMap(chip => {
        if (!isRecord(chip)) return [];
        const kind = kindOf(chip.kind);
        const target = targetOf(chip.target);
        const depth = DEPTHS.has(/** @type {string} */ (chip.depth)) ? /** @type {'directly' | 'anyDepth'} */ (chip.depth) : 'directly';
        return kind && target ? [{ kind, target, depth }] : [];
    });
    const axis = (/** @type {unknown} */ items) => (Array.isArray(items) ? items : []).flatMap(item => {
        if (!isRecord(item)) return [];
        const kind = kindOf(item.kind);
        if (!kind) return [];
        if (item.is === 'any' || item.is === 'none') return [{ kind, is: /** @type {'any' | 'none'} */ (item.is) }];
        if (!isRecord(item.is)) return [];
        const target = targetOf(item.is.target);
        const depth = DEPTHS.has(item.is.depth) ? item.is.depth : 'directly';
        return target ? [{ kind, is: { target, depth } }] : [];
    });
    return {
        id: v.id,
        name: v.name.trim(),
        groupBy,
        drawing: v.drawing === 'rows' ? 'rows' : 'cards',
        fields: [...new Set((Array.isArray(v.fields) ? v.fields : []).filter(field => FIELDS.has(field)))],
        query: typeof v.query === 'string' ? v.query : '',
        chips,
        columns: axis(v.columns),
        rows: axis(v.rows),
    };
}

/**
 * @param {unknown} list
 * @returns {import('@st/worldbuilding/protocol').SavedView[]}
 */
const viewsOf = list => {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).flatMap(item => {
        const view = viewOf(item);
        if (!view || seen.has(view.id)) return [];
        seen.add(view.id);
        return [view];
    });
};

/**
 * @param {import('@st/worldbuilding/protocol').SavedView} view
 * @param {(target: string) => string | null} to
 * @returns {import('@st/worldbuilding/protocol').SavedView}
 */
function withTargets(view, to) {
    return {
        ...view,
        chips: view.chips.flatMap(chip => {
            const target = to(chip.target);
            return target === null ? [] : [{ ...chip, target }];
        }),
        columns: axisWithTargets(view.columns, to),
        rows: axisWithTargets(view.rows, to),
    };
}

/**
 * @param {import('@st/worldbuilding/protocol').AxisItem[]} items
 * @param {(target: string) => string | null} to
 */
const axisWithTargets = (items, to) => items.flatMap(item => {
    if (typeof item.is === 'string') return [item];
    const target = to(item.is.target);
    return target === null ? [] : [{ ...item, is: { ...item.is, target } }];
});

/**
 * @param {unknown} text
 * @returns {import('@st/worldbuilding/server').ReaderViews}
 */
function readerViewsOf(text) {
    let parsed;
    try {
        parsed = typeof text === 'string' ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }
    const changed = isRecord(parsed?.changed) ? parsed.changed : {};
    return {
        changed: Object.fromEntries(Object.entries(changed).flatMap(([id, value]) => {
            const view = viewOf(value);
            return view && view.id === id ? [[id, view]] : [];
        })),
        own: viewsOf(parsed?.own),
    };
}

/**
 * @param {{ libOf: (user: import('@st/server-ui').User) => Promise<any> }} options
 * @returns {Pick<import('@st/worldbuilding/server').Ports, 'readViews' | 'writeReaderViews'>}
 */
export function worldbuildingViewPorts({ libOf }) {
    return {
        async readViews(user, book) {
            const lib = await libOf(user);
            const [entity] = await lib.entities([BigInt(book)]);
            if (!entity) return null;
            const valueOf = (/** @type {string} */ field) => entity.values.find((/** @type {any} */ v) => v.field === field);
            const stored = valueOf(WORLD_VIEWS_FIELD);
            let list = null;
            try {
                list = stored?.json !== undefined ? JSON.parse(stored.json) : stored?.text !== undefined ? JSON.parse(stored.text) : null;
            } catch {
                list = null;
            }
            const world = viewsOf(list);
            const uids = [...new Set(world.flatMap(view => [
                ...view.chips.map(chip => chip.target),
                ...[...view.columns, ...view.rows].flatMap(item => (typeof item.is === 'string' ? [] : [item.is.target])),
            ]))];
            const ids = uids.length === 0 ? [] : await lib.ids(TYPE.entry, uids.map(uid => `${book}:${uid}`));
            const entityOf = new Map(uids.map((uid, at) => [uid, ids[at] === null || ids[at] === undefined ? null : String(ids[at])]));
            return {
                world: world.map(view => withTargets(view, uid => entityOf.get(uid) ?? null)),
                reader: readerViewsOf(valueOf(READER_VIEWS_FIELD)?.text),
            };
        },
        async writeReaderViews({ user }, book, reader) {
            const lib = await libOf(user);
            const id = BigInt(book);
            const empty = Object.keys(reader.changed).length === 0 && reader.own.length === 0;
            const done = await lib.books.inWorld(id, (form, commit) => commit([empty
                ? { kind: 'valueDelete', entity: id, field: READER_VIEWS_FIELD }
                : { kind: 'textValue', entity: id, field: READER_VIEWS_FIELD, text: JSON.stringify(reader) }]));
            return done === 'missing' ? 'missing' : 'ok';
        },
    };
}
