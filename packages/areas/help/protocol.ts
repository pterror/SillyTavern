import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

export const PANEL_VIEW = 'help.panel';
export const HOTKEYS_VIEW = 'help.hotkeys';

/** In the order the panel lists them. */
export const TOPICS = ['overview', 'slash', 'format', 'hotkeys', 'macros'] as const;

export type Topic = (typeof TOPICS)[number];

export type PanelView = { open: false } | { open: true; topic: Topic; query: string };

/** `markdown`: whether the markdown formatting hotkeys are on in the settings this tab's chat uses */
export type HotkeysView = { markdown: boolean };

export const actions = {
    /** `name`: a topic's id or one of the names `/help` takes for it; any other opens the overview */
    'help.open': v.object({ name: v.string() }),
    'help.show': v.object({ topic: v.picklist(TOPICS) }),
    'help.search': v.object({ query: v.string() }),
    'help.close': v.object({}),
} satisfies ActionSchemas;
