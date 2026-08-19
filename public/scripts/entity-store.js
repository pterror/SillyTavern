/**
 * Generic building blocks for "a shared collection that multiple independent UI/index/persistence consumers
 * need to react to" - the shape tags/tag_map, characters, groups, and personas all have in this codebase.
 *
 * The problem this solves: today, mutating one of those collections (add a tag, edit a character, ...) is done
 * by directly pushing/splicing/assigning into a plain array or object, and every consumer that cares (row
 * rendering, filter bars, search indexes, settings-save decisions, tag-usage caches) has to independently infer
 * *what* changed - usually by comparing before/after snapshots, or by a caller remembering to call the right
 * invalidation function. That's provably lossy: three separate files in this codebase mutated `tag_map`
 * directly and silently skipped cache invalidation, only found by a manual audit of every call site.
 *
 * EntityStore / RelationStore instead make mutation go through a small set of named operations that each
 * report *exactly* what changed (a change object), and let consumers subscribe once and react to precisely
 * that, instead of re-deriving it. They wrap an existing array/object *in place* (push/splice/assign onto the
 * same reference) rather than owning a separate copy, so code that isn't migrated yet keeps reading the same
 * `tags`/`tag_map`-shaped values with zero changes required on its end.
 *
 * Deliberately not integrated with the app's global eventSource/event_types enum - each store instance has its
 * own self-contained subscriber list, so adding a new store doesn't require touching the global event registry,
 * and consumers only ever hear about the collection they actually subscribed to.
 */

/**
 * @template T
 * @typedef {object} EntityChange
 * @property {'created'|'updated'|'removed'|'reordered'|'reset'} op
 * @property {string} [id] - the entity id (for created/updated/removed)
 * @property {T} [entity] - the entity's current value (for created/updated/removed)
 * @property {Partial<T>} [patch] - the fields that were changed (for updated)
 * @property {string[]} [ids] - full id order (for reordered)
 */

/**
 * A generic store for a flat collection of uniquely-identified entities (e.g. tags, and potentially
 * characters/groups/personas later), backed by - and mutating in place - an existing array.
 * @template T
 */
export class EntityStore {
    /**
     * @param {T[]} array - the backing array. Mutated in place (push/splice/length+push for reorder), never
     * reassigned, so any other code holding a reference to this same array sees updates automatically.
     * @param {(entity: T) => string} getId - extracts the id from an entity
     */
    constructor(array, getId) {
        this.array = array;
        this.getId = getId;
        /** @type {Map<string, T>} */
        this.byId = new Map(array.map(e => [getId(e), e]));
        /** @type {Set<(change: EntityChange<T>) => void>} */
        this.listeners = new Set();
    }

    /** @param {string} id @returns {T|undefined} */
    get(id) {
        return this.byId.get(id);
    }

    /** @param {string} id @returns {boolean} */
    has(id) {
        return this.byId.has(id);
    }

    /** @returns {T[]} */
    getAll() {
        return this.array;
    }

    /**
     * Adds a new entity. Does not check for duplicate ids - callers that need "does this id/name already
     * exist" semantics should check before calling.
     * @param {T} entity
     * @returns {EntityChange<T>}
     */
    create(entity) {
        const id = this.getId(entity);
        this.array.push(entity);
        this.byId.set(id, entity);
        return this._emit({ op: 'created', id, entity });
    }

    /**
     * Applies a shallow patch of fields onto an existing entity (mutates the entity object in place, so any
     * other reference to it - e.g. a DOM element's bound `tag` closure - sees the new values too).
     * @param {string} id
     * @param {Partial<T>} patch
     * @returns {EntityChange<T>?} null if no entity with that id exists
     */
    update(id, patch) {
        const entity = this.byId.get(id);
        if (!entity) return null;
        Object.assign(entity, patch);
        return this._emit({ op: 'updated', id, entity, patch });
    }

    /**
     * @param {string} id
     * @returns {EntityChange<T>?} null if no entity with that id exists
     */
    remove(id) {
        const entity = this.byId.get(id);
        if (!entity) return null;
        const idx = this.array.indexOf(entity);
        if (idx !== -1) this.array.splice(idx, 1);
        this.byId.delete(id);
        return this._emit({ op: 'removed', id, entity });
    }

    /**
     * Reorders the backing array to match the given id order. Ids not present in `idsInOrder` are kept
     * (defensively) at the end, in their previous relative order, rather than dropped.
     * @param {string[]} idsInOrder
     * @returns {EntityChange<T>}
     */
    reorder(idsInOrder) {
        const reordered = idsInOrder.map(id => this.byId.get(id)).filter(Boolean);
        const reorderedSet = new Set(reordered);
        for (const entity of this.array) {
            if (!reorderedSet.has(entity)) reordered.push(entity);
        }
        this.array.length = 0;
        this.array.push(...reordered);
        return this._emit({ op: 'reordered', ids: idsInOrder });
    }

    /**
     * Full re-sync of the id index from the current contents of the backing array, without emitting a
     * per-entity change - for bulk operations (import, initial load) that would rather emit their own summary
     * change than a flood of individual ones. Callers doing this should emit their own change afterward.
     */
    reindex() {
        this.byId = new Map(this.array.map(e => [this.getId(e), e]));
    }

    /**
     * @param {(change: EntityChange<T>) => void} listener
     * @returns {() => void} unsubscribe function
     */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** @param {EntityChange<T>} change @returns {EntityChange<T>} */
    _emit(change) {
        for (const listener of this.listeners) {
            listener(change);
        }
        return change;
    }
}

/**
 * @typedef {object} RelationChange
 * @property {'assigned'|'unassigned'|'keySet'|'keyRenamed'|'keyCopied'|'keyRemoved'|'relatedRemoved'} op
 * @property {string} [key]
 * @property {string} [relatedId]
 * @property {boolean} [wasFirstUse] - for 'assigned': whether this was `relatedId`'s first assignment anywhere
 * @property {boolean} [wasLastUse] - for 'unassigned': whether this removed `relatedId`'s last assignment anywhere
 * @property {string[]} [addedIds] - for 'keySet'/'keyCopied': related ids that became newly assigned to `key`/`toKey`
 * @property {string[]} [removedIds] - for 'keySet'/'keyRemoved': related ids that stopped being assigned to `key`
 * @property {string[]} [lastUseIds] - for 'keyRemoved'/'relatedRemoved': related ids that had no other assignment left after this
 * @property {string} [oldKey]
 * @property {string} [newKey]
 * @property {string} [fromKey]
 * @property {string} [toKey]
 * @property {string} [replacedWithId] - for 'relatedRemoved': a related id substituted in wherever `relatedId` was removed
 * @property {string[]} [affectedKeys] - for 'relatedRemoved': every key that had `relatedId` removed
 */

/**
 * A generic store for a many-to-many relation between a "key" (e.g. a character avatar or group id) and a set
 * of "related ids" (e.g. tag ids) - the shape `tag_map` has. Backed by - and mutating in place - an existing
 * `{[key: string]: string[]}` object.
 *
 * Keeps an incrementally-maintained usage count per related id, so "is this related id assigned to *anything*"
 * (the `getAssignedIds()`/tag-filter-bar-membership question) is O(1) instead of a full `Object.values(map).flat()`
 * scan - and so mutating ops can report `wasFirstUse`/`wasLastUse` for free, letting consumers add/remove exactly
 * one UI element instead of diffing a full before/after snapshot to figure out what changed.
 */
export class RelationStore {
    /**
     * @param {{[key: string]: string[]}} map - the backing object. Mutated in place.
     */
    constructor(map) {
        this.map = map;
        /** @type {Map<string, number>} */
        this.usageCounts = new Map();
        for (const ids of Object.values(map)) {
            if (!Array.isArray(ids)) continue;
            for (const id of ids) {
                this.usageCounts.set(id, (this.usageCounts.get(id) ?? 0) + 1);
            }
        }
        /** @type {Set<(change: RelationChange) => void>} */
        this.listeners = new Set();
    }

    /** @param {string} key @returns {string[]} */
    get(key) {
        return Array.isArray(this.map[key]) ? this.map[key] : [];
    }

    /** @param {string} key @param {string} relatedId @returns {boolean} */
    isAssigned(key, relatedId) {
        return this.get(key).includes(relatedId);
    }

    /** All related ids that are assigned to at least one key. O(1). @returns {Set<string>} */
    getAssignedIds() {
        return new Set(this.usageCounts.keys());
    }

    /**
     * @param {string} key
     * @param {string} relatedId
     * @returns {RelationChange?} null if already assigned (no-op)
     */
    assign(key, relatedId) {
        if (!Array.isArray(this.map[key])) this.map[key] = [];
        if (this.map[key].includes(relatedId)) return null;
        this.map[key].push(relatedId);
        const wasFirstUse = !this.usageCounts.has(relatedId);
        this.usageCounts.set(relatedId, (this.usageCounts.get(relatedId) ?? 0) + 1);
        return this._emit({ op: 'assigned', key, relatedId, wasFirstUse });
    }

    /**
     * @param {string} key
     * @param {string} relatedId
     * @returns {RelationChange?} null if not currently assigned (no-op)
     */
    unassign(key, relatedId) {
        const list = this.map[key];
        if (!Array.isArray(list)) return null;
        const idx = list.indexOf(relatedId);
        if (idx === -1) return null;
        list.splice(idx, 1);
        const count = (this.usageCounts.get(relatedId) ?? 1) - 1;
        const wasLastUse = count <= 0;
        if (wasLastUse) this.usageCounts.delete(relatedId); else this.usageCounts.set(relatedId, count);
        return this._emit({ op: 'unassigned', key, relatedId, wasLastUse });
    }

    /**
     * Replaces the full set of related ids for a key (e.g. rebuilding one entity's tag list from a reordered
     * DOM list). Computes and reports exactly the delta.
     * @param {string} key
     * @param {string[]} relatedIds
     * @returns {RelationChange}
     */
    setKey(key, relatedIds) {
        const oldIds = this.get(key);
        const oldSet = new Set(oldIds);
        const newSet = new Set(relatedIds);
        const addedIds = relatedIds.filter(id => !oldSet.has(id));
        const removedIds = oldIds.filter(id => !newSet.has(id));
        for (const id of addedIds) this.usageCounts.set(id, (this.usageCounts.get(id) ?? 0) + 1);
        for (const id of removedIds) {
            const count = (this.usageCounts.get(id) ?? 1) - 1;
            if (count <= 0) this.usageCounts.delete(id); else this.usageCounts.set(id, count);
        }
        this.map[key] = relatedIds;
        return this._emit({ op: 'keySet', key, addedIds, removedIds });
    }

    /**
     * Moves a key's assignments to a new key name (e.g. character avatar changed). Usage counts are unaffected
     * since the same related ids are still assigned, just under a different key.
     * @param {string} oldKey
     * @param {string} newKey
     * @returns {RelationChange}
     */
    renameKey(oldKey, newKey) {
        const ids = this.get(oldKey);
        this.map[newKey] = ids;
        delete this.map[oldKey];
        return this._emit({ op: 'keyRenamed', oldKey, newKey });
    }

    /**
     * Merges `fromKey`'s related ids into `toKey` (union, `fromKey` itself is left untouched).
     * @param {string} fromKey
     * @param {string} toKey
     * @returns {RelationChange}
     */
    copyKey(fromKey, toKey) {
        const fromIds = this.get(fromKey);
        const toIds = this.get(toKey);
        const toSet = new Set(toIds);
        const addedIds = fromIds.filter(id => !toSet.has(id));
        for (const id of addedIds) this.usageCounts.set(id, (this.usageCounts.get(id) ?? 0) + 1);
        this.map[toKey] = [...toIds, ...addedIds];
        return this._emit({ op: 'keyCopied', fromKey, toKey, addedIds });
    }

    /**
     * Removes a key entirely (e.g. character/group deleted).
     * @param {string} key
     * @returns {RelationChange?} null if the key didn't exist
     */
    removeKey(key) {
        const ids = this.map[key];
        if (!(key in this.map)) return null;
        delete this.map[key];
        const removedIds = Array.isArray(ids) ? ids : [];
        const lastUseIds = [];
        for (const id of removedIds) {
            const count = (this.usageCounts.get(id) ?? 1) - 1;
            if (count <= 0) { this.usageCounts.delete(id); lastUseIds.push(id); }
            else this.usageCounts.set(id, count);
        }
        return this._emit({ op: 'keyRemoved', key, removedIds, lastUseIds });
    }

    /**
     * Removes a related id from every key it's assigned to (e.g. a tag got deleted), optionally substituting
     * another related id in its place (e.g. "delete and merge into").
     * @param {string} relatedId
     * @param {object} [options]
     * @param {string} [options.replaceWithId]
     * @returns {RelationChange}
     */
    removeRelatedIdEverywhere(relatedId, { replaceWithId } = {}) {
        const affectedKeys = [];
        for (const key of Object.keys(this.map)) {
            const list = this.map[key];
            if (!Array.isArray(list)) continue;
            const idx = list.indexOf(relatedId);
            if (idx === -1) continue;
            list.splice(idx, 1);
            affectedKeys.push(key);
            if (replaceWithId && !list.includes(replaceWithId)) {
                list.push(replaceWithId);
                this.usageCounts.set(replaceWithId, (this.usageCounts.get(replaceWithId) ?? 0) + 1);
            }
        }
        this.usageCounts.delete(relatedId);
        return this._emit({ op: 'relatedRemoved', relatedId, replacedWithId: replaceWithId, affectedKeys });
    }

    /**
     * Full re-sync of usage counts from the current contents of the backing map, without emitting a change -
     * for bulk operations that would rather emit their own summary change. Callers doing this should emit
     * their own change afterward.
     */
    reindex() {
        this.usageCounts = new Map();
        for (const ids of Object.values(this.map)) {
            if (!Array.isArray(ids)) continue;
            for (const id of ids) {
                this.usageCounts.set(id, (this.usageCounts.get(id) ?? 0) + 1);
            }
        }
    }

    /**
     * @param {(change: RelationChange) => void} listener
     * @returns {() => void} unsubscribe function
     */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** @param {RelationChange} change @returns {RelationChange} */
    _emit(change) {
        for (const listener of this.listeners) {
            listener(change);
        }
        return change;
    }
}
