import {
    FIELDS,
    VIEW,
    DEFAULT_RANGE,
    LAB_RANGE,
    LEVELS,
    SAMPLER_NAMES,
    actions,
    fieldAt,
    rangeOf,
    refusalOf,
} from './protocol.ts';
import type { Level, LevelRange, Range, SamplerSelect, SettingsView } from './protocol.ts';
import type { ChatOwner } from '@st/protocol';
import { defineArea } from '@st/server-ui';
import type { ActionResult, ChatRef, User, ViewContext } from '@st/server-ui';
import { MINUS_ONE_BACKENDS, limitsOfSettings } from './model-limits.ts';
import type { ModelLists, ModelRecord } from './model-limits.ts';

// The AI response configuration panel's settings (packages/areas/settings/protocol.ts): a tab's chat's settings over
// the range of levels the tab shows, and edits of one field at a time, each written where its level says (the old
// server's settings document routes them).

const FULL: LevelRange = { from: 'default', to: 'character' };

/** What old server code does for this area (src/settings-document.js). */
export type Ports = {
    /** A chat's settings over a range, upstream-shaped, and the level each bundle field's value comes from. */
    view(
        user: User,
        owner: ChatOwner | null,
        range: LevelRange,
    ): Promise<{ settings: Record<string, unknown>; sources: Record<string, string> }>;
    /**
     * Writes paths where an edit over the range goes, all in one write (a value of undefined takes its path away).
     */
    write(
        user: User,
        owner: ChatOwner | null,
        range: LevelRange,
        entries: [path: string, value: unknown][],
    ): Promise<void>;
    /** Whose a chat is. */
    ownerOf(user: User, chat: ChatRef): Promise<ChatOwner | null>;
    /** A chat completion source's model list as it last answered the user (empty when it hasn't). */
    models(user: User, source: string): readonly ModelRecord[];
    /**
     * The app's defaults, upstream-shaped: what a field is where no level states it (the settings model stores a
     * field at its default as nothing, as the old page filled it from its code).
     */
    defaults(): Record<string, unknown>;
};

const valueAt = (settings: Record<string, unknown>, path: string): unknown =>
    path
        .split('.')
        .reduce<unknown>(
            (at, key) => (at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined),
            settings,
        );

const textAt = (settings: Record<string, unknown>, path: string): string => {
    const value = valueAt(settings, path);
    return typeof value === 'string' ? value : '';
};

/**
 * Each field's range for these settings where it isn't its declaration's: the context and response limits by whether
 * they're unlocked, what the chat completion source and model allow for its context size, temperature and penalties,
 * and none for the fields lab mode frees.
 */
function rangesFor(settings: Record<string, unknown>, models: ModelLists) {
    const ranges: Record<string, Range> = {};
    const unlocked = valueAt(settings, 'power_user.max_context_unlocked') === true;
    for (const field of FIELDS) if (field.limits !== undefined) ranges[field.id] = rangeOf(field, unlocked);
    const oai = valueAt(settings, 'oai_settings');
    const limits = limitsOfSettings(
        oai !== null && typeof oai === 'object' ? (oai as Record<string, unknown>) : {},
        models,
    );
    ranges['openai_max_context'] = { min: 512, max: limits.context, step: 1 };
    ranges['temp_openai'] = { min: 0, max: limits.temperature, step: 0.01 };
    ranges['freq_pen_openai'] = { ...limits.penalties, step: 0.01 };
    ranges['pres_pen_openai'] = { ...limits.penalties, step: 0.01 };
    // Backends that turn top K off with -1 go down to it, and have no mirostat mode 1.
    const minusOne = MINUS_ONE_BACKENDS.includes(textAt(settings, 'textgenerationwebui_settings.type'));
    ranges['top_k_textgenerationwebui'] = { min: minusOne ? -1 : 0, max: 500, step: 1 };
    ranges['mirostat_mode_textgenerationwebui'] = { min: 0, max: 2, step: minusOne ? 2 : 1 };
    if (valueAt(settings, 'power_user.enableLabMode') === true)
        for (const field of FIELDS) if (field.lab) ranges[field.id] = { ...LAB_RANGE };
    return ranges;
}

/** Where the sampler select is kept: the user's own, by text generation backend. */
const SAMPLER_SELECT = 'power_user.sampler_select';

/** The neutral value of each text generation sampler (the old page's Neutralize Samplers), by setting key. */
function neutralOf(backend: string): Record<string, unknown> {
    return {
        temp: 1,
        top_k: MINUS_ONE_BACKENDS.includes(backend) ? -1 : 0,
        top_p: 1,
        min_p: 0,
        rep_pen: 1,
        rep_pen_range: 0,
        rep_pen_decay: 0,
        dynatemp: false,
        seed: -1,
        ban_eos_token: false,
        do_sample: true,
        add_bos_token: true,
        temperature_last: true,
        skip_special_tokens: true,
        include_reasoning: true,
        top_a: 0,
        mirostat_mode: 0,
        mirostat_tau: 5,
        mirostat_eta: 0.1,
        tfs: 1,
        epsilon_cutoff: 0,
        eta_cutoff: 0,
        encoder_rep_pen: 1,
        freq_pen: 0,
        presence_pen: 0,
        skew: 0,
        no_repeat_ngram_size: 0,
        speculative_ngram: false,
        min_length: 0,
        num_beams: 1,
        length_penalty: 1,
        penalty_alpha: 0,
        typical_p: 1,
        guidance_scale: 1,
        smoothing_factor: 0,
        smoothing_curve: 1,
        dry_allowed_length: 2,
        dry_multiplier: 0,
        dry_base: 1.75,
        dry_penalty_last_n: 0,
        xtc_threshold: 0.1,
        xtc_probability: 0,
        nsigma: 0,
        min_keep: 0,
        adaptive_target: -0.01,
        adaptive_decay: 0.9,
    };
}

/** The sampler selects as stored, by backend (anything else stored there is read as none). */
function samplerSelectsOf(settings: Record<string, unknown>): Record<string, SamplerSelect> {
    const stored = valueAt(settings, SAMPLER_SELECT);
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
    const selects: Record<string, SamplerSelect> = {};
    for (const [backend, select] of Object.entries(stored as Record<string, unknown>)) {
        if (typeof select !== 'object' || select === null) continue;
        const { manual, shown } = select as { manual?: unknown; shown?: unknown };
        selects[backend] = {
            manual: manual === true,
            shown: Array.isArray(shown) ? shown.filter((name): name is string => SAMPLER_NAMES.includes(name)) : [],
        };
    }
    return selects;
}

const isLevel = (value: string): value is Exclude<Level, 'default'> =>
    (LEVELS as readonly string[]).includes(value) && value !== 'default';

export function settingsArea(ports: Ports) {
    // The range each tab shows (its slider). The server's, so it's what the view says; a tab whose server restarted
    // shows the user's own range again, and its slider shows that.
    const ranges = new Map<string, LevelRange>();
    const rangeOfTab = (session: string) => ranges.get(session) ?? DEFAULT_RANGE;
    const ownerOf = async (context: ViewContext) => (context.chat ? ports.ownerOf(context.user, context.chat) : null);

    const read = async (context: ViewContext): Promise<SettingsView> => {
        const owner = await ownerOf(context);
        const range = rangeOfTab(context.session);
        const [shown, whole] = await Promise.all([
            ports.view(context.user, owner, range),
            ports.view(context.user, owner, FULL),
        ]);
        const values: SettingsView['values'] = {};
        const sources: SettingsView['sources'] = {};
        const defaults = ports.defaults();
        for (const field of FIELDS) {
            values[field.path] = valueAt(shown.settings, field.path) ?? valueAt(defaults, field.path);
            const level = shown.sources[field.path];
            if (level !== undefined && isLevel(level)) sources[field.path] = level;
        }
        const counts: SettingsView['counts'] = {};
        for (const field of FIELDS) {
            const level = whole.sources[field.path];
            if (level !== undefined && isLevel(level)) counts[level] = (counts[level] ?? 0) + 1;
        }
        return {
            context: owner,
            range,
            values,
            sources,
            counts,
            ranges: rangesFor(shown.settings, (source) => ports.models(context.user, source)),
            api: {
                main: textAt(shown.settings, 'main_api'),
                source: textAt(shown.settings, 'oai_settings.chat_completion_source'),
                textgen: textAt(shown.settings, 'textgenerationwebui_settings.type'),
            },
            zen: valueAt(shown.settings, 'power_user.enableZenSliders') === true,
            samplerSelects: samplerSelectsOf(shown.settings),
        };
    };

    const changed: ActionResult = { changed: [VIEW] };

    return defineArea({
        schemas: actions,
        views: { [VIEW]: read },
        followChat: [VIEW],
        actions: {
            'settings.set': async (context, { path, value }) => {
                const field = fieldAt(path);
                if (!field) return { refused: `${path} is not a setting of this panel.` };
                const owner = await ownerOf(context);
                const range = rangeOfTab(context.session);
                const shown = await ports.view(context.user, owner, range);
                const ranges = rangesFor(shown.settings, (source) => ports.models(context.user, source));
                const refusal = refusalOf(
                    field,
                    value,
                    ranges[field.id] ?? { min: field.min, max: field.max, step: field.step },
                );
                if (refusal !== null) return { refused: refusal };
                if (
                    field.id === 'mirostat_mode_textgenerationwebui' &&
                    value === 1 &&
                    MINUS_ONE_BACKENDS.includes(textAt(shown.settings, 'textgenerationwebui_settings.type'))
                )
                    return { refused: 'This backend has no mirostat mode 1.' };
                await ports.write(context.user, owner, range, [[path, value]]);
                return changed;
            },
            'settings.unset': async (context, { path }) => {
                if (!fieldAt(path)) return { refused: `${path} is not a setting of this panel.` };
                const range = rangeOfTab(context.session);
                if (range.to === 'default') return { refused: "The defaults can't be taken away." };
                await ports.write(context.user, await ownerOf(context), range, [[path, undefined]]);
                return changed;
            },
            'settings.reset': async (context, { path }) => {
                const field = fieldAt(path);
                if (!field) return { refused: `${path} is not a setting of this panel.` };
                const owner = await ownerOf(context);
                const range = rangeOfTab(context.session);
                if (range.to === 'default') return { refused: 'The defaults are already the defaults.' };
                await ports.write(context.user, owner, range, [
                    [path, structuredClone(valueAt(ports.defaults(), path))],
                ]);
                return changed;
            },
            'settings.neutralize': async (context) => {
                const owner = await ownerOf(context);
                const range = rangeOfTab(context.session);
                if (range.to === 'default') return { refused: "The defaults can't be changed." };
                const shown = await ports.view(context.user, owner, range);
                const neutral = neutralOf(textAt(shown.settings, 'textgenerationwebui_settings.type'));
                const entries = Object.entries(neutral).map(([key, value]): [string, unknown] => [
                    `textgenerationwebui_settings.${key}`,
                    value,
                ]);
                await ports.write(context.user, owner, range, entries);
                return changed;
            },
            'settings.samplers': async (context, change) => {
                const own = await ports.view(context.user, null, DEFAULT_RANGE);
                const backend = change.backend ?? textAt(own.settings, 'textgenerationwebui_settings.type');
                const selects = samplerSelectsOf(own.settings);
                const now = selects[backend] ?? { manual: false, shown: [] };
                selects[backend] = { manual: change.manual ?? now.manual, shown: change.shown ?? now.shown };
                await ports.write(context.user, null, DEFAULT_RANGE, [[SAMPLER_SELECT, selects]]);
                return changed;
            },
            'settings.samplers.reset': async (context, { backend }) => {
                const own = await ports.view(context.user, null, DEFAULT_RANGE);
                const selects = samplerSelectsOf(own.settings);
                delete selects[backend ?? textAt(own.settings, 'textgenerationwebui_settings.type')];
                await ports.write(context.user, null, DEFAULT_RANGE, [[SAMPLER_SELECT, selects]]);
                return changed;
            },
            'settings.samplers.import': async (context, byBackend) => {
                const own = await ports.view(context.user, null, DEFAULT_RANGE);
                const selects = samplerSelectsOf(own.settings);
                let taken = false;
                for (const [backend, select] of Object.entries(byBackend)) {
                    if (selects[backend]) continue;
                    selects[backend] = {
                        manual: select.manual,
                        shown: select.shown.filter((name) => SAMPLER_NAMES.includes(name)),
                    };
                    taken = true;
                }
                if (taken) await ports.write(context.user, null, DEFAULT_RANGE, [[SAMPLER_SELECT, selects]]);
                return changed;
            },
            'settings.range': async (context, range) => {
                if (LEVELS.indexOf(range.from) > LEVELS.indexOf(range.to))
                    return { refused: 'A range goes from a farther level to a closer one.' };
                ranges.set(context.session, range);
                return changed;
            },
        },
    });
}
