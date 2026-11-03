export const ROOT = 'prompt';

const TEXT = Symbol('own text');
const OUTLET_START = '\uE000';
const OUTLET_END = '\uE001';
const OUTLET_PATTERN = /\uE000([^\uE000\uE001]*)\uE001/g;

/** @typedef {'system'|'user'|'assistant'|'tool'} Role */

/**
 * @typedef {object} Position
 * @property {true} [first] The parent's first children, before its own text.
 * @property {true} [last] The parent's last children, after its own text.
 * @property {string} [before] Next to that section, in its parent.
 * @property {string} [after] Next to that section, in its parent.
 * @property {number} [fromEnd] Among the children the parent's provider made, with n of them after it.
 * @property {number} [fromStart] Among the children the parent's provider made, with n of them before it.
 * @property {number} [fromEndRendered] With n of everything rendered in the parent after it, counted once the budget
 * has settled what's in.
 * @property {string} [outlet] Where the parent's text says `{{outlet::name}}`. Set by the core for declared outlets.
 */

/**
 * @typedef {object} Joins
 * @property {boolean} [trimNewline] The previous one loses one trailing newline first.
 * @property {boolean} [breakBefore] A newline goes between them unless the previous one already ends with one.
 * @property {boolean} [spaceBefore] A space goes between them unless the previous one already ends with whitespace.
 */

/**
 * @typedef {{ always: true } | { types: string[] } | { all: Condition[] } | { any: Condition[] } | { not: Condition } | { is: boolean, by: string }} Condition
 */

/**
 * @typedef {object} ComposeArgs
 * @property {string} inner The section's own text and children as they'd join without a template.
 * @property {(id: string) => string} child A child's rendered text ('' when it isn't in the prompt).
 * @property {(name: string) => string} outlet An outlet's rendered text.
 */

/**
 * @typedef {object} Section
 * @property {string} id Stable; what placements refer to.
 * @property {string} [parent] Its parent's id; none is the prompt itself.
 * @property {Position} [at]
 * @property {number} [order] The sort key among siblings at the same position, then id.
 * @property {string} [fallback] The parent to use when its own isn't in this prompt (placed last there).
 * @property {Condition} [when] An entry's condition; a section without one is always there.
 * @property {string} [text] Its own text, macros already resolved. `outletMarker(name)` marks an outlet it declares.
 * @property {(args: ComposeArgs) => string} [compose] A template over its children, instead of joining them.
 * @property {string[]} [outlets] The outlets a template declares.
 * @property {string} [provider] The provider whose sections become its children.
 * @property {string} [providedBy] Set on the sections a provider made, to their parent's id.
 * @property {Role} [role] A section with a role is a message; its descendants' text is the message's.
 * @property {string} [name] Who speaks the message.
 * @property {'keep'|'drop'|'trim'} [budget] Kept whole (default), dropped whole, or trimmed by dropping its children.
 * @property {number} [priority] Its place in the fill order of what can be dropped (lower first).
 * @property {'start'|'end'} [trimFrom] Which end a trimmed section loses children from first.
 * @property {string} [join] Put between its own text and children's.
 * @property {boolean} [trimEach] Each piece is trimmed before joining.
 * @property {boolean} [skipEmpty] Empty pieces aren't joined, and with nothing in it the section isn't rendered.
 * @property {'start'|'both'} [trim] The joined result is trimmed.
 * @property {Joins} [joins] Text: it joins the previous message instead of standing on its own.
 * @property {boolean} [squash] Chat: it joins a neighbouring system message.
 * @property {boolean} [continued] The reply continues this message.
 * @property {string} [part] What it's listed as in the prompt's itemization.
 * @property {Record<string, any>} [data] What a format needs beyond text (speaker details, media, tool calls).
 */

/**
 * @typedef {object} PlacedNode
 * @property {Section} section
 * @property {Array<PlacedNode|typeof TEXT>} items
 * @property {Map<string, PlacedNode>} outlets
 * @property {PlacedNode[]} deferred
 */

export class PromptPlacementError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PromptPlacementError';
    }
}

export class PromptOverBudgetError extends Error {
    /**
     * @param {number} budget
     * @param {number} kept
     * @param {{ id: string, tokens: number }[]} sections
     */
    constructor(budget, kept, sections) {
        const listed = sections.map(s => `${s.id} (${s.tokens})`).join(', ');
        super(`The prompt doesn't fit: what's always sent takes ${kept} tokens and the budget is ${budget}. The largest parts: ${listed}.`);
        this.name = 'PromptOverBudgetError';
        this.budget = budget;
        this.kept = kept;
        this.sections = sections;
    }
}

/**
 * @param {string} name
 * @returns {string}
 */
export function outletMarker(name) {
    return `${OUTLET_START}${name}${OUTLET_END}`;
}

export const outletMarkers = new Proxy({}, {
    get: (_, key) => (typeof key === 'string' ? outletMarker(key) : undefined),
    has: () => true,
});

/**
 * @param {string} text
 * @returns {string}
 */
export function withoutOutletMarkers(text) {
    return typeof text === 'string' ? text.replace(OUTLET_PATTERN, '') : text;
}

/**
 * @param {string} name
 * @returns {string}
 */
export function outletId(name) {
    return `outlet:${name}`;
}

/**
 * @param {Section} section
 * @returns {string[]}
 */
function declaredOutlets(section) {
    const names = new Set(section.outlets ?? []);
    if (typeof section.text === 'string') {
        for (const match of section.text.matchAll(OUTLET_PATTERN)) names.add(match[1]);
    }
    return [...names];
}

/** @type {Map<string, (state: any) => Section[] | Promise<Section[]>>} */
/** @type {Map<string, (state: any) => Section[] | Promise<Section[]>>} */
const providers = new Map();

/**
 * @param {string} id
 * @param {(state: any) => Section[] | Promise<Section[]>} provide
 */
export function registerProvider(id, provide) {
    providers.set(id, provide);
}

/**
 * @param {string} id
 * @param {any} state
 * @returns {Promise<Section[]>}
 */
export async function provide(id, state) {
    const provider = providers.get(id);
    if (!provider) throw new Error(`No provider is registered as "${id}"`);
    return provider(state);
}

/**
 * @param {Condition|undefined} condition
 * @param {{ type?: string }} facts
 * @returns {boolean}
 */
export function isActive(condition, facts) {
    if (!condition) return true;
    if ('always' in condition) return true;
    if ('types' in condition) return condition.types.length === 0 || condition.types.includes(String(facts.type ?? 'normal'));
    if ('all' in condition) return condition.all.every(c => isActive(c, facts));
    if ('any' in condition) return condition.any.some(c => isActive(c, facts));
    if ('not' in condition) return !isActive(condition.not, facts);
    if ('is' in condition) return condition.is;
    return false;
}

/**
 * @param {Section[]} sections
 * @param {{ type?: string }} facts
 * @param {Record<string, any>} [providerState] Each provider's state, by provider id.
 * @returns {Promise<Section[]>}
 */
export async function collectSections(sections, facts, providerState = {}) {
    const active = sections.filter(s => isActive(s.when, facts));
    /** @type {Section[]} */
    const out = [];
    for (const section of active) {
        out.push(section);
        if (!section.provider) continue;
        const made = await provide(section.provider, providerState[section.provider]);
        for (const child of made) {
            if (!isActive(child.when, facts)) continue;
            out.push(child.parent ? child : { ...child, parent: section.id, providedBy: section.id });
        }
    }
    return out;
}

/**
 * @param {Section} a
 * @param {Section} b
 * @returns {number}
 */
function bySortKey(a, b) {
    return (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * @param {Section[]} sections
 * @returns {{ root: PlacedNode, unplaced: { id: string, reason: string }[], byId: Map<string, Section> }}
 */
export function place(sections) {
    /** @type {Map<string, Section>} */
    const byId = new Map();
    for (const section of sections) {
        if (section.id === ROOT || byId.has(section.id)) throw new PromptPlacementError(`Two sections are called "${section.id}"`);
        byId.set(section.id, section);
    }
    for (const section of [...byId.values()]) {
        for (const name of declaredOutlets(section)) {
            const id = outletId(name);
            if (!byId.has(id)) byId.set(id, { id, parent: section.id, at: { outlet: name }, join: '\n' });
        }
    }

    /** @type {Map<string, string|null>} */
    const parentOf = new Map();

    /** @type {Set<string>} */
    const fellBack = new Set();

    /** @type {Map<string, string>} */
    const reasons = new Map();

    /** @type {Set<string>} */
    const resolving = new Set();

    /**
     * @param {string} id
     * @returns {boolean}
     */
    function resolve(id) {
        if (id === ROOT) return true;
        if (parentOf.has(id)) return parentOf.get(id) !== null;
        const section = byId.get(id);
        if (!section) return false;
        if (resolving.has(id)) throw new PromptPlacementError(`The placement of "${id}" loops back to itself`);
        resolving.add(id);
        const anchor = section.at?.before ?? section.at?.after;

        let parent;
        let reason = '';
        if (anchor !== undefined) {
            parent = resolve(anchor) ? (parentOf.get(anchor) ?? ROOT) : null;
            if (parent === null) reason = `"${anchor}", which it goes next to, isn't in this prompt`;
        } else {
            parent = section.parent ?? ROOT;
            if (parent !== ROOT && !resolve(parent)) {
                reason = `its parent "${parent}" isn't in this prompt`;
                parent = null;
            }
        }
        if (parent === null && section.fallback && resolve(section.fallback)) {
            parent = section.fallback;
            fellBack.add(id);
        }
        resolving.delete(id);
        parentOf.set(id, parent);
        if (parent === null) reasons.set(id, reason);
        return parent !== null;
    }

    /** @type {Map<string, Section[]>} */
    const kids = new Map();
    for (const id of byId.keys()) {
        if (!resolve(id)) continue;
        const parent = (parentOf.get(id));
        if (!kids.has(parent)) kids.set(parent, []);
        kids.get(parent)?.push(/** @type {Section} */ (byId.get(id)));
    }

    /**
     * @param {Section} section
     * @returns {PlacedNode}
     */
    function build(section) {
        const list = kids.get(section.id) ?? [];
        const provided = list.filter(c => c.providedBy === section.id && !fellBack.has(c.id));
        const others = list.filter(c => !provided.includes(c));
        const k = provided.length;
        /** @type {Section[]} */
        const firsts = [];
        /** @type {Section[]} */
        const lasts = [];

        /** @type {{ section: Section, kind: number, dist: number }[][]} */
        const slots = Array.from({ length: k + 1 }, () => []);
        /** @type {Section[]} */
        const around = [];
        /** @type {Section[]} */
        const deferred = [];
        /** @type {Map<string, Section>} */
        const outlets = new Map();
        for (const child of others) {
            const at = /** @type {Position} */ (fellBack.has(child.id) ? { last: true } : (child.at ?? { last: true }));
            if (at.outlet !== undefined) outlets.set(at.outlet, child);
            else if (at.before !== undefined || at.after !== undefined) around.push(child);
            else if (at.fromEndRendered !== undefined) deferred.push(child);
            else if (at.fromEnd !== undefined) slots[Math.min(Math.max(k - at.fromEnd, 0), k)].push({ section: child, kind: 1, dist: -at.fromEnd });
            else if (at.fromStart !== undefined) slots[Math.min(Math.max(at.fromStart, 0), k)].push({ section: child, kind: 0, dist: at.fromStart });
            else if (at.first) firsts.push(child);
            else lasts.push(child);
        }
        firsts.sort(bySortKey);
        lasts.sort(bySortKey);
        for (const slot of slots) slot.sort((a, b) => a.kind - b.kind || a.dist - b.dist || bySortKey(a.section, b.section));

        /** @type {Array<Section|typeof TEXT>} */
        const ordered = [...firsts, TEXT];
        for (let i = 0; i <= k; i++) {
            ordered.push(...slots[i].map(x => x.section));
            if (i < k) ordered.push(provided[i]);
        }
        ordered.push(...lasts);

        around.sort(bySortKey);
        let pending = around;
        while (pending.length) {
            /** @type {Section[]} */
            const next = [];
            for (const child of pending) {
                const target = (child.at?.before ?? child.at?.after);
                const index = ordered.findIndex(x => x !== TEXT && x.id === target);
                if (index < 0) {
                    next.push(child);
                    continue;
                }
                if (child.at?.before !== undefined) {
                    let insertAt = index;
                    while (insertAt > 0 && isAroundOf(ordered[insertAt - 1], target, 'before') && bySortKey(/** @type {Section} */ (ordered[insertAt - 1]), child) > 0) insertAt--;
                    ordered.splice(insertAt, 0, child);
                } else {
                    let insertAt = index + 1;
                    while (insertAt < ordered.length && isAroundOf(ordered[insertAt], target, 'after') && bySortKey(/** @type {Section} */ (ordered[insertAt]), child) < 0) insertAt++;
                    ordered.splice(insertAt, 0, child);
                }
            }
            if (next.length === pending.length) {
                ordered.push(...next);
                break;
            }
            pending = next;
        }

        return {
            section,
            items: ordered.map(x => (x === TEXT ? TEXT : build(x))),
            outlets: new Map([...outlets].map(([name, child]) => [name, build(child)])),
            deferred: deferred.sort(bySortKey).map(build),
        };
    }

    const unplaced = [...reasons].map(([id, reason]) => ({ id, reason }));
    return { root: build({ id: ROOT }), unplaced, byId };
}

/**
 * @param {Section|typeof TEXT} item
 * @param {string} target
 * @param {'before'|'after'} side
 * @returns {boolean}
 */
function isAroundOf(item, target, side) {
    return item !== TEXT && item.at?.[side] === target;
}

/**
 * @param {PlacedNode} node
 * @param {string} id
 * @returns {PlacedNode|null}
 */
export function findNode(node, id) {
    if (node.section.id === id) return node;
    for (const child of [...node.items, ...node.outlets.values(), ...node.deferred]) {
        if (child === TEXT) continue;
        const found = findNode(child, id);
        if (found) return found;
    }
    return null;
}

/**
 * @param {PlacedNode} node
 * @returns {Section[]}
 */
export function childrenOf(node) {
    return node.items.filter(x => x !== TEXT).map(x => (x).section);
}

/**
 * @param {PlacedNode} root
 * @returns {{ sources: { priority: number, units: string[], trimmed: boolean }[], unitOf: Map<string, string> }}
 */
function budgetPlan(root) {
    /** @type {{ priority: number, units: string[], trimmed: boolean, seq: number }[]} */
    const sources = [];

    /** @type {Map<string, string>} */
    const unitOf = new Map();
    let seq = 0;

    /**
     * @param {PlacedNode} node
     * @param {string|null} unit
     */
    function mark(node, unit) {
        if (unit) unitOf.set(node.section.id, unit);
        for (const child of [...node.items, ...node.outlets.values(), ...node.deferred]) {
            if (child !== TEXT) visit(child, unit);
        }
    }

    /**
     * @param {PlacedNode} node
     * @param {string|null} unit
     */
    function visit(node, unit) {
        const section = node.section;
        if (unit) return mark(node, unit);
        if (section.budget === 'trim') {
            const children = childrenOf(node).filter(c => c.budget === 'drop');
            const units = section.trimFrom === 'end' ? children.map(c => c.id) : children.map(c => c.id).reverse();
            sources.push({ priority: section.priority ?? 0, units, trimmed: true, seq: seq++ });
            for (const child of [...node.items, ...node.outlets.values(), ...node.deferred]) {
                if (child === TEXT) continue;
                visit(child, child.section.budget === 'drop' ? child.section.id : null);
            }
            return;
        }
        if (section.budget === 'drop') {
            sources.push({ priority: section.priority ?? 0, units: [section.id], trimmed: false, seq: seq++ });
            return mark(node, section.id);
        }
        mark(node, null);
    }

    visit(root, null);
    sources.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    return { sources, unitOf };
}

/**
 * @template R
 * @param {PlacedNode} root
 * @param {object} options
 * @param {number} options.budget
 * @param {(excluded: Set<string>, unitOf: Map<string, string>) => Promise<R>} options.render
 * @param {(rendered: R) => Promise<{ kept: number, units: Map<string, number>, describeKept: () => Promise<{ id: string, tokens: number }[]> }>} options.measure
 * @returns {Promise<{ rendered: R, excluded: Set<string>, total: number }>}
 */
export async function fitBudget(root, { budget, render, measure }) {
    const { sources, unitOf } = budgetPlan(root);
    const full = await render(new Set(), unitOf);
    const { kept, units, describeKept } = await measure(full);
    if (kept > budget) {
        const largest = (await describeKept()).sort((a, b) => b.tokens - a.tokens).slice(0, 5);
        throw new PromptOverBudgetError(budget, kept, largest);
    }
    let total = kept;

    /** @type {Set<string>} */
    const excluded = new Set();
    for (const source of sources) {
        let stopped = false;
        for (const unit of source.units) {
            const tokens = units.get(unit) ?? 0;
            if (!stopped && total + tokens <= budget) {
                total += tokens;
                continue;
            }
            excluded.add(unit);
            if (source.trimmed) stopped = true;
        }
    }
    const rendered = excluded.size ? await render(excluded, unitOf) : full;
    return { rendered, excluded, total };
}

/**
 * @typedef {object} RenderedPiece
 * @property {string} text
 * @property {Section} section
 * @property {string} container The section whose items it's one of.
 * @property {string|null} unit The droppable section it belongs to, if any.
 * @property {boolean} [message]
 * @property {string} [inner]
 * @property {boolean} [joined]
 */

/**
 * @param {PlacedNode} root
 * @param {Set<string>} excluded
 * @returns {{ collapse: (node: PlacedNode) => string, outletText: (name: string) => string, rendered: Map<string, string> }}
 */
function textCollapser(root, excluded) {
    /** @type {Map<string, PlacedNode>} */
    const outletNodes = new Map();
    (function collect(node) {
        for (const [name, child] of node.outlets) if (!outletNodes.has(name)) outletNodes.set(name, child);
        for (const child of [...node.items, ...node.outlets.values(), ...node.deferred]) if (child !== TEXT) collect(child);
    })(root);

    /** @type {Map<string, string>} */
    const rendered = new Map();

    /** @type {Set<string>} */
    const collapsing = new Set();

    /**
     * @param {string} name
     * @returns {string}
     */
    function outletText(name) {
        const node = outletNodes.get(name);
        if (!node || collapsing.has(node.section.id)) return '';
        return collapse(node);
    }

    /**
     * @param {string} text
     * @returns {string}
     */
    function fillOutlets(text) {
        return text.replace(OUTLET_PATTERN, (_, name) => outletText(name));
    }

    /**
     * @param {PlacedNode} node
     * @returns {string}
     */
    function collapse(node) {
        const section = node.section;
        if (excluded.has(section.id)) return '';
        collapsing.add(section.id);

        /** @type {string[]} */
        let parts = [];
        for (const item of node.items) {
            if (item === TEXT) {
                if (typeof section.text === 'string') parts.push(fillOutlets(section.text));
                continue;
            }
            if (excluded.has(item.section.id)) continue;
            parts.push(collapse(item));
        }
        if (section.skipEmpty) parts = parts.filter(p => p !== '');
        if (section.trimEach) parts = parts.map(p => p.trim());
        let text = parts.join(section.join ?? '');
        if (section.compose) {
            const children = new Map(node.items.filter(x => x !== TEXT).map(x => [(x).section.id, (x)]));
            const inner = text;
            text = section.compose({
                inner,
                child: id => {
                    const child = children.get(id);
                    return child && !excluded.has(id) ? (rendered.get(id) ?? collapse(child)) : '';
                },
                outlet: outletText,
            });
            text = fillOutlets(text);
        }
        if (section.trim === 'both') text = text.trim();
        else if (section.trim === 'start') text = text.trimStart();
        collapsing.delete(section.id);
        rendered.set(section.id, text);
        return text;
    }

    return { collapse, outletText, rendered };
}

/**
 * @typedef {object} TextMessageVariant
 * @property {boolean} first
 * @property {boolean} lastUser
 * @property {boolean} continued
 */

/**
 * @param {PlacedNode} root
 * @param {object} options
 * @param {Set<string>} options.excluded
 * @param {Map<string, string>} options.unitOf
 * @param {(section: Section, inner: string, variant: TextMessageVariant) => string} options.formatMessage
 * @param {boolean} [options.lastUserVariant] Whether the last user message gets its variant (not when impersonating).
 * @returns {{ text: string, pieces: RenderedPiece[], rendered: Map<string, string> }}
 */
export function renderText(root, { excluded, unitOf, formatMessage, lastUserVariant = true }) {
    const { collapse, rendered } = textCollapser(root, excluded);

    /**
     * @param {PlacedNode} node
     * @param {string} container
     * @param {string|null} unit
     * @returns {RenderedPiece[]}
     */
    function pieces(node, container, unit) {
        const section = node.section;
        if (excluded.has(section.id)) return [];
        const ownUnit = unitOf.get(section.id) ?? unit;
        if (section.role) {
            const inner = collapse(node);
            if (section.skipEmpty && inner === '') return [];
            return [{ text: '', inner, section, container, unit: ownUnit, message: true }];
        }
        if (section.compose || section.join !== undefined || section.trimEach || section.trim) {
            return [{ text: collapse(node), section, container, unit: ownUnit, joined: Boolean(section.joins) }];
        }

        /** @type {RenderedPiece[]} */
        const out = [];
        for (const item of node.items) {
            if (item === TEXT) {
                if (typeof section.text === 'string') {
                    out.push({ text: collapse({ section: { ...section, compose: undefined }, items: [TEXT], outlets: new Map(), deferred: [] }), section, container, unit: ownUnit, joined: Boolean(section.joins) });
                }
                continue;
            }
            out.push(...pieces(item, section.id, ownUnit));
        }
        for (const later of node.deferred) {
            const inserted = pieces(later, section.id, ownUnit);
            if (!inserted.length) continue;
            const n = (later.section.at?.fromEndRendered);
            const itemIndexes = out.map((p, i) => (p.container === section.id && !p.joined ? i : -1)).filter(i => i >= 0);
            const position = n <= 0 || itemIndexes.length === 0 ? out.length : itemIndexes[Math.max(itemIndexes.length - n, 0)];
            out.splice(position, 0, ...inserted);
        }
        rendered.set(section.id, out.map(p => p.text).join(''));
        return out;
    }

    const all = pieces(root, ROOT, null);
    const messages = all.filter(p => p.message);
    const first = messages[0];
    const lastUser = lastUserVariant ? messages.findLast(p => p.section.role === 'user') : undefined;
    for (const piece of messages) {
        piece.text = formatMessage(piece.section, (piece.inner), {
            first: piece === first,
            lastUser: piece === lastUser,
            continued: Boolean(piece.section.continued),
        });
        rendered.set(piece.section.id, piece.text);
    }

    const out = [];

    /** @type {RenderedPiece|null} */
    let item = null;
    for (const piece of all) {
        const joins = piece.joined ? piece.section.joins : undefined;
        if (!joins) {
            out.push(piece);
            item = piece;
            continue;
        }
        let target = item && item.container === piece.container ? item : null;
        if (!target) {
            target = { text: '', section: piece.section, container: piece.container, unit: piece.unit };
            out.push(target);
            item = target;
        }
        const tailIndex = out.length - 1;
        if (joins.trimNewline) out[tailIndex].text = out[tailIndex].text.replace(/\n?$/, '');
        const so = out.slice(out.indexOf(target)).map(p => p.text).join('');
        let prefix = '';
        if (joins.breakBefore && !so.endsWith('\n')) prefix = '\n';
        if (joins.spaceBefore && !/\s/.test(so.slice(-1))) prefix = ' ';
        out.push({ ...piece, text: prefix + piece.text });
    }
    return { text: out.map(p => p.text).join(''), pieces: out, rendered };
}

/**
 * @typedef {object} ChatSpec
 * @property {Section} section
 * @property {Role} role
 * @property {string} content
 * @property {string|null} unit
 */

/**
 * @param {PlacedNode} root
 * @param {object} options
 * @param {Set<string>} options.excluded
 * @param {Map<string, string>} options.unitOf
 * @returns {{ specs: ChatSpec[], rendered: Map<string, string> }}
 */
export function renderChat(root, { excluded, unitOf }) {
    const { collapse, rendered } = textCollapser(root, excluded);

    /** @type {ChatSpec[]} */
    const specs = [];

    /**
     * @param {PlacedNode} node
     * @param {string|null} unit
     */
    function walk(node, unit) {
        const section = node.section;
        if (excluded.has(section.id)) return;
        const ownUnit = unitOf.get(section.id) ?? unit;
        if (section.role) {
            const content = collapse(node);
            if (section.skipEmpty && content === '') return;
            specs.push({ section, role: section.role, content, unit: ownUnit });
            return;
        }
        for (const item of node.items) {
            if (item === TEXT) {
                if (section.text) specs.push({ section, role: 'system', content: collapse({ section: { ...section, compose: undefined }, items: [TEXT], outlets: new Map(), deferred: [] }), unit: ownUnit });
                continue;
            }
            walk(item, ownUnit);
        }
        for (const later of node.deferred) walk(later, ownUnit);
    }

    walk(root, null);
    return { specs, rendered };
}
