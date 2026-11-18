import { createContext, useContext } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { ActionResult } from '@st/page/client';
import type { OverviewLayout, PointingAtShown } from '../protocol.ts';
import type { DragControl } from './Drag.tsx';
import type { Edited, EntryEditPayload } from './conflict.tsx';
import type { TextField } from './copies.ts';

export type Wb = {
    // Sends one action; a refusal is said on the page and comes back as the result.
    act(type: string, payload: unknown, file?: File): Promise<ActionResult>;
    // Sends one edit of an entry, made against the version in `payload`; see `editEntry`.
    edit(type: string, payload: EntryEditPayload, text?: TextField): Promise<Edited>;
    layout: Accessor<OverviewLayout>;
    // The top-level entries a newly shown world reads first.
    firstRead: Accessor<{ layout: OverviewLayout; ahead: number }>;
    pointingAt: Accessor<PointingAtShown>;
    open(entry: string): void;
    say(words: string): void;
    // Says what was done, with Undo, which runs `undo`.
    offerUndo(words: string, undo: () => void): void;
    drag: DragControl;
};

const WbContext = createContext<Wb>();

export const WbProvider = WbContext;

export function useWb(): Wb {
    return useContext(WbContext);
}
