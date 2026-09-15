/**
 * A server-native LLM function-calling tool registry.
 *
 * This is the server-side analogue of `ToolManager`/`registerFunctionTool()` in
 * `public/scripts/tool-calling.js`, but for tools that a *server plugin* wants to expose to the
 * model directly, without a client round-trip per call. This module is intentionally a small,
 * generic, in-memory registry with no dependencies on Express, HTTP requests, or SillyTavern's
 * user-directory model - it knows nothing about `directories`, request objects, or any of that, so
 * it stays trivially unit-testable and reusable regardless of how (or whether) it eventually gets
 * wired into the generation pipeline.
 *
 * Wiring this registry into the actual chat-completion generation loop, invoking tools during a
 * real request, and defining the real shape of the `ctx` object passed to `invoke`/`shouldEnable`
 * (e.g. `{directories, ownerId, characterAvatar, groupId}`) is explicitly OUT OF SCOPE for this
 * module - that is left entirely to the caller. This module only stores registrations and answers
 * queries about them.
 *
 * ## `id` vs `name`
 *
 * Unlike the client-side `ToolManager`, which keys tools by a single `name` field, this registry
 * uses two separate fields:
 * - `id`: an internal bookkeeping key used for `unregisterServerTool()` and to detect duplicate
 *   registrations. By convention (not enforced here), plugin authors should namespace their `id`s
 *   with their own plugin id, e.g. `weather-tool:get_weather`, so two unrelated plugins can't
 *   accidentally collide. This id is never sent to the model.
 * - `name`: the actual OpenAI-wire function name sent to the model in the tool schema. Two
 *   different `id`s are not allowed to register the same `name`, since the model has no way to
 *   disambiguate two identically-named functions.
 *
 * ## Registration failures are loud
 *
 * Every validation failure and every collision throws a real `Error` at registration time, rather
 * than silently overwriting (as the client's `registerFunctionTool()` does) or silently dropping
 * the registration. Server plugins are far less discoverable/debuggable than an in-session client
 * script - there's no console to immediately notice a silent overwrite - so a loud failure at
 * `init()` time is the right default: it fails the plugin's own startup instead of producing a
 * confusing runtime mismatch later.
 */

/**
 * @typedef {object} ServerToolRegistration
 * @property {string} id A unique, plugin-namespaced bookkeeping key for this tool (e.g.
 *   `weather-tool:get_weather`). Used only for `unregisterServerTool()` and duplicate detection -
 *   never sent to the model. Convention, not enforced: prefix with your plugin's own id.
 * @property {string} name The OpenAI-wire function name sent to the model. Must be unique across
 *   all currently-registered tools (regardless of `id`).
 * @property {string} description A human/model-readable description of what the tool does.
 * @property {object} parameters A JSON-schema-shaped plain object describing the tool's
 *   parameters. This module does not validate JSON-schema correctness beyond checking it is a
 *   plain object.
 * @property {(args: object, ctx: any) => Promise<any>} invoke Called to actually run the tool.
 *   Receives `args` (the parsed-JSON tool call arguments, a plain object) and `ctx`, an opaque
 *   value chosen entirely by whoever calls `invoke` - this module never constructs, inspects, or
 *   validates `ctx`, it is purely passed through.
 * @property {(ctx: any) => Promise<boolean>} [shouldEnable] Optional async predicate deciding
 *   whether this tool is currently enabled. Not called by this module directly during
 *   registration or `getRegisteredServerTools()` - only `getEnabledServerTools(ctx)` calls it. A
 *   missing `shouldEnable` means the tool is always enabled.
 */

/**
 * @typedef {object} OpenAIToolSchema
 * @property {'function'} type
 * @property {{name: string, description: string, parameters: object}} function
 */

/**
 * Live registry of all currently-registered server tools, keyed by `id`.
 * @type {Map<string, ServerToolRegistration>}
 */
const registeredTools = new Map();

/**
 * Reverse index from model-facing `name` to the owning `id`, used to detect name collisions across
 * different `id`s in O(1) without scanning the whole map on every registration.
 * @type {Map<string, string>}
 */
const nameToId = new Map();

/**
 * Checks whether a value is a non-empty string.
 * @param {unknown} value The value to check.
 * @returns {boolean} True if `value` is a string with at least one character.
 */
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}

/**
 * Checks whether a value is a plain object suitable for holding a JSON-schema-shaped `parameters`
 * value. Deliberately shallow: this only rules out `null`, arrays, and non-objects. It does not
 * attempt to validate that the object is a *correct* JSON schema - that's the plugin author's
 * responsibility, and it's not this module's job to be a JSON-schema validator.
 * @param {unknown} value The value to check.
 * @returns {boolean} True if `value` is a non-null, non-array object.
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Registers a server-native tool that a plugin can expose to the model for function calling,
 * without any client round-trip.
 *
 * Validates all required fields and throws a descriptive `Error` for the first violation found -
 * this is a programming-error surface for plugin authors (analogous to the `id`/`name`/
 * `description` validation `plugin-loader.js` itself performs on plugin `info`), not untrusted
 * end-user input, so throwing rather than silently dropping the registration is correct.
 *
 * Also throws if `id` is already registered, or if `name` is already registered under a
 * *different* `id` - re-registering the exact same `id` twice with the exact same `name` is still
 * rejected (as an `id` collision) because plugins are expected to explicitly
 * `unregisterServerTool()` before re-registering (e.g. on hot-reload), not rely on implicit
 * overwrite semantics.
 *
 * @param {ServerToolRegistration} tool The tool to register.
 * @returns {void}
 * @throws {Error} If any required field is missing/invalid, or if `id`/`name` collides with an
 *   existing registration.
 */
export function registerServerTool({ id, name, description, parameters, invoke, shouldEnable } = {}) {
    if (!isNonEmptyString(id)) {
        throw new Error('registerServerTool: "id" must be a non-empty string');
    }
    if (!isNonEmptyString(name)) {
        throw new Error('registerServerTool: "name" must be a non-empty string');
    }
    if (!isNonEmptyString(description)) {
        throw new Error('registerServerTool: "description" must be a non-empty string');
    }
    if (!isPlainObject(parameters)) {
        throw new Error('registerServerTool: "parameters" must be a plain object (JSON-schema-shaped)');
    }
    if (typeof invoke !== 'function') {
        throw new Error('registerServerTool: "invoke" must be a function');
    }
    if (shouldEnable !== undefined && typeof shouldEnable !== 'function') {
        throw new Error('registerServerTool: "shouldEnable" must be a function when provided');
    }

    if (registeredTools.has(id)) {
        throw new Error(`registerServerTool: a tool with id "${id}" is already registered`);
    }

    const existingOwnerId = nameToId.get(name);
    if (existingOwnerId !== undefined && existingOwnerId !== id) {
        throw new Error(`registerServerTool: a tool with name "${name}" is already registered (by id "${existingOwnerId}") - the model can't disambiguate two tools with the same name`);
    }

    registeredTools.set(id, { id, name, description, parameters, invoke, shouldEnable });
    nameToId.set(name, id);
}

/**
 * Removes a previously-registered server tool. Safe to call for an `id` that isn't registered
 * (e.g. a plugin's `exit()` running after a failed `init()`) - it's a no-op in that case, mirroring
 * `ToolManager.unregisterFunctionTool()`'s tolerant behavior.
 * @param {string} id The `id` of the tool to remove.
 * @returns {void}
 */
export function unregisterServerTool(id) {
    const tool = registeredTools.get(id);
    if (!tool) {
        return;
    }
    registeredTools.delete(id);
    // Only clear the name index if it still points at this id - guards against any future
    // rename/overwrite path leaving the reverse index pointing at a live registration.
    if (nameToId.get(tool.name) === id) {
        nameToId.delete(tool.name);
    }
}

/**
 * Returns the live list of all currently-registered server tools.
 *
 * Note: this returns the actual internal registration objects (not deep copies) inside a fresh
 * array - the array itself is safe to mutate (it won't affect the registry), but the tool objects
 * it contains are the same objects held internally, including live references to `invoke`/
 * `shouldEnable` functions. Callers should treat the returned tool objects as read-only.
 * @returns {ServerToolRegistration[]} All registered tools, in registration order.
 */
export function getRegisteredServerTools() {
    return Array.from(registeredTools.values());
}

/**
 * Returns the subset of registered server tools that are currently enabled for the given context,
 * per each tool's own `shouldEnable` predicate. A tool with no `shouldEnable` is always considered
 * enabled.
 *
 * This is the one piece of caller-facing filtering logic this module owns outright: "which
 * registered tools are enabled right now" is a natural registry-level query that every caller
 * would otherwise have to reimplement identically. Constructing `ctx` itself, however, is entirely
 * the caller's responsibility - this module has no idea what a meaningful `ctx` looks like.
 * @param {any} ctx Opaque context forwarded verbatim to each tool's `shouldEnable(ctx)`.
 * @returns {Promise<ServerToolRegistration[]>} The tools whose `shouldEnable(ctx)` resolved truthy
 *   (or which have no `shouldEnable` at all), in registration order.
 */
export async function getEnabledServerTools(ctx) {
    const tools = getRegisteredServerTools();
    const enabledFlags = await Promise.all(tools.map(tool => (
        typeof tool.shouldEnable === 'function' ? tool.shouldEnable(ctx) : true
    )));
    return tools.filter((_tool, index) => enabledFlags[index]);
}

/**
 * Converts a registered server tool into the OpenAI-wire tool schema shape expected by chat
 * completion APIs, mirroring `ToolDefinition.toFunctionOpenAI()` in
 * `public/scripts/tool-calling.js` (minus that class's client-only `toString()` toast-formatting
 * helper, which has no server-side meaning).
 * @param {ServerToolRegistration} tool A registered tool (or any object with the same
 *   `name`/`description`/`parameters` shape).
 * @returns {OpenAIToolSchema} The `{type: 'function', function: {name, description, parameters}}`
 *   schema for this tool.
 */
export function toOpenAIToolSchema(tool) {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    };
}
