/**
 * A Map that deep-clones values on set/get so stored objects can't be mutated by reference.
 *
 * @template K, V
 * @extends Map<K, V>
 */
export class StructuredCloneMap extends Map {
    /**
     * @param {object} options
     * @param {boolean} options.cloneOnGet
     * @param {boolean} options.cloneOnSet
     */
    constructor({ cloneOnGet, cloneOnSet } = { cloneOnGet: true, cloneOnSet: true }) {
        super();
        this.cloneOnGet = cloneOnGet;
        this.cloneOnSet = cloneOnSet;
    }

    set(key, value) {
        if (!this.cloneOnSet) {
            return super.set(key, value);
        }

        const clonedValue = structuredClone(value);
        super.set(key, clonedValue);
        return this;
    }

    get(key) {
        if (!this.cloneOnGet) {
            return super.get(key);
        }

        const value = super.get(key);
        return structuredClone(value);
    }
}
