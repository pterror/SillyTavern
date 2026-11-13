import { createContext, useContext } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { ActionResult } from '@st/page/client';
import type { OverviewLayout, PointingAtShown } from '../protocol.ts';
import type { DragControl } from './Drag.tsx';

export type Wb = {
    // Sends one action; a refusal is said on the page and comes back as the result.
    act(type: string, payload: unknown, file?: File): Promise<ActionResult>;
    layout: Accessor<OverviewLayout>;
    // The top-level entries a newly shown world reads first.
    firstRead: Accessor<{ firstRank: number; endRank: number; layout: OverviewLayout }>;
    pointingAt: Accessor<PointingAtShown>;
    open(entry: string): void;
    say(words: string): void;
    drag: DragControl;
};

const WbContext = createContext<Wb>();

export const WbProvider = WbContext.Provider;

export function useWb(): Wb {
    const wb = useContext(WbContext);
    if (!wb) throw new Error('A part of the worldbuilding page was drawn outside it');
    return wb;
}
