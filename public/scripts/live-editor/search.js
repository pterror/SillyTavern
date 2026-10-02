// Find and replace in the editor, and named presets and preset lists of regex replacements, saved per user on the
// server (separate from the Regex extension's scripts).

import { state as cmState, view as cmView, search as cmSearch } from '../../live-editor-lib.js';
import { getRequestHeaders } from '../../script.js';
import { t } from '../i18n.js';

const { StateField, StateEffect, Facet } = cmState;
const { keymap, showPanel } = cmView;
const { search, searchKeymap, getSearchQuery } = cmSearch;

/**
 * @typedef {{ id: string, name: string, find: string, flags: string, replace: string }} RegexPreset
 * @typedef {{ id: string, name: string, presetIds: string[] }} PresetList
 * @typedef {{ id: string, name: string, group: string, run: (text: string, context: PresetContext) => string }} BuiltinPreset
 * @typedef {{ characterName?: string }} PresetContext
 */

/**
 * @typedef {object} SearchOptions
 * @property {BuiltinPreset[]} [builtins] Presets that come with the app; their ids start with `builtin:`.
 * @property {() => PresetContext} [context] What code presets may need, such as the character's name.
 */

const searchOptions = Facet.define({
    combine: values => values[0] ?? {},
});

/** @type {{ hash: string | null, presets: RegexPreset[], lists: PresetList[] }} The user's presets, as last read. */
const cache = { hash: null, presets: [], lists: [] };

/**
 * @param {string} action
 * @param {object} body
 */
async function request(action, body) {
    const response = await fetch(`/api/editor-presets/${action}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? response.statusText);
    return data;
}

/** Reads the user's presets, downloading them only when they changed since the copy held. */
async function loadPresets() {
    const data = await request('get', { hash: cache.hash });
    if (!data.unchanged) {
        cache.presets = data.presets;
        cache.lists = data.lists;
    }
    cache.hash = data.hash;
    return cache;
}

/**
 * The smallest change that turns `from` into `to`, so a run keeps the cursor and undo history where nothing changed.
 * @param {string} from
 * @param {string} to
 */
function diffText(from, to) {
    if (from === to) return null;
    let start = 0;
    const max = Math.min(from.length, to.length);
    while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
    let endFrom = from.length;
    let endTo = to.length;
    while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
        endFrom--;
        endTo--;
    }
    return { from: start, to: endFrom, insert: to.slice(start, endTo) };
}

/**
 * @param {RegexPreset} preset
 * @returns {(text: string) => string}
 */
function regexRun(preset) {
    const flags = preset.flags.includes('g') ? preset.flags : preset.flags + 'g';
    return text => text.replace(new RegExp(preset.find, flags), preset.replace);
}

/**
 * Runs transforms over the editor's text as one change (one undo). Nothing changes, nothing is written.
 * @param {import('@codemirror/view').EditorView} view
 * @param {((text: string) => string)[]} runs
 * @returns {boolean} Whether the text changed.
 */
function applyRuns(view, runs) {
    const before = view.state.doc.toString();
    const after = runs.reduce((text, run) => run(text), before);
    const change = diffText(before, after);
    if (!change) return false;
    view.dispatch({ changes: change, userEvent: 'input.replace', scrollIntoView: true });
    return true;
}

const togglePresets = StateEffect.define();
const presetsOpen = StateField.define({
    create: () => false,
    update: (open, tr) => tr.effects.reduce((value, effect) => effect.is(togglePresets) ? effect.value : value, open),
    provide: field => showPanel.from(field, open => open ? presetsPanel : null),
});

/**
 * @param {import('@codemirror/view').EditorView} view
 * @param {boolean} [open]
 */
export function showPresets(view, open = !view.state.field(presetsOpen)) {
    view.dispatch({ effects: togglePresets.of(open) });
}

/**
 * @param {import('@codemirror/view').EditorView} view
 * @returns {import('@codemirror/view').Panel}
 */
function presetsPanel(view) {
    const dom = document.createElement('div');
    dom.className = 'live-presets';
    const status = document.createElement('div');
    status.className = 'live-presets-status';
    const body = document.createElement('div');
    body.className = 'live-presets-body';
    dom.append(body, status);

    const say = (/** @type {string} */ text) => {
        status.textContent = text;
    };
    const { builtins = [], context = () => ({}) } = view.state.facet(searchOptions);

    /** @param {string} id */
    const runFor = (id) => {
        const builtin = builtins.find(b => b.id === id);
        if (builtin) return (/** @type {string} */ text) => builtin.run(text, context());
        const preset = cache.presets.find(p => p.id === id);
        return preset ? regexRun(preset) : null;
    };

    const button = (/** @type {string} */ label, /** @type {() => void} */ onClick, /** @type {string} */ className = '') => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `menu_button live-presets-button ${className}`;
        el.textContent = label;
        el.addEventListener('mousedown', event => event.preventDefault());
        el.addEventListener('click', onClick);
        return el;
    };

    const run = (/** @type {string} */ name, /** @type {((text: string) => string)[]} */ runs) => {
        try {
            say(applyRuns(view, runs) ? t`${name}: done.` : t`${name}: nothing to change.`);
        } catch (error) {
            say(t`${name} could not run: ${error.message}`);
        }
    };

    /** Presets ticked for a new list, in the order ticked. */
    const ticked = [];
    const tick = (/** @type {string} */ id) => {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'live-presets-tick';
        box.title = t`Include in a new list`;
        box.checked = ticked.includes(id);
        box.addEventListener('change', () => {
            const at = ticked.indexOf(id);
            if (box.checked && at === -1) ticked.push(id);
            if (!box.checked && at !== -1) ticked.splice(at, 1);
        });
        return box;
    };

    const draw = () => {
        body.replaceChildren();
        const row = (/** @type {string} */ name, /** @type {HTMLElement[]} */ controls) => {
            const el = document.createElement('div');
            el.className = 'live-presets-row';
            const label = document.createElement('span');
            label.className = 'live-presets-name';
            label.textContent = name;
            el.append(label, ...controls);
            body.append(el);
        };
        const heading = (/** @type {string} */ text) => {
            const el = document.createElement('div');
            el.className = 'live-presets-heading';
            el.textContent = text;
            body.append(el);
        };

        const groups = [...new Set(builtins.map(b => b.group))];
        for (const group of groups) {
            heading(group);
            for (const builtin of builtins.filter(b => b.group === group)) {
                row(builtin.name, [tick(builtin.id), button(t`Run`, () => run(builtin.name, [runFor(builtin.id)]))]);
            }
        }

        heading(t`Your presets`);
        if (cache.presets.length === 0) row(t`None yet. Search with a regular expression, then save it here.`, []);
        for (const preset of cache.presets) {
            row(preset.name, [
                tick(preset.id),
                button(t`Run`, () => run(preset.name, [regexRun(preset)])),
                button(t`Delete`, async () => {
                    try {
                        await request('delete-preset', { id: preset.id });
                        await loadPresets();
                        draw();
                    } catch (error) {
                        say(t`Could not delete: ${error.message}`);
                    }
                }, 'live-presets-delete'),
            ]);
        }

        heading(t`Lists`);
        if (cache.lists.length === 0) row(t`None yet.`, []);
        for (const list of cache.lists) {
            const runs = list.presetIds.map(runFor).filter(Boolean);
            row(list.name, [
                button(t`Run`, () => run(list.name, runs)),
                button(t`Delete`, async () => {
                    try {
                        await request('delete-list', { id: list.id });
                        await loadPresets();
                        draw();
                    } catch (error) {
                        say(t`Could not delete: ${error.message}`);
                    }
                }, 'live-presets-delete'),
            ]);
        }

        const actions = document.createElement('div');
        actions.className = 'live-presets-actions';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'text_pole live-presets-new-name';
        nameInput.placeholder = t`Name for the current search`;
        nameInput.setAttribute('aria-label', t`Name for the current search`);
        actions.append(
            nameInput,
            button(t`Save the current search as a preset`, async () => {
                const query = getSearchQuery(view.state);
                if (!query.search) {
                    say(t`Open find and replace (Ctrl+F) and type what to find first.`);
                    return;
                }
                const name = nameInput.value.trim();
                if (!name) {
                    say(t`Give the preset a name first.`);
                    nameInput.focus();
                    return;
                }
                const find = query.regexp ? query.search : query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                try {
                    await request('save-preset', { name, find, flags: query.caseSensitive ? 'g' : 'gi', replace: query.replace });
                    await loadPresets();
                    draw();
                    say(t`Saved "${name}".`);
                } catch (error) {
                    say(t`Could not save: ${error.message}`);
                }
            }),
        );
        const listName = document.createElement('input');
        listName.type = 'text';
        listName.className = 'text_pole live-presets-new-name live-presets-new-list';
        listName.placeholder = t`Name for a list of the ticked presets`;
        listName.setAttribute('aria-label', t`Name for a list of the ticked presets`);
        const listActions = document.createElement('div');
        listActions.className = 'live-presets-actions';
        listActions.append(
            listName,
            button(t`Save the ticked presets as a list`, async () => {
                const name = listName.value.trim();
                if (!name || ticked.length === 0) {
                    say(t`Tick the presets for the list, in the order they should run, and give it a name.`);
                    return;
                }
                try {
                    await request('save-list', { name, presetIds: ticked });
                    ticked.length = 0;
                    await loadPresets();
                    draw();
                    say(t`Saved "${name}".`);
                } catch (error) {
                    say(t`Could not save: ${error.message}`);
                }
            }),
            button(t`Close`, () => showPresets(view, false)),
        );
        body.append(actions);
        body.append(listActions);
    };

    draw();
    say(t`Loading your presets…`);
    loadPresets().then(() => {
        draw();
        say('');
    }, (error) => say(t`Your presets could not be loaded: ${error.message}`));

    return { dom, top: false };
}

/**
 * @param {SearchOptions} [options]
 * @returns {import('@codemirror/state').Extension}
 */
export function liveSearch(options = {}) {
    return [
        searchOptions.of(options),
        search({ top: false }),
        keymap.of(searchKeymap),
        presetsOpen,
    ];
}

/**
 * @param {import('@codemirror/state').EditorState} state
 * @returns {boolean} Whether this editor has the presets panel.
 */
export function hasPresets(state) {
    return state.field(presetsOpen, false) !== undefined;
}
