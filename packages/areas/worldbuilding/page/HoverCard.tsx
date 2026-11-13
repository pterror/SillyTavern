import { For, Show, createSignal } from 'solid-js';
import { useUi } from '@st/page/context';
import { CARD_VIEW } from '../protocol.ts';
import type { CardView } from '../protocol.ts';
import { Label, Picture } from './Cards.tsx';
import { useWb } from './context.ts';
import { shownView } from './views.ts';

const CARD_WIDTH = 360;
const CARD_HEIGHT_GUESS = 160;

type Pointed = { book: string; entry: string; word: HTMLElement; left: number; top: number; above: boolean };

// The card of a linked name, shown while the name or the card is pointed at; each name pointed at asks for its card.
// The card's box reaches the name, so moving the pointer from one to the other never leaves both.
export function hoverCards() {
    const { client } = useUi();
    const wb = useWb();
    const card = shownView<CardView>(client, CARD_VIEW);
    const [pointed, setPointed] = createSignal<Pointed | null>(null);
    let box: HTMLElement | undefined;
    const enter = (book: string, entry: string, word: HTMLElement) => {
        if (pointed()?.word === word) return;
        const host = word.closest('.wb-entry');
        const pane = word.closest('.wb-pane');
        if (!(host instanceof HTMLElement) || !(pane instanceof HTMLElement)) return;
        const frame = host.getBoundingClientRect();
        const seen = pane.getBoundingClientRect();
        const at = word.getBoundingClientRect();
        const left = Math.max(16, Math.min(at.left - frame.left - 12, frame.width - CARD_WIDTH - 16));
        const above = at.bottom + CARD_HEIGHT_GUESS > seen.bottom;
        const top = above ? at.top - frame.top : at.bottom - frame.top;
        setPointed({ book, entry, word, left, top, above });
        void wb.act('worldbuilding.showCard', { book, entry });
    };
    const leave = (event: MouseEvent) => {
        const to = event.relatedTarget;
        if (to instanceof Node && (box?.contains(to) === true || pointed()?.word.contains(to) === true)) return;
        setPointed(null);
    };
    const shown = () => {
        const at = pointed();
        const read = card();
        if (!at || !read || read.book === null || read.entry !== at.entry) return null;
        return { at, read };
    };
    const Drawn = () => (
        <Show when={shown()}>
            {(both) => (
                <div
                    ref={(element) => (box = element)}
                    class="wb-hover-at"
                    classList={{ 'wb-hover-above': both().at.above }}
                    style={{ left: `${both().at.left}px`, top: `${both().at.top}px` }}
                    onMouseLeave={leave}
                >
                    <button
                        type="button"
                        class="wb-hover"
                        onClick={() => {
                            setPointed(null);
                            wb.open(both().read.entry);
                        }}
                    >
                        <Show when={both().read.picture}>{(url) => <Picture url={url()} class="wb-hover-pic" />}</Show>
                        <span class="wb-hover-words">
                            <span class="wb-hover-name">
                                <Label named={both().read.label} />
                            </span>
                            <Show when={both().read.relations.length > 0}>
                                <span class="wb-hover-path">
                                    <For each={both().read.relations}>
                                        {(relation, at) => (
                                            <>
                                                {at() > 0 ? ' · ' : ''}
                                                {relation.kindName ?? ''}: {relation.target?.text ?? ''}
                                            </>
                                        )}
                                    </For>
                                </span>
                            </Show>
                            <span class="wb-hover-text">{both().read.text}</span>
                        </span>
                    </button>
                </div>
            )}
        </Show>
    );
    return { enter, leave, Drawn };
}
