/**
 * @typedef {object} ServerToolRegistration
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {object} parameters
 * @property {(args: object, ctx: any) => Promise<any>} invoke
 * @property {(ctx: any) => Promise<boolean>} [shouldEnable]
 */

/**
 * @typedef {object} OpenAIToolSchema
 * @property {'function'} type
 * @property {{name: string, description: string, parameters: object}} function
 */

/** @type {Map<string, ServerToolRegistration>} */
const registeredTools = new Map();

/** @type {Map<string, string>} */
const nameToId = new Map();

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {ServerToolRegistration} tool
 * @returns {void}
 * @throws {Error}
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
 * @param {string} id
 * @returns {void}
 */
export function unregisterServerTool(id) {
    const tool = registeredTools.get(id);
    if (!tool) {
        return;
    }
    registeredTools.delete(id);
    if (nameToId.get(tool.name) === id) {
        nameToId.delete(tool.name);
    }
}

/**
 * @returns {ServerToolRegistration[]}
 */
export function getRegisteredServerTools() {
    return Array.from(registeredTools.values());
}

/**
 * @param {any} ctx
 * @returns {Promise<ServerToolRegistration[]>}
 */
export async function getEnabledServerTools(ctx) {
    const tools = getRegisteredServerTools();
    const enabledFlags = await Promise.all(tools.map(tool => (
        typeof tool.shouldEnable === 'function' ? tool.shouldEnable(ctx) : true
    )));
    return tools.filter((_tool, index) => enabledFlags[index]);
}

/**
 * @param {ServerToolRegistration} tool
 * @returns {OpenAIToolSchema}
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
