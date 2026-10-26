import { TYPE } from '../library-codes.js';
import { draft, without } from './entity-draft.js';

/**
 * Templates and the model bindings that pick them, as the settings model holds them (§1.3, §1.7, step 3b), made from
 * upstream's files and given back as them.
 *
 * - A template is a bundle (`TYPE.template`, key `<kind>:<name>`), one value per field of its file, named as the file
 *   names them; `extensions` and any field that isn't upstream's are kept as they came.
 * - A model binding (`TYPE.modelTemplateBinding`, key the model id or the chat template's hash, as upstream's
 *   `power_user.model_templates_mappings` keys it) refers to the templates it picks by their keys.
 */

/** The kinds of template, by their folders under `presets/` (and upstream's `power_user` keys). */
export const TEMPLATE_KINDS = Object.freeze(['instruct', 'context', 'sysprompt', 'reasoning']);

/** The template kinds a binding picks. */
const BOUND_KINDS = Object.freeze(['instruct', 'context']);

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 */

/**
 * The key of a template.
 * @param {string} kind One of TEMPLATE_KINDS.
 * @param {string} name
 */
export function templateKey(kind, name) {
    if (!TEMPLATE_KINDS.includes(kind)) throw new Error(`no template kind ${kind}`);
    return `${kind}:${name}`;
}

/**
 * A template made from its upstream file.
 * @param {string} kind One of TEMPLATE_KINDS.
 * @param {string} name
 * @param {Record<string, unknown>} file
 * @returns {EntityDraft}
 */
export function templateFromUpstream(kind, name, file) {
    return draft(TYPE.template, templateKey(kind, name), { ...file });
}

/**
 * A template's upstream file.
 * @param {EntityDraft} template
 * @returns {Record<string, unknown>}
 */
export function templateToUpstream(template) {
    return { ...template.values };
}

/**
 * A model binding made from one entry of `power_user.model_templates_mappings`.
 * @param {string} model The model id or chat template hash.
 * @param {Record<string, unknown>} binding `{ instruct?, context? }`, template names.
 * @returns {EntityDraft}
 */
export function bindingFromUpstream(model, binding) {
    /** @type {Record<string, unknown>} */
    const values = without(binding, BOUND_KINDS);
    for (const kind of BOUND_KINDS) {
        // A name that isn't text isn't a template's: kept as it came.
        if (Object.hasOwn(binding, kind)) {
            values[kind] = typeof binding[kind] === 'string' ? templateKey(kind, binding[kind]) : binding[kind];
        }
    }
    return draft(TYPE.modelTemplateBinding, model, values);
}

/**
 * A model binding as upstream's mapping entry.
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
