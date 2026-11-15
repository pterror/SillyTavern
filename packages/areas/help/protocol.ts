import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

export const PANEL_VIEW = 'help.panel';

/** In the order the panel lists them. */
export const TOPICS = ['overview', 'slash', 'format', 'hotkeys', 'macros'] as const;

export type Topic = (typeof TOPICS)[number];

export type PanelView = { open: false } | { open: true; topic: Topic };

export const actions = {
    /** `name`: a topic's id or one of the names `/help` takes for it; any other opens the overview */
    'help.open': v.object({ name: v.string() }),
    'help.show': v.object({ topic: v.picklist(TOPICS) }),
    'help.close': v.object({}),
} satisfies ActionSchemas;
