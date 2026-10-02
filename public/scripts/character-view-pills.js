import { SEARCH_FIELDS, canonicalSearchField } from './character-view.js';

/** Translates a tagged template; the caller passes i18n's `t`, so this module stays a leaf. */
let t = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => String.raw({ raw: strings }, ...values);

/** Plain-language names for the condition fields, in the order the field list shows them. */
const FIELD_NAMES = () => ({
    name: t`Name`,
    tag: t`Tag`,
    creator: t`Creator`,
    description: t`Description`,
    personality: t`Personality`,
    scenario: t`Scenario`,
    greeting: t`First message`,
    alternate: t`Other greetings`,
    example: t`Example messages`,
    notes: t`Creator's notes`,
    member: t`Group member`,
    id: t`Group id`,
});

/** @param {string} field */
function fieldName(field) {
    return FIELD_NAMES()[field] ?? field;
}

/** @param {'contains'|'not_contains'} op */
function opName(op) {
    return op === 'not_contains' ? t`doesn't contain` : t`contains`;
}

// A typed token turns into a condition when it ends: `label:value` or `-label:value`.
const TYPED_CONDITION = /(?:^|\s)(-)?([A-Za-z][A-Za-z0-9_]*):("[^"]*"|\S+)$/;

/** @type {HTMLElement|null} */
let openPopover = null;

function closePopover() {
    openPopover?.remove();
    openPopover = null;
}

document.addEventListener('pointerdown', event => {
    if (openPopover && event.target instanceof Node && !openPopover.contains(event.target)) closePopover();
}, true);

/**
 * Opens a list of fields under `anchor`, with a box to narrow it; `onPick` gets the chosen field.
 * @param {HTMLElement} anchor
 * @param {(field: string) => void} onPick
 */
function openFieldPicker(anchor, onPick) {
    closePopover();
    const popover = document.createElement('div');
    popover.className = 'view_pill_popover';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole textarea_compact';
    search.placeholder = t`Find a field`;
    const list = document.createElement('div');
    list.className = 'view_pill_field_list';
    popover.append(search, list);

    const renderList = () => {
        const needle = search.value.trim().toLowerCase();
        list.replaceChildren();
        for (const field of Object.keys(SEARCH_FIELDS)) {
            const name = fieldName(field);
            if (needle && !name.toLowerCase().includes(needle) && !field.includes(needle)) continue;
            const option = document.createElement('div');
            option.className = 'view_pill_field_option';
            option.dataset.field = field;
            option.textContent = name;
            option.addEventListener('click', () => {
                closePopover();
                onPick(field);
            });
            list.append(option);
        }
    };
    search.addEventListener('input', renderList);
    search.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closePopover();
            anchor.focus();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            /** @type {HTMLElement|null} */ (list.firstElementChild)?.click();
        }
    });
    renderList();

    document.body.append(popover);
    const box = anchor.getBoundingClientRect();
    popover.style.left = `${Math.max(4, Math.min(box.left, window.innerWidth - popover.offsetWidth - 4))}px`;
    popover.style.top = `${box.bottom + 4}px`;
    openPopover = popover;
    search.focus();
}

/**
 * Wires the search box and its condition pills to the character list's view.
 * @param {object} options
 * @param {JQuery<HTMLElement>} options.container Where the pills go.
 * @param {JQuery<HTMLElement>} options.input The free-text box.
 * @param {() => import('./character-view.js').CharacterView} options.getView
 * @param {(view: Partial<import('./character-view.js').CharacterView>, fromSearchBox: boolean) => void} options.setView
 * @param {typeof t} options.translate i18n's `t`.
 * @returns {() => void} Redraws the pills and the box from the current view.
 */
export function initViewPills({ container, input, getView, setView, translate }) {
    t = translate;
    /** @type {import('./character-view.js').CharacterViewCondition[]} */
    let conditions = [];
    /** The condition whose value is being typed, or -1. */
    let editing = -1;

    const send = (fromSearchBox = false) => setView({ text: String(input.val()), conditions: conditions.filter(c => c.value.trim()) }, fromSearchBox);

    function render() {
        container.empty();
        conditions.forEach((condition, index) => container.append(renderPill(condition, index)));
        const add = $('<span class="search_pill view_pill_add" tabindex="0" role="button">')
            .attr('title', t`Add a filter`)
            .append($('<i class="fa-solid fa-plus">'));
        add.on('click keydown', event => {
            if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            openFieldPicker(add.get(0), field => {
                conditions.push({ field, op: 'contains', value: '' });
                editing = conditions.length - 1;
                render();
            });
        });
        container.append(add);
        container.find('.view_pill_value_input').trigger('focus');
    }

    /**
     * @param {import('./character-view.js').CharacterViewCondition} condition
     * @param {number} index
     */
    function renderPill(condition, index) {
        const pill = $('<span class="search_pill">').attr('data-field', condition.field).attr('data-op', condition.op);
        const field = $('<span class="search_pill_label view_pill_part" tabindex="0" role="button">')
            .text(fieldName(condition.field)).attr('title', t`Change the field`);
        field.on('click', () => openFieldPicker(field.get(0), picked => {
            condition.field = picked;
            render();
            send();
        }));
        const op = $('<span class="view_pill_op view_pill_part" tabindex="0" role="button">')
            .text(opName(condition.op)).attr('title', t`Switch between contains and doesn't contain`);
        op.on('click', () => {
            condition.op = condition.op === 'contains' ? 'not_contains' : 'contains';
            render();
            send();
        });
        pill.append(field, op);

        if (editing === index) {
            const box = $('<input type="text" class="view_pill_value_input">').val(condition.value);
            let done = false;
            const finish = (/** @type {boolean} */ keep) => {
                if (done) return;
                done = true;
                editing = -1;
                const value = String(box.val()).trim();
                if (keep) condition.value = value;
                if (!condition.value) conditions.splice(index, 1);
                render();
                send();
            };
            box.on('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    finish(true);
                    input.trigger('focus');
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    finish(false);
                    input.trigger('focus');
                }
            });
            box.on('blur', () => finish(true));
            pill.append(box);
        } else {
            const value = $('<span class="search_pill_value view_pill_part" tabindex="0" role="button">')
                .text(condition.value).attr('title', t`Edit the value`);
            value.on('click', () => {
                editing = index;
                render();
            });
            pill.append(value);
        }

        const remove = $('<i class="fa-solid fa-xmark search_pill_remove" role="button" tabindex="0">').attr('title', t`Remove filter`);
        remove.on('click', event => {
            event.stopPropagation();
            conditions.splice(index, 1);
            editing = -1;
            render();
            send();
        });
        pill.append(remove);
        return pill;
    }

    input.on('input', function () {
        const raw = String(input.val());
        // A space ends the token before it; a field condition becomes a pill.
        if (raw.endsWith(' ')) {
            const trimmed = raw.slice(0, -1);
            const match = trimmed.match(TYPED_CONDITION);
            const field = match ? canonicalSearchField(match[2]) : null;
            if (match && field) {
                conditions.push({ field, op: match[1] ? 'not_contains' : 'contains', value: match[3] });
                input.val(trimmed.slice(0, match.index));
                render();
            }
        }
        send(true);
    });

    // Backspace in an empty box takes the last pill back into the box to edit.
    input.on('keydown', event => {
        if (event.key === 'Backspace' && input.val() === '' && conditions.length > 0) {
            event.preventDefault();
            const last = conditions.pop();
            input.val(`${last.op === 'not_contains' ? '-' : ''}${last.field}:${last.value}`);
            render();
            send(true);
        }
    });

    return () => {
        const view = getView();
        conditions = view.conditions.map(condition => ({ ...condition }));
        editing = -1;
        if (String(input.val()) !== view.text) input.val(view.text);
        render();
    };
}

/**
 * The (i) next to the search box: how to write filters, in plain words.
 * @returns {JQuery<HTMLElement>}
 */
export function makeSearchGuide() {
    const fields = Object.keys(SEARCH_FIELDS)
        .map(field => `${fieldName(field)}: ${[field, ...SEARCH_FIELDS[field]].join(', ')}`)
        .join('\n');
    const guide = [
        t`Type words to search everything.`,
        t`Type field:word and a space to search one field, for example creator:alice.`,
        t`Put a minus in front to leave those out: -tag:horror.`,
        t`Use quotes to keep words together: tag:"slow burn".`,
        t`Click a filter's parts to change them, or + to add one.`,
        '',
        t`Fields you can type:`,
        fields,
    ].join('\n');
    const icon = $('<i id="character_search_guide" class="fa-solid fa-circle-info" tabindex="0" role="note">');
    icon.attr('title', guide).attr('aria-label', guide);
    return icon;
}
