/**
 * `chat_metadata` as the state at the page's position (state layer 1, build path 5b): what the page sends of it, and
 * how it takes the server's. Chat variables travel one by one, as top-level keys do, so tabs and users changing
 * different variables keep each other's. Dependency-free, so it is importable under Node tests.
 */

/** Keys the server derives (`integrity` is the session's UUID): never sent. */
const DERIVED = new Set(['integrity']);

/**
 * @typedef {{ set: Record<string, unknown>, unset: string[] }} KeyChanges
 * @typedef {KeyChanges & { variables: KeyChanges }} MetadataChanges What the page sends: `set` and `unset` per
 * top-level key (`variables` there only as the object being made, `{}`, or removed with every variable in it), and
 * `variables` per chat variable.
 */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Each key's value as JSON, as the page last had it from the server or last stored it.
 * @param {Record<string, unknown> | null | undefined} metadata
 * @returns {Map<string, string>}
 */
export function baselineOf(metadata) {
    const baseline = new Map();
    for (const [key, value] of Object.entries(metadata ?? {})) {
        if (DERIVED.has(key) || value === undefined) continue;
        baseline.set(key, JSON.stringify(value));
    }
    return baseline;
}

/**
 * The variables a baseline holds, each as JSON (none when `variables` isn't an object there).
 * @param {Map<string, string>} baseline
 * @returns {Map<string, string>}
 */
function baselineVariables(baseline) {
    const json = baseline.get('variables');
    const parsed = json === undefined ? undefined : JSON.parse(json);
    if (!isObject(parsed)) return new Map();
    return new Map(Object.entries(parsed).map(([name, v]) => [name, JSON.stringify(v)]));
}

/**
 * What changed in `metadata` since `baseline`, or null when nothing did. A variable is sent when its value differs
 * from the baseline's, so `variables` replaced wholesale (an extension assigning a new object) sends only the
 * variables that differ, and one missing from it is removed by name.
 * @param {Record<string, unknown>} metadata
 * @param {Map<string, string>} baseline
 * @returns {MetadataChanges | null}
 */
export function metadataChanges(metadata, baseline) {
    /** @type {MetadataChanges} */
    const changes = { set: {}, unset: [], variables: { set: {}, unset: [] } };
    const current = baselineOf(metadata);
    const was = baseline.get('variables');
    const wasObject = was !== undefined && isObject(JSON.parse(was));
    const vars = metadata.variables;
    for (const [key, json] of current) {
        if (key === 'variables' && isObject(vars)) {
            if (!wasObject) changes.set.variables = {};
            continue;
        }
        if (baseline.get(key) !== json) changes.set[key] = metadata[key];
    }
    for (const key of baseline.keys()) {
        if (!current.has(key)) changes.unset.push(key);
    }
    // Removing the object removes every variable in it; otherwise the variables are compared one by one.
    if (isObject(vars)) {
        const before = wasObject ? baselineVariables(baseline) : new Map();
        for (const [name, v] of Object.entries(vars)) {
            if (v === undefined) continue;
            if (before.get(name) !== JSON.stringify(v)) changes.variables.set[name] = v;
        }
        for (const name of before.keys()) {
            if (!Object.hasOwn(vars, name) || vars[name] === undefined) changes.variables.unset.push(name);
        }
    }
    const any = Object.keys(changes.set).length || changes.unset.length
        || Object.keys(changes.variables.set).length || changes.variables.unset.length;
    return any ? changes : null;
}

/**
 * The baseline once the server stored `changes`.
 * @param {Map<string, string>} baseline
 * @param {MetadataChanges} changes
 * @returns {Map<string, string>}
 */
export function baselineAfter(baseline, changes) {
    const next = new Map(baseline);
    let vars = isObject(JSON.parse(next.get('variables') ?? 'null')) ? baselineVariables(next) : null;
    for (const [key, value] of Object.entries(changes.set)) {
        if (key === 'variables' && isObject(value)) {
            vars ??= new Map();
            continue;
        }
        next.set(key, JSON.stringify(value));
        if (key === 'variables') vars = null;
    }
    for (const key of changes.unset) {
        next.delete(key);
        if (key === 'variables') vars = null;
    }
    // Setting a variable makes the object, as it does on the server.
    if (vars === null && Object.keys(changes.variables.set).length) vars = new Map();
    if (vars !== null) {
        for (const [name, v] of Object.entries(changes.variables.set)) vars.set(name, JSON.stringify(v));
        for (const name of changes.variables.unset) vars.delete(name);
        next.set('variables', JSON.stringify(Object.fromEntries([...vars].map(([name, json]) => [name, JSON.parse(json)]))));
    }
    return next;
}

/**
 * Replaces `target`'s contents with `state`, in place, so whatever holds `chat_metadata` (or its `variables`
 * object) sees the new state: keys in the server's order, the `variables` object kept when both are objects.
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} state
 */
export function replaceInPlace(target, state) {
    const vars = target.variables;
    for (const key of Object.keys(target)) delete target[key];
    for (const [key, value] of Object.entries(state)) {
        if (key === 'variables' && isObject(vars) && isObject(value)) {
            for (const name of Object.keys(vars)) delete vars[name];
            Object.assign(vars, value);
            target.variables = vars;
        } else {
            target[key] = value;
        }
    }
}

/**
 * The variables a refused or failed save didn't store, for the error naming them.
 * @param {MetadataChanges} changes
 * @returns {string[]}
 */
export function unsavedVariables(changes) {
    const names = [...Object.keys(changes.variables.set), ...changes.variables.unset];
    return [...new Set(names)];
}

/**
 * Whether a state change recorded at `at` (a message's id; null: the tree's root) changes the state at the page's
 * position: it is on the page's path, root to pointer.
 * @param {string | null} at
 * @param {{ node_id?: string }[]} path
 */
export function changesStateHere(at, path) {
    return at === null || path.some(m => m?.node_id === at);
}
