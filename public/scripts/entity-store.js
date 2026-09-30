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

/** @type {Set<(store: EntityStore<any>) => void>} */
const anyStoreListeners = new Set();

/**
 * Calls `listener` with a store whenever which entities it holds may have changed: when it is built, re-indexed,
 * or reports an entity created, removed or renamed, or a reset. For a consumer that has to follow a store which
 * gets rebuilt, where a listener on the store itself would be lost.
 * @param {(store: EntityStore<any>) => void} listener
 * @returns {() => void} unsubscribe function
 */
export function onAnyEntityStoreChange(listener) {
    anyStoreListeners.add(listener);
    return () => anyStoreListeners.delete(listener);
}

/** @param {EntityStore<any>} store */
function tellAnyStoreListeners(store) {
    for (const listener of anyStoreListeners) {
        listener(store);
    }
}

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
        tellAnyStoreListeners(this);
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
        tellAnyStoreListeners(this);
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
        if (change.op !== 'updated' && change.op !== 'reordered') tellAnyStoreListeners(this);
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

