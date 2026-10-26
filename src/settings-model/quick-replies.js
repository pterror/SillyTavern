import { TYPE } from '../library-codes.js';
import { migrateQuickReplySet } from '../../public/scripts/extensions/quick-reply/src/migrate-set.js';
import { draft, keyedPart, partRecord, without } from './entity-draft.js';

/**
 * Quick reply sets (§1.7, step 3e), made from upstream's set files and given back as them.
 *
 * - A set (`TYPE.quickReplySet`, key its name): its options as its file names them. A set of the extension's first
 *   version is brought to version 2 first, as the page does on load; its old keys go, warned.
 * - Its replies are parts (`TYPE.quickReply`, key `<set>:<reply id>`) in list 0, with every field the file gives, but
 *   `contextList`: a reply's list 0 holds the sets of its context menu, list 1 those chained.
 * - Which sets show where (the user's, a character's, a chat's set list) are statements of a combined list (§1.1),
 *   each item a set and whether it's visible.
 */

/** The fields of a version 2 set besides its replies, as `QuickReplySet.toJSON` writes them. */
const SET_FIELDS = Object.freeze(['version', 'name', 'disableSend', 'placeBeforeInput', 'injectInput', 'color', 'onlyBorderColor', 'qrList', 'idIndex']);

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 */

/**
 * A quick reply set made from its upstream file.
 * @param {string} name
 * @param {Record<string, any>} file
 * @returns {{ set: EntityDraft, warnings: string[] }}
 */
export function quickReplySetFromUpstream(name, file) {
    /** @type {string[]} */
    const warnings = [];
    const set = structuredClone(file);
    if (set.version !== 2) {
        migrateQuickReplySet(set);
        const old = Object.keys(set).filter(key => !SET_FIELDS.includes(key));
        if (old.length) warnings.push(`quick reply set ${JSON.stringify(name)} is of the first version; brought to the second, its ${old.join(', ')} dropped`);
        for (const key of old) delete set[key];
    }
    const seen = new Set();
    const replies = (Array.isArray(set.qrList) ? set.qrList : []).map((reply, index) => {
        const part = keyedPart(TYPE.quickReply, name, without(reply ?? {}, ['contextList']), {
            idField: 'id', index, seen, warnings, what: 'quick reply', valid: id => Number.isInteger(id),
        });
        if (Array.isArray(reply?.contextList)) {
            part.lists = {
                0: reply.contextList.map(link => String(link?.set)),
                1: reply.contextList.filter(link => link?.isChained).map(link => String(link?.set)),
            };
        }
        return part;
    });
    const values = without(set, Array.isArray(set.qrList) ? ['qrList'] : []);
    return { set: draft(TYPE.quickReplySet, name, values, replies.length ? { 0: replies } : undefined), warnings };
}

/**
 * A quick reply set's upstream file.
 * @param {EntityDraft} set
 * @returns {Record<string, unknown>}
 */
export function quickReplySetToUpstream(set) {
    /** @type {Record<string, unknown>} */
    const file = { ...set.values };
    const replies = set.lists?.[0];
    if (replies || !Object.hasOwn(file, 'qrList')) {
        file.qrList = (replies ?? []).map((part) => {
            const reply = /** @type {EntityDraft} */ (part);
            const record = partRecord(reply, set.key, 'id', Number);
            if (reply.lists) {
                const chained = new Set(reply.lists[1] ?? []);
                record.contextList = (reply.lists[0] ?? []).map(name => ({ set: name, isChained: chained.has(/** @type {string} */ (name)) }));
            }
            return record;
        });
    }
    return file;
}

/**
 * A set list (`quickReplyV2.config`, a character's config, a chat's `quickReply`) as a statement: its sets in order,
 * and those hidden.
 * @param {{ setList?: { set: string, isVisible?: boolean }[] } | undefined} config
 * @returns {{ items: string[], hidden: string[] }}
 */
export function setListFromUpstream(config) {
    const list = Array.isArray(config?.setList) ? config.setList : [];
    return {
        items: list.map(link => String(link?.set)),
        hidden: list.filter(link => link?.isVisible === false).map(link => String(link?.set)),
    };
}

/**
 * @param {{ items: string[], hidden?: string[] }} statement
 * @returns {{ setList: { set: string, isVisible: boolean }[] }}
 */
export function setListToUpstream(statement) {
    const hidden = new Set(statement.hidden ?? []);
    return { setList: statement.items.map(set => ({ set, isVisible: !hidden.has(set) })) };
}
