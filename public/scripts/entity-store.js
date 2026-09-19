/**
 * Generic stores for a shared collection (tags, characters, groups, personas, ...) that multiple independent
 * consumers need to react to. Mutation goes through named operations that report exactly what changed, instead
 * of every consumer re-deriving it from before/after snapshots. Wraps the existing array/object in place rather
 * than owning a copy, so unmigrated code keeps reading the same values with no changes needed.
 */

/**
 * @template T
 * @typedef {object} EntityChange
 * @property {'created'|'updated'|'removed'|'renamed'|'reordered'|'reset'} op
 * @property {string} [id] - the entity id (for created/updated/removed)
 * @property {T} [entity] - the entity's current value (for created/updated/removed/renamed)
 * @property {Partial<T>} [patch] - the fields that were changed (for updated)
 * @property {string[]} [ids] - full id order (for reordered)
 * @property {string} [oldId] - the entity's id before the rename (for renamed)
 * @property {string} [newId] - the entity's id after the rename (for renamed)
 */

/**
 * A generic store for a flat collection of uniquely-identified entities, backed by - and mutating in place -
 * an existing array.
 * @template T
 */
export class EntityStore {
    /** @param {T[]} array Mutated in place, never reassigned - other references to it see updates automatically. */
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

    /** Does not check for duplicate ids - callers needing that should check before calling. */
    create(entity) {
        const id = this.getId(entity);
        this.array.push(entity);
        this.byId.set(id, entity);
        return this._emit({ op: 'created', id, entity });
    }

    /** Mutates the entity object in place, so other references to it (e.g. a DOM element's closure) see the new values too. */
    update(id, patch) {
        const entity = this.byId.get(id);
        if (!entity) return null;
        Object.assign(entity, patch);
        return this._emit({ op: 'updated', id, entity, patch });
    }

    remove(id) {
        const entity = this.byId.get(id);
        if (!entity) return null;
        const idx = this.array.indexOf(entity);
        if (idx !== -1) this.array.splice(idx, 1);
        this.byId.delete(id);
        return this._emit({ op: 'removed', id, entity });
    }

    /** Ids not present in `idsInOrder` are kept at the end, in their previous relative order, rather than dropped. */
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

    /** Re-syncs the id index without emitting a change; callers doing bulk ops should emit their own change afterward. */
    reindex() {
        this.byId = new Map(this.array.map(e => [this.getId(e), e]));
    }

    /**
     * For a bulk replace with no more specific intent than "the whole collection may have changed". Callers
     * who know the specific create/remove/rename should call reindex() and report*() instead, so consumers
     * hear the specific thing rather than a generic reset.
     */
    reset() {
        this.reindex();
        return this._emit({ op: 'reset' });
    }

    /** For when the array was already rebuilt out from under this store by something other than create(). Call reindex() first. */
    reportCreated(id) {
        const entity = this.byId.get(id);
        if (!entity) return null;
        return this._emit({ op: 'created', id, entity });
    }

    /** Same "rebuilt out from under this store" case as reportCreated() - caller supplies the entity since it's already gone. */
    reportRemoved(id, entity) {
        return this._emit({ op: 'removed', id, entity });
    }

    /** Looks the entity up by its *new* id in the current index, so call reindex() first. */
    reportRenamed(oldId, newId) {
        const entity = this.byId.get(newId);
        if (!entity) return null;
        return this._emit({ op: 'renamed', oldId, newId, entity });
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
 * A generic store for a flat collection of entities already keyed by id - backed by an existing
 * `{[id: string]: T}` object rather than an array. Kept separate from `EntityStore` since a dict has no
 * reorderable position and no need for `EntityStore`'s array-index bookkeeping.
 * @template T
 */
export class DictEntityStore {
    /** @param {{[id: string]: T}} dict Mutated in place, never reassigned. */
    constructor(dict) {
        this.dict = dict;
        /** @type {Set<(change: EntityChange<T>) => void>} */
        this.listeners = new Set();
    }

    /** @param {string} id @returns {T|undefined} */
    get(id) {
        return this.dict[id];
    }

    /** @param {string} id @returns {boolean} */
    has(id) {
        return Object.hasOwn(this.dict, id);
    }

    /** @returns {{[id: string]: T}} */
    getAll() {
        return this.dict;
    }

    /**
     * @param {string} id
     * @returns {EntityChange<T>?} null if an entity with that id already exists (use update() to modify it)
     */
    create(id, entity) {
        if (this.has(id)) return null;
        this.dict[id] = entity;
        return this._emit({ op: 'created', id, entity });
    }

    /** Mutates the entity object in place, so other references to it see the new values too. */
    update(id, patch) {
        const entity = this.dict[id];
        if (!entity) return null;
        Object.assign(entity, patch);
        return this._emit({ op: 'updated', id, entity, patch });
    }

    /**
     * @param {string} id
     * @returns {EntityChange<T>?} null if no entity with that id exists
     */
    remove(id) {
        const entity = this.dict[id];
        if (!entity) return null;
        delete this.dict[id];
        return this._emit({ op: 'removed', id, entity });
    }

    rename(oldId, newId) {
        const entity = this.dict[oldId];
        if (!entity) return null;
        delete this.dict[oldId];
        this.dict[newId] = entity;
        return this._emit({ op: 'renamed', oldId, newId, entity });
    }

    /** The dict-backed equivalent of `EntityStore.reset()` - no separate index to rebuild, so this just emits. */
    reset() {
        return this._emit({ op: 'reset' });
    }

    reportCreated(id) {
        const entity = this.dict[id];
        if (!entity) return null;
        return this._emit({ op: 'created', id, entity });
    }

    /** Caller must supply the entity value it had in hand, since it's already gone from the dict by the time this is called. */
    reportRemoved(id, entity) {
        return this._emit({ op: 'removed', id, entity });
    }

    /**
     * @param {string} oldId
     * @param {string} newId
     * @returns {EntityChange<T>?} null if no entity with the new id exists
     */
    reportRenamed(oldId, newId) {
        const entity = this.dict[newId];
        if (!entity) return null;
        return this._emit({ op: 'renamed', oldId, newId, entity });
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
 * @property {'assigned'|'unassigned'|'keySet'|'keyRemoved'|'relatedRemoved'} op
 * @property {string} [key]
 * @property {string} [relatedId]
 * @property {boolean} [wasFirstUse] - for 'assigned': whether this was `relatedId`'s first assignment anywhere
 * @property {boolean} [wasLastUse] - for 'unassigned': whether this removed `relatedId`'s last assignment anywhere
 * @property {string[]} [addedIds] - for 'keySet': related ids that became newly assigned to `key`
 * @property {string[]} [removedIds] - for 'keySet'/'keyRemoved': related ids that stopped being assigned to `key`
 * @property {string[]} [lastUseIds] - for 'keyRemoved'/'relatedRemoved': related ids that had no other assignment left after this
 * @property {string} [replacedWithId] - for 'relatedRemoved': a related id substituted in wherever `relatedId` was removed
 * @property {string[]} [affectedKeys] - for 'relatedRemoved': every key that had `relatedId` removed
 */

/**
 * A generic store for a many-to-many relation between a "key" (e.g. a character avatar or group id) and a set
 * of "related ids" (e.g. tag ids). Unlike `EntityStore`/`DictEntityStore`, this doesn't own a backing
 * collection of its own - each key's related-id array lives as a field on that key's own entity (wherever the
 * caller's `resolve` function finds it), so there's nothing here to fall out of sync with that entity.
 *
 * Keeps an incrementally-maintained usage count per related id, so `getAssignedIds()` is O(1) instead of a full
 * scan, and mutating ops can report `wasFirstUse`/`wasLastUse` for free.
 */
export class RelationStore {
    /**
     * @param {(key: string) => string[]|undefined} resolve Returns the *live*, mutable related-ids array for
     *   a key - mutated in place (push/splice) to change the relation - or `undefined` if `key` doesn't
     *   currently resolve to anything (e.g. an entity that isn't resident).
     * @param {() => Iterable<[string, string[]]>} allEntries Returns every currently-resolvable [key, array]
     *   pair. Used to seed/rebuild the usage-count index and for whole-collection scans
     *   (`removeRelatedIdEverywhere()`).
     */
    constructor(resolve, allEntries) {
        this.resolve = resolve;
        this.allEntries = allEntries;
        /** @type {Map<string, number>} */
        this.usageCounts = new Map();
        for (const [, ids] of allEntries()) {
            for (const id of ids) {
                this.usageCounts.set(id, (this.usageCounts.get(id) ?? 0) + 1);
            }
        }
        /** @type {Set<(change: RelationChange) => void>} */
        this.listeners = new Set();
    }

    /** @param {string} key @returns {string[]} */
    get(key) {
        const ids = this.resolve(key);
        return Array.isArray(ids) ? ids : [];
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
     * @returns {RelationChange?} null if `key` doesn't resolve, or the relation already exists (no-op)
     */
    assign(key, relatedId) {
        const ids = this.resolve(key);
        if (!ids || ids.includes(relatedId)) return null;
        ids.push(relatedId);
        const wasFirstUse = !this.usageCounts.has(relatedId);
        this.usageCounts.set(relatedId, (this.usageCounts.get(relatedId) ?? 0) + 1);
        return this._emit({ op: 'assigned', key, relatedId, wasFirstUse });
    }

    /**
     * @param {string} key
     * @param {string} relatedId
     * @returns {RelationChange?} null if `key` doesn't resolve, or the relation doesn't exist (no-op)
     */
    unassign(key, relatedId) {
        const ids = this.resolve(key);
        if (!ids) return null;
        const idx = ids.indexOf(relatedId);
        if (idx === -1) return null;
        ids.splice(idx, 1);
        const count = (this.usageCounts.get(relatedId) ?? 1) - 1;
        const wasLastUse = count <= 0;
        if (wasLastUse) this.usageCounts.delete(relatedId); else this.usageCounts.set(relatedId, count);
        return this._emit({ op: 'unassigned', key, relatedId, wasLastUse });
    }

    /** Replaces the full set of related ids for a key. Computes and reports exactly the delta. Null if `key` doesn't resolve. */
    setKey(key, relatedIds) {
        const ids = this.resolve(key);
        if (!ids) return null;
        const oldIds = [...ids];
        const oldSet = new Set(oldIds);
        const newSet = new Set(relatedIds);
        const addedIds = relatedIds.filter(id => !oldSet.has(id));
        const removedIds = oldIds.filter(id => !newSet.has(id));
        for (const id of addedIds) this.usageCounts.set(id, (this.usageCounts.get(id) ?? 0) + 1);
        for (const id of removedIds) {
            const count = (this.usageCounts.get(id) ?? 1) - 1;
            if (count <= 0) this.usageCounts.delete(id); else this.usageCounts.set(id, count);
        }
        ids.length = 0;
        ids.push(...relatedIds);
        return this._emit({ op: 'keySet', key, addedIds, removedIds });
    }

    /** Clears a key's related ids (the entity itself isn't removed - there's no separate map entry to drop). Null if `key` doesn't resolve. */
    removeKey(key) {
        const ids = this.resolve(key);
        if (!ids) return null;
        const removedIds = [...ids];
        ids.length = 0;
        const lastUseIds = [];
        for (const id of removedIds) {
            const count = (this.usageCounts.get(id) ?? 1) - 1;
            if (count <= 0) { this.usageCounts.delete(id); lastUseIds.push(id); } else this.usageCounts.set(id, count);
        }
        return this._emit({ op: 'keyRemoved', key, removedIds, lastUseIds });
    }

    /** Removes a related id from every key it's assigned to, optionally substituting another id in its place. */
    removeRelatedIdEverywhere(relatedId, { replaceWithId } = {}) {
        const affectedKeys = [];
        for (const [key, ids] of this.allEntries()) {
            const idx = ids.indexOf(relatedId);
            if (idx === -1) continue;
            ids.splice(idx, 1);
            affectedKeys.push(key);
            if (replaceWithId && !ids.includes(replaceWithId)) {
                ids.push(replaceWithId);
                this.usageCounts.set(replaceWithId, (this.usageCounts.get(replaceWithId) ?? 0) + 1);
            }
        }
        this.usageCounts.delete(relatedId);
        return this._emit({ op: 'relatedRemoved', relatedId, replacedWithId: replaceWithId, affectedKeys });
    }

    /** Re-syncs usage counts without emitting a change; callers doing bulk ops should emit their own change afterward. */
    reindex() {
        this.usageCounts = new Map();
        for (const [, ids] of this.allEntries()) {
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
