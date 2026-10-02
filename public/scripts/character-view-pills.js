import { RANGE_FIELDS, SEARCH_FIELDS, canonicalSearchField, cleanRanges } from './character-view.js';

/** Translates a tagged template; the caller passes i18n's `t`, so this module stays a leaf. */
let t = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => String.raw({ raw: strings }, ...values);

/** Plain-language names for the condition fields, in the order the field list shows them. */
const FIELD_NAMES = () => ({
    name: t`Name`,
    tag: t`Tag name`,
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
 * Pill kinds that aren't text fields: a tag the row carries, and favorite. They come first in the field list.
 * @returns {Record<string, string>}
 */
const SPECIAL_FIELDS = () => ({
    '@tag': t`Tag`,
    '@fav': t`Favorite`,
    ...Object.fromEntries(Object.keys(RANGE_FIELDS).map(field => [`@range:${field}`, rangeName(field)])),
});

/** Plain-language names for the range fields. */
const RANGE_NAMES = () => ({
    create_date: t`Created`,
    date_last_chat: t`Last chat`,
    chat_size: t`Chat history size`,
    data_size: t`Card length`,
});

/** @param {string} field */
function rangeName(field) {
    return RANGE_NAMES()[field] ?? field;
}

/**
 * A range end as the pill shows it: a date, kilobytes, or a count of characters.
 * @param {string} field
 * @param {number} value
 */
function formatRangeValue(field, value) {
    const unit = RANGE_FIELDS[field]?.unit;
    if (unit === 'date') return new Date(value).toLocaleDateString();
    if (unit === 'kb') return t`${Math.round(value / 1024)} KB`;
    return t`${value} characters`;
}

/**
 * What a range pill says about its bounds.
 * @param {string} field
 * @param {{ min?: number, max?: number }} bound
 */
function describeRange(field, bound) {
    const date = RANGE_FIELDS[field]?.unit === 'date';
    const from = bound.min !== undefined ? formatRangeValue(field, bound.min) : null;
    const to = bound.max !== undefined ? formatRangeValue(field, bound.max) : null;
    if (from && to) return t`between ${from} and ${to}`;
    if (from) return date ? t`on or after ${from}` : t`at least ${from}`;
    if (to) return date ? t`on or before ${to}` : t`at most ${to}`;
    return t`any`;
}

/** A local date (yyyy-mm-dd) as epoch ms: its first millisecond, or with `end` its last. */
function dateInputToMs(/** @type {string} */ value, /** @type {boolean} */ end) {
    const [y, m, d] = value.split('-').map(Number);
    return end ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime();
}

/** @param {number} ms */
function msToDateInput(ms) {
    const date = new Date(ms);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Opens the From / To boxes of a range under `anchor`. An empty box is an open end.
 * @param {HTMLElement} anchor
 * @param {string} field
 * @param {{ min?: number, max?: number }} bound
 * @param {(bound: { min?: number, max?: number }) => void} onApply
 */
function openRangeEditor(anchor, field, bound, onApply) {
    closePopover();
    const unit = RANGE_FIELDS[field]?.unit;
    const popover = document.createElement('div');
    popover.className = 'view_pill_popover view_range_editor';
    /** @param {string} label @param {number|undefined} value @param {boolean} end */
    const box = (label, value, end) => {
        const row = document.createElement('label');
        row.className = 'view_range_row';
        const text = document.createElement('span');
        text.textContent = label;
        const input = document.createElement('input');
        input.className = 'text_pole textarea_compact';
        input.dataset.end = end ? 'max' : 'min';
        if (unit === 'date') {
            input.type = 'date';
            if (value !== undefined) input.value = msToDateInput(value);
        } else {
            input.type = 'number';
            input.min = '0';
            if (value !== undefined) input.value = String(unit === 'kb' ? Math.round(value / 1024) : value);
        }
        row.append(text, input);
        return { row, input };
    };
    const suffix = unit === 'kb' ? t` (KB)` : unit === 'count' ? t` (characters)` : '';
    const min = box(t`From` + suffix, bound.min, false);
    const max = box(t`To` + suffix, bound.max, true);
    const apply = document.createElement('div');
    apply.className = 'menu_button';
    apply.textContent = t`Apply`;
    popover.append(min.row, max.row, apply);

    /** @param {HTMLInputElement} input @param {boolean} end */
    const read = (input, end) => {
        if (input.value === '') return undefined;
        if (unit === 'date') return dateInputToMs(input.value, end);
        const number = Number(input.value);
        if (!Number.isFinite(number)) return undefined;
        return unit === 'kb' ? number * 1024 : number;
    };
    const commit = () => {
        /** @type {{ min?: number, max?: number }} */
        const next = {};
        const from = read(min.input, false);
        const to = read(max.input, true);
        if (from !== undefined) next.min = from;
        if (to !== undefined) next.max = to;
        closePopover();
        onApply(next);
    };
    apply.addEventListener('click', commit);
    for (const input of [min.input, max.input]) {
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                commit();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                closePopover();
                anchor.focus();
            }
        });
    }
    showPopover(popover, anchor, min.input);
}

/**
 * Opens a list of fields under `anchor`, with a box to narrow it; `onPick` gets the chosen field.
 * @param {HTMLElement} anchor
 * @param {(field: string) => void} onPick
 * @param {{ special?: boolean }} [options] `special`: also offer the tag and favorite pills.
 */
function openFieldPicker(anchor, onPick, { special = false } = {}) {
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
        const entries = [
            ...(special ? Object.entries(SPECIAL_FIELDS()) : []),
            ...Object.keys(SEARCH_FIELDS).map(field => [field, fieldName(field)]),
        ];
        for (const [field, name] of entries) {
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

    showPopover(popover, anchor, search);
}

/**
 * @param {HTMLElement} popover
 * @param {HTMLElement} anchor
 * @param {HTMLElement} focus
 */
function showPopover(popover, anchor, focus) {
    document.body.append(popover);
    const box = anchor.getBoundingClientRect();
    popover.style.left = `${Math.max(4, Math.min(box.left, window.innerWidth - popover.offsetWidth - 4))}px`;
    popover.style.top = `${box.bottom + 4}px`;
    openPopover = popover;
    focus.focus();
}

/**
 * Opens a search over the server's tags under `anchor`; `onPick` gets the chosen tag.
 * @param {HTMLElement} anchor
 * @param {(term: string) => Promise<{ id: string, name: string }[] | null>} searchTags
 * @param {(tag: { id: string, name: string }) => void} onPick
 */
function openTagPicker(anchor, searchTags, onPick) {
    closePopover();
    const popover = document.createElement('div');
    popover.className = 'view_pill_popover';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole textarea_compact';
    search.placeholder = t`Find a tag`;
    const list = document.createElement('div');
    list.className = 'view_pill_field_list';
    popover.append(search, list);

    let asked = 0;
    let timer = 0;
    const load = async () => {
        const ask = ++asked;
        const found = await searchTags(search.value.trim());
        if (ask !== asked || !popover.isConnected) return;
        list.replaceChildren();
        if (!found) {
            list.textContent = t`Tags could not be loaded.`;
            return;
        }
        if (found.length === 0) {
            list.textContent = t`No tag has that name.`;
            return;
        }
        for (const tag of found) {
            const option = document.createElement('div');
            option.className = 'view_pill_field_option';
            option.dataset.tagId = tag.id;
            option.textContent = tag.name;
            option.addEventListener('click', () => {
                closePopover();
                onPick(tag);
            });
            list.append(option);
        }
    };
    search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = window.setTimeout(load, 150);
    });
    search.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closePopover();
            anchor.focus();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            /** @type {HTMLElement|null} */ (list.querySelector('.view_pill_field_option'))?.click();
        }
    });
    void load();
    showPopover(popover, anchor, search);
}

/**
 * Wires the search box and its condition pills to the character list's view.
 * @param {object} options
 * @param {JQuery<HTMLElement>} options.container Where the pills go.
 * @param {JQuery<HTMLElement>} options.input The free-text box.
 * @param {() => import('./character-view.js').CharacterView} options.getView
 * @param {(view: Partial<import('./character-view.js').CharacterView>, fromSearchBox: boolean) => void} options.setView
 * @param {typeof t} options.translate i18n's `t`.
 * @param {(term: string) => Promise<{ id: string, name: string }[] | null>} options.searchTags Tags whose names hold
 *   `term`, from the server; null if the read failed.
 * @param {(ids: string[]) => Promise<{ names: Map<string, string>, gone: Set<string> } | null>} options.tagNames The
 *   names of `ids`; `gone` holds ids no tag has. null if the read failed.
 * @returns {() => void} Redraws the pills and the box from the current view.
 */
export function initViewPills({ container, input, getView, setView, translate, searchTags, tagNames }) {
    t = translate;
    /** @type {import('./character-view.js').CharacterViewCondition[]} */
    let conditions = [];
    /** @type {import('./character-view.js').CharacterView['tags']} */
    let tags = { include: [], exclude: [], mode: 'and' };
    /** @type {boolean|undefined} */
    let fav;
    /** @type {Record<string, { min?: number, max?: number }>} */
    let ranges = {};
    /** The condition whose value is being typed, or -1. */
    let editing = -1;
    /** Tag names already read, by id; null for a tag that no longer exists. @type {Map<string, string|null>} */
    const names = new Map();
    /** Ids being read. @type {Set<string>} */
    const reading = new Set();

    const send = (fromSearchBox = false) => setView({
        text: String(input.val()),
        conditions: conditions.filter(c => c.value.trim()),
        tags: { include: [...tags.include], exclude: [...tags.exclude], mode: tags.mode },
        fav,
        ranges: cleanRanges(ranges),
    }, fromSearchBox);

    /** Reads the names of tags pills show and doesn't know yet, then draws again. */
    function readMissingNames() {
        const missing = [...tags.include, ...tags.exclude].filter(id => !names.has(id) && !reading.has(id));
        if (missing.length === 0) return;
        missing.forEach(id => reading.add(id));
        void tagNames(missing).then(answer => {
            missing.forEach(id => reading.delete(id));
            if (!answer) return;
            for (const id of missing) {
                if (answer.names.has(id)) names.set(id, answer.names.get(id));
                else if (answer.gone.has(id)) names.set(id, null);
            }
            render();
        });
    }

    /** @param {string} id */
    function tagLabel(id) {
        if (!names.has(id)) return '…';
        return names.get(id) ?? t`(deleted tag)`;
    }

    /**
     * @param {string} id
     * @param {boolean} included
     */
    function renderTagPill(id, included) {
        const pill = $('<span class="search_pill view_tag_pill">').attr('data-tag-id', id).attr('data-op', included ? 'has' : 'not_has');
        const field = $('<span class="search_pill_label">').text(t`Tag`);
        const op = $('<span class="view_pill_op view_pill_part" tabindex="0" role="button">')
            .text(included ? t`is on it` : t`isn't on it`).attr('title', t`Switch between showing and leaving out this tag`);
        op.on('click', () => {
            tags = included
                ? { ...tags, include: tags.include.filter(x => x !== id), exclude: [...tags.exclude, id] }
                : { ...tags, exclude: tags.exclude.filter(x => x !== id), include: [...tags.include, id] };
            render();
            send();
        });
        const value = $('<span class="search_pill_value view_pill_part" tabindex="0" role="button">').text(tagLabel(id)).attr('title', t`Pick another tag`);
        value.on('click', () => openTagPicker(value.get(0), searchTags, picked => {
            names.set(picked.id, picked.name);
            const swap = (/** @type {string[]} */ list) => [...new Set(list.map(x => x === id ? picked.id : x))];
            tags = included ? { ...tags, include: swap(tags.include) } : { ...tags, exclude: swap(tags.exclude) };
            render();
            send();
        }));
        const remove = $('<i class="fa-solid fa-xmark search_pill_remove" role="button" tabindex="0">').attr('title', t`Remove filter`);
        remove.on('click', event => {
            event.stopPropagation();
            tags = { ...tags, include: tags.include.filter(x => x !== id), exclude: tags.exclude.filter(x => x !== id) };
            render();
            send();
        });
        return pill.append(field, op, value, remove);
    }

    function renderJoiner() {
        const joiner = $('<span class="view_pill_joiner view_pill_part" tabindex="0" role="button">')
            .text(tags.mode === 'or' ? t`or` : t`and`)
            .attr('title', tags.mode === 'or' ? t`Showing rows with any of these tags. Click to need all of them.` : t`Showing rows with all of these tags. Click to need any one of them.`);
        joiner.on('click', () => {
            tags = { ...tags, mode: tags.mode === 'or' ? 'and' : 'or' };
            render();
            send();
        });
        return joiner;
    }

    function renderFavPill() {
        const pill = $('<span class="search_pill view_fav_pill">').attr('data-fav', String(fav));
        const field = $('<span class="search_pill_label">').text(t`Favorite`);
        const value = $('<span class="search_pill_value view_pill_part" tabindex="0" role="button">')
            .text(fav ? t`yes` : t`no`).attr('title', t`Switch between favorites only and no favorites`);
        value.on('click', () => {
            fav = !fav;
            render();
            send();
        });
        const remove = $('<i class="fa-solid fa-xmark search_pill_remove" role="button" tabindex="0">').attr('title', t`Remove filter`);
        remove.on('click', event => {
            event.stopPropagation();
            fav = undefined;
            render();
            send();
        });
        return pill.append(field, value, remove);
    }

    /** @param {string} field */
    function renderRangePill(field) {
        const bound = ranges[field] ?? {};
        const pill = $('<span class="search_pill view_range_pill">').attr('data-range', field);
        const label = $('<span class="search_pill_label">').text(rangeName(field));
        const value = $('<span class="search_pill_value view_pill_part" tabindex="0" role="button">')
            .text(describeRange(field, bound)).attr('title', t`Change the range`);
        value.on('click', () => openRangeEditor(value.get(0), field, bound, next => {
            const rest = { ...ranges };
            delete rest[field];
            ranges = Object.keys(next).length > 0 ? { ...rest, [field]: next } : rest;
            render();
            send();
        }));
        const remove = $('<i class="fa-solid fa-xmark search_pill_remove" role="button" tabindex="0">').attr('title', t`Remove filter`);
        remove.on('click', event => {
            event.stopPropagation();
            const rest = { ...ranges };
            delete rest[field];
            ranges = rest;
            render();
            send();
        });
        return pill.append(label, value, remove);
    }

    function render() {
        container.empty();
        tags.include.forEach((id, index) => {
            if (index > 0) container.append(renderJoiner());
            container.append(renderTagPill(id, true));
        });
        tags.exclude.forEach(id => container.append(renderTagPill(id, false)));
        if (typeof fav === 'boolean') container.append(renderFavPill());
        Object.keys(ranges).forEach(field => container.append(renderRangePill(field)));
        readMissingNames();
        conditions.forEach((condition, index) => container.append(renderPill(condition, index)));
        const add = $('<span class="search_pill view_pill_add" tabindex="0" role="button">')
            .attr('title', t`Add a filter`)
            .append($('<i class="fa-solid fa-plus">'));
        add.on('click keydown', event => {
            if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            openFieldPicker(add.get(0), field => {
                if (field === '@fav') {
                    fav = typeof fav === 'boolean' ? fav : true;
                    render();
                    send();
                    return;
                }
                if (field.startsWith('@range:')) {
                    const rangeField = field.slice('@range:'.length);
                    openRangeEditor(add.get(0), rangeField, ranges[rangeField] ?? {}, next => {
                        if (Object.keys(next).length === 0) return;
                        ranges = { ...ranges, [rangeField]: next };
                        render();
                        send();
                    });
                    return;
                }
                if (field === '@tag') {
                    openTagPicker(add.get(0), searchTags, picked => {
                        names.set(picked.id, picked.name);
                        if (!tags.include.includes(picked.id)) {
                            tags = { ...tags, include: [...tags.include, picked.id], exclude: tags.exclude.filter(x => x !== picked.id) };
                        }
                        render();
                        send();
                    });
                    return;
                }
                conditions.push({ field, op: 'contains', value: '' });
                editing = conditions.length - 1;
                render();
            }, { special: true });
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

    // Redrawing while a pill's value is being typed would lose it, and the box keeps what is typed in it.
    return () => {
        if (editing !== -1) return;
        const view = getView();
        conditions = view.conditions.map(condition => ({ ...condition }));
        tags = { include: [...view.tags.include], exclude: [...view.tags.exclude], mode: view.tags.mode === 'or' ? 'or' : 'and' };
        fav = view.fav;
        ranges = { ...(cleanRanges(view.ranges) ?? {}) };
        if (String(input.val()) !== view.text && document.activeElement !== input.get(0)) input.val(view.text);
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
