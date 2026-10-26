import {
    FIELDS,
    VIEW,
    DEFAULT_RANGE,
    LAB_RANGE,
    LEVELS,
    actions,
    fieldAt,
    rangeOf,
    refusalOf,
} from '@st/protocol/settings';
import type { Level, LevelRange, Range, SettingsView } from '@st/protocol/settings';
import type { ChatOwner } from '@st/protocol';
import { defineArea } from './index.ts';
import type { ActionResult, ChatRef, User, ViewContext } from './index.ts';
import { limitsOfSettings } from './model-limits.ts';
import type { ModelLists, ModelRecord } from './model-limits.ts';

// The AI response configuration panel's settings (packages/protocol/src/settings.ts): a tab's chat's settings over
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
    /** Writes one path where an edit over the range goes (undefined: takes it away). */
    writeAt(user: User, owner: ChatOwner | null, range: LevelRange, path: string, value: unknown): Promise<void>;
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
    if (valueAt(settings, 'power_user.enableLabMode') === true)
        for (const field of FIELDS) if (field.lab) ranges[field.id] = { ...LAB_RANGE };
    return ranges;
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
                await ports.writeAt(context.user, owner, range, path, value);
                return changed;
            },
            'settings.unset': async (context, { path }) => {
                if (!fieldAt(path)) return { refused: `${path} is not a setting of this panel.` };
                const range = rangeOfTab(context.session);
                if (range.to === 'default') return { refused: "The defaults can't be taken away." };
                await ports.writeAt(context.user, await ownerOf(context), range, path, undefined);
                return changed;
            },
            'settings.reset': async (context, { path }) => {
                const field = fieldAt(path);
                if (!field) return { refused: `${path} is not a setting of this panel.` };
                const owner = await ownerOf(context);
                const range = rangeOfTab(context.session);
                if (range.to === 'default') return { refused: 'The defaults are already the defaults.' };
                await ports.writeAt(context.user, owner, range, path, structuredClone(valueAt(ports.defaults(), path)));
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
