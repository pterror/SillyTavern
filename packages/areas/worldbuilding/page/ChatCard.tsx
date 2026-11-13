import { For, Show, createSignal } from 'solid-js';
import type { Client } from '@st/page/client';
import { CARD_ENTRIES_AT_MOST, CARD_VIEW } from '../protocol.ts';
import type { CardAsked, CardView, EntryAt } from '../protocol.ts';
import { HoverItem, cardsFor } from './HoverCard.tsx';
import { shownView } from './views.ts';

const CARD_WIDTH = 360;
const CARD_HEIGHT_GUESS = 180;
const EDGE = 16;

// `latest`: the reply is the chat's last, which is what its card says brought the entries up.
export type Peek = { entries: EntryAt[]; reply: string | null; latest: boolean };

type Pointed = Peek & { word: HTMLElement; left: number; top: number; above: boolean };

// The card of what a word in the chat names or brought up, shown while the word or the card is pointed at. Each word
// pointed at asks for its card in one action; the card's box reaches the word, so moving between them keeps it.
export function chatCards(client: Client, open: (at: EntryAt) => void) {
    const view = shownView<CardView>(client, CARD_VIEW);
    const [pointed, setPointed] = createSignal<Pointed | null>(null);
    let box: HTMLElement | undefined;
    const askedOf = (peek: Peek): CardAsked => ({ entries: peek.entries, reply: peek.reply });

    const peek = (word: HTMLElement, wanted: Peek) => {
        if (pointed()?.word === word || wanted.entries.length === 0) return;
        const entries = wanted.entries.slice(0, CARD_ENTRIES_AT_MOST);
        const at = word.getBoundingClientRect();
        const left = Math.max(EDGE, Math.min(at.left - 12, window.innerWidth - CARD_WIDTH - EDGE));
        const above = at.bottom + CARD_HEIGHT_GUESS > window.innerHeight;
        setPointed({ ...wanted, entries, word, left, top: above ? at.top : at.bottom, above });
        void client.send('worldbuilding.showCard', askedOf({ ...wanted, entries }));
    };
    const unpeek = (to: EventTarget | null) => {
        const shown = pointed();
        if (!shown) return;
        if (to instanceof Node && (box?.contains(to) === true || shown.word.contains(to))) return;
        setPointed(null);
    };
    const shown = () => {
        const at = pointed();
        const cards = at ? cardsFor(view(), askedOf(at)) : null;
        return at && cards && cards.length > 0 ? { at, cards } : null;
    };

    const Drawn = () => (
        <Show when={shown()}>
            {(both) => (
                <div
                    ref={(element) => (box = element)}
                    class="wb-chat-card-at"
                    classList={{ 'wb-hover-above': both().at.above }}
                    style={{ left: `${both().at.left}px`, top: `${both().at.top}px` }}
                    onMouseLeave={(event) => unpeek(event.relatedTarget)}
                >
                    <div class="wb-chat-card">
                        <For each={both().cards}>
                            {(card, at) => (
                                <>
                                    <Show when={at() > 0}>
                                        <div class="wb-chat-card-sep" />
                                    </Show>
                                    <button
                                        type="button"
                                        class="wb-chat-card-item"
                                        onClick={() => {
                                            setPointed(null);
                                            open({ book: card.book, entry: card.entry });
                                        }}
                                    >
                                        <HoverItem card={card} reply={both().at.latest ? 'latest' : 'other'} />
                                    </button>
                                </>
                            )}
                        </For>
                    </div>
                </div>
            )}
        </Show>
    );
    return { peek, unpeek, Drawn };
}
