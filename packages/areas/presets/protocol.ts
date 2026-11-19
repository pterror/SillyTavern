import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

export const VIEW = 'presets';
export const FAMILIES = ['kobold', 'novel', 'openai', 'textgenerationwebui'] as const;
export type Family = (typeof FAMILIES)[number];
export type Preset = { name: string; data: Record<string, unknown> };
export type Catalog = { selected: string; presets: Preset[] };
export type PresetsView = Record<Family, Catalog> & {
    bindConnection: boolean;
    /** Lets the remaining settings writers acknowledge precisely the settings this view changed. */
    settingsHashes: Record<string, number>;
};

const family = v.picklist(FAMILIES);
const name = v.pipe(v.string(), v.trim(), v.minLength(1));
export const actions = {
    'presets.bindConnection': v.object({ enabled: v.boolean() }),
    'presets.select': v.object({ family, name: v.string() }),
    'presets.save': v.object({ family, name, activate: v.optional(v.boolean(), true) }),
    'presets.rename': v.object({ family, name, to: name }),
    'presets.delete': v.object({ family, name }),
    'presets.restore': v.object({ family, name }),
    'presets.import': v.object({
        family,
        name,
        data: v.record(v.string(), v.unknown()),
        overwrite: v.boolean(),
        activate: v.optional(v.boolean(), true),
    }),
    'presets.order': v.object({ family, names: v.array(v.string()) }),
} satisfies ActionSchemas;
