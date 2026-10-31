/**
 * @template T
 * @typedef {object} EntityChange
 * @property {'created'|'updated'|'removed'|'renamed'|'reordered'|'reset'} op
 * @property {string} [id]
 * @property {T} [entity]
 * @property {Partial<T>} [patch]
 * @property {string[]} [ids]
 * @property {string} [oldId]
 * @property {string} [newId]
 */

/** @type {Set<(store: EntityStore<any>) => void>} */
const anyStoreListeners = new Set();

/**
 * @param {(store: EntityStore<any>) => void} listener
 * @returns {() => void}
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
 * @template T
 */
export class EntityStore {
    /** @param {T[]} array */
    constructor(array, getId) {
        this.array = array;
        this.getId = getId;
        /** @type {Map<string, T>} */
        this.byId = new Map(array.map(e => [getId(e), e]));
        /** @type {Set<(change: EntityChange<T>) => void>} */
        this.listeners = new Set();
        tellAnyStoreListeners(this);
    }

    /**
     * @param {string} id
     * @returns {T|undefined}
     */
    get(id) {
        return this.byId.get(id);
    }

    /**
     * @param {string} id
     * @returns {boolean}
     */
    has(id) {
        return this.byId.has(id);
    }

    /** @returns {T[]} */
    getAll() {
        return this.array;
    }

    create(entity) {
        const id = this.getId(entity);
        this.array.push(entity);
        this.byId.set(id, entity);
        return this._emit({ op: 'created', id, entity });
    }

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

    reindex() {
        this.byId = new Map(this.array.map(e => [this.getId(e), e]));
        tellAnyStoreListeners(this);
    }

    reset() {
        this.reindex();
        return this._emit({ op: 'reset' });
    }

    reportCreated(id) {
        const entity = this.byId.get(id);
        if (!entity) return null;
        return this._emit({ op: 'created', id, entity });
    }

    reportRemoved(id, entity) {
        return this._emit({ op: 'removed', id, entity });
    }

    reportRenamed(oldId, newId) {
        const entity = this.byId.get(newId);
        if (!entity) return null;
        return this._emit({ op: 'renamed', oldId, newId, entity });
    }

    /**
     * @param {(change: EntityChange<T>) => void} listener
     * @returns {() => void}
     */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * @param {EntityChange<T>} change
     * @returns {EntityChange<T>}
     */
    _emit(change) {
        for (const listener of this.listeners) {
            listener(change);
        }
        if (change.op !== 'updated' && change.op !== 'reordered') tellAnyStoreListeners(this);
        return change;
    }
}

/**
 * @template T
 */
export class DictEntityStore {
    /** @param {{[id: string]: T}} dict */
    constructor(dict) {
        this.dict = dict;
        /** @type {Set<(change: EntityChange<T>) => void>} */
        this.listeners = new Set();
    }

    /**
     * @param {string} id
     * @returns {T|undefined}
     */
    get(id) {
        return this.dict[id];
    }

    /**
     * @param {string} id
     * @returns {boolean}
     */
    has(id) {
        return Object.hasOwn(this.dict, id);
    }

    /** @returns {{[id: string]: T}} */
    getAll() {
        return this.dict;
    }

    /**
     * @param {string} id
     * @returns {EntityChange<T>?}
     */
    create(id, entity) {
        if (this.has(id)) return null;
        this.dict[id] = entity;
        return this._emit({ op: 'created', id, entity });
    }

    update(id, patch) {
        const entity = this.dict[id];
        if (!entity) return null;
        Object.assign(entity, patch);
        return this._emit({ op: 'updated', id, entity, patch });
    }

    /**
     * @param {string} id
     * @returns {EntityChange<T>?}
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

    reset() {
        return this._emit({ op: 'reset' });
    }

    reportCreated(id) {
        const entity = this.dict[id];
        if (!entity) return null;
        return this._emit({ op: 'created', id, entity });
    }

    reportRemoved(id, entity) {
        return this._emit({ op: 'removed', id, entity });
    }

    /**
     * @param {string} oldId
     * @param {string} newId
     * @returns {EntityChange<T>?}
     */
    reportRenamed(oldId, newId) {
        const entity = this.dict[newId];
        if (!entity) return null;
        return this._emit({ op: 'renamed', oldId, newId, entity });
    }

    /**
     * @param {(change: EntityChange<T>) => void} listener
     * @returns {() => void}
     */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * @param {EntityChange<T>} change
     * @returns {EntityChange<T>}
     */
    _emit(change) {
        for (const listener of this.listeners) {
            listener(change);
        }
        return change;
    }
}

