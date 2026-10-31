/**
 * @param {() => Record<string, any>} store
 * @param {object} [options]
 * @param {() => void} [options.changed]
 * @param {(value: any, type: string) => any} [options.convert]
 * @returns {import('./macros/engine/MacroEnv.types.js').MacroVariableScope}
 */
export function createVariableScope(store, { changed = () => {}, convert = value => value } = {}) {
    const asValue = (/** @type {any} */ raw) => (raw?.trim?.() === '' || isNaN(Number(raw))) ? (raw || '') : Number(raw);

    /** @type {import('./macros/engine/MacroEnv.types.js').MacroVariableScope['get']} */
    const get = (name, args = {}) => {
        let value = store()[args.key ?? name];
        if (args.index !== undefined) {
            try {
                value = JSON.parse(value);
                const numIndex = Number(args.index);
                value = Number.isNaN(numIndex) ? value[args.index] : value[numIndex];
                if (typeof value == 'object') {
                    value = JSON.stringify(value);
                }
            } catch {
                // not a list or an object: the value as it is
            }
        }
        return asValue(value);
    };

    /** @type {import('./macros/engine/MacroEnv.types.js').MacroVariableScope['set']} */
    const set = (name, value, args = {}) => {
        if (!name) {
            throw new Error('Variable name cannot be empty or undefined.');
        }
        const values = store();
        if (args.index !== undefined) {
            try {
                let parsed = JSON.parse(values[name] ?? 'null');
                const numIndex = Number(args.index);
                if (Number.isNaN(numIndex)) {
                    parsed ??= {};
                    parsed[args.index] = convert(value, args.as);
                } else {
                    parsed ??= [];
                    parsed[numIndex] = convert(value, args.as);
                }
                values[name] = JSON.stringify(parsed);
            } catch {
                // not a list or an object: left as it is
            }
        } else {
            values[name] = value;
        }
        changed();
        return value;
    };

    /** @type {import('./macros/engine/MacroEnv.types.js').MacroVariableScope['has']} */
    const has = name => store()[name] !== undefined;

    /** @type {import('./macros/engine/MacroEnv.types.js').MacroVariableScope['add']} */
    const add = (name, value) => {
        const currentValue = get(name) || 0;
        try {
            const parsedValue = JSON.parse(String(currentValue));
            if (Array.isArray(parsedValue)) {
                parsedValue.push(value);
                set(name, JSON.stringify(parsedValue));
                return parsedValue;
            }
        } catch {
            // not a list
        }
        const increment = Number(value);
        if (isNaN(increment) || isNaN(Number(currentValue))) {
            const stringValue = String(currentValue || '') + value;
            set(name, stringValue);
            return stringValue;
        }
        const newValue = Number(currentValue) + increment;
        if (isNaN(newValue)) {
            return '';
        }
        set(name, newValue);
        return newValue;
    };

    return {
        get,
        set,
        has,
        add,
        inc: name => add(name, 1),
        dec: name => add(name, -1),
        del: (name) => {
            if (!has(name)) {
                console.warn(`The variable "${name}" does not exist.`);
                return '';
            }
            delete store()[name];
            changed();
            return '';
        },
    };
}
