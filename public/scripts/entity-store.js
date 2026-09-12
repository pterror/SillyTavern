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
 * A generic store for a many-to-many relation between a "key" (e.g. a character avatar) and a set of "related
 * ids" (e.g. tag ids) - the shape `tag_map` has. Backed by - and mutating in place - an existing
 * `{[key: string]: string[]}` object.
 *
 * Keeps an incrementally-maintained usage count per related id, so `getAssignedIds()` is O(1) instead of a full
 * scan, and mutating ops can report `wasFirstUse`/`wasLastUse` for free.
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

    /** Replaces the full set of related ids for a key. Computes and reports exactly the delta. */
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

    /** Usage counts are unaffected - the same related ids are still assigned, just under a different key. */
    renameKey(oldKey, newKey) {
        const ids = this.get(oldKey);
        this.map[newKey] = ids;
        delete this.map[oldKey];
        return this._emit({ op: 'keyRenamed', oldKey, newKey });
    }

    /** Merges `fromKey`'s related ids into `toKey` (union); `fromKey` itself is left untouched. */
    copyKey(fromKey, toKey) {
        const fromIds = this.get(fromKey);
        const toIds = this.get(toKey);
        const toSet = new Set(toIds);
        const addedIds = fromIds.filter(id => !toSet.has(id));
        for (const id of addedIds) this.usageCounts.set(id, (this.usageCounts.get(id) ?? 0) + 1);
        this.map[toKey] = [...toIds, ...addedIds];
        return this._emit({ op: 'keyCopied', fromKey, toKey, addedIds });
    }

    removeKey(key) {
        const ids = this.map[key];
        if (!(key in this.map)) return null;
        delete this.map[key];
        const removedIds = Array.isArray(ids) ? ids : [];
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

    /** Re-syncs usage counts without emitting a change; callers doing bulk ops should emit their own change afterward. */
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
