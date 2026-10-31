import { TYPE } from '../library-codes.js';
import { draft, without } from './entity-draft.js';

export const TEMPLATE_KINDS = Object.freeze(['instruct', 'context', 'sysprompt', 'reasoning']);

const BOUND_KINDS = Object.freeze(['instruct', 'context']);

/** @typedef {import('./entity-draft.js').EntityDraft} EntityDraft */

/**
 * @param {string} kind
 * @param {string} name
 */
export function templateKey(kind, name) {
    if (!TEMPLATE_KINDS.includes(kind)) throw new Error(`no template kind ${kind}`);
    return `${kind}:${name}`;
}

/**
 * @param {string} kind
 * @param {string} name
 * @param {Record<string, unknown>} file
 * @returns {EntityDraft}
 */
export function templateFromUpstream(kind, name, file) {
    return draft(TYPE.template, templateKey(kind, name), { ...file });
}

/**
 * @param {EntityDraft} template
 * @returns {Record<string, unknown>}
 */
export function templateToUpstream(template) {
    return { ...template.values };
}

/**
 * @param {string} model
 * @param {Record<string, unknown>} binding
 * @returns {EntityDraft}
 */
export function bindingFromUpstream(model, binding) {
    /** @type {Record<string, unknown>} */
    const values = without(binding, BOUND_KINDS);
    for (const kind of BOUND_KINDS) {
        if (Object.hasOwn(binding, kind)) {
            values[kind] = typeof binding[kind] === 'string' ? templateKey(kind, binding[kind]) : binding[kind];
        }
    }
    return draft(TYPE.modelTemplateBinding, model, values);
}

/**
 * @param {EntityDraft} binding
 * @returns {Record<string, unknown>}
 */
export function bindingToUpstream(binding) {
    /** @type {Record<string, unknown>} */
    const entry = { ...binding.values };
    for (const kind of BOUND_KINDS) {
        const ref = entry[kind];
        if (typeof ref === 'string') entry[kind] = ref.slice(kind.length + 1);
    }
    return entry;
}
