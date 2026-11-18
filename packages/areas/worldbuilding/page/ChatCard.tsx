import { For, Show, createSignal, onSettled } from 'solid-js';
import type { Client } from '@st/page/client';
import { useUi } from '@st/page/context';
import { inTopLayer } from '@st/page/popover';
import { CARD_ENTRIES_AT_MOST, CARD_VIEW } from '../protocol.ts';
import type { CardAsked, CardView, EntryAt, HoverCard } from '../protocol.ts';
import { CARD_WIDTH, HoverItem, cardsFor } from './HoverCard.tsx';
import { shownView } from './views.ts';

const CARD_HEIGHT_GUESS = 480;
const EDGE = 16;
// A pull on the sheet's grab this far down closes it.
const SHEET_PULL_CLOSES = 60;

// `latest`: the reply is the chat's last, which is what its card says brought the entries up.
export type Peek = { entries: EntryAt[]; reply: string | null; latest: boolean };

// `sheet`: tapped on a phone, drawn from the bottom until closed; otherwise pointed at, drawn by the word.
type Pointed = Peek & { word: HTMLElement; left: number; top: number; above: boolean; sheet: boolean; height: number };

const TAPPED_CLASS = 'wb-tapped';

// The card of what a word in the chat names or brought up. Pointed at, it shows while the word or the card is; tapped
// on a phone, it comes up from the bottom with Open. Each word asks for its card in one action; the pointed card's box
// reaches the word, so moving between them keeps it.
export function chatCards(client: Client, open: (at: EntryAt) => void) {
    const view = shownView<CardView>(client, CARD_VIEW);
    const [pointed, setPointed] = createSignal<Pointed | null>(null);
    let box: HTMLElement | undefined;
    const askedOf = (peek: Peek): CardAsked => ({ entries: peek.entries, reply: peek.reply });

    const point = (next: Pointed | null) => {
        pointed()?.word.classList.remove(TAPPED_CLASS);
        if (next?.sheet === true) next.word.classList.add(TAPPED_CLASS);
        setPointed(next);
    };
    const show = (word: HTMLElement, wanted: Peek, sheet: boolean) => {
        const now = pointed();
        if ((now?.word === word && now.sheet === sheet) || wanted.entries.length === 0) return;
        const entries = wanted.entries.slice(0, CARD_ENTRIES_AT_MOST);
        const at = word.getBoundingClientRect();
        const left = Math.max(EDGE, Math.min(at.left - 12, window.innerWidth - CARD_WIDTH - EDGE));
        const below = window.innerHeight - at.bottom;
        const above = below < CARD_HEIGHT_GUESS && at.top > below;
        const height = Math.max(80, Math.min(CARD_HEIGHT_GUESS, (above ? at.top : below) - 2 * EDGE));
        point({ ...wanted, entries, word, left, top: above ? at.top : at.bottom, above, sheet, height });
        void client.send('worldbuilding.showCard', askedOf({ ...wanted, entries }));
    };
    const peek = (word: HTMLElement, wanted: Peek) => {
        if (pointed()?.sheet === true) return;
        show(word, wanted, false);
    };
    const tap = (word: HTMLElement, wanted: Peek) => {
        show(word, wanted, true);
    };
    const unpeek = (to: EventTarget | null) => {
        const shown = pointed();
        if (!shown || shown.sheet) return;
        if (to instanceof Node && (box?.contains(to) === true || shown.word.contains(to))) return;
        point(null);
    };
    const shown = () => {
        const at = pointed();
        const cards = at ? cardsFor(view(), askedOf(at)) : null;
        return at && cards && cards.length > 0 ? { at, cards } : null;
    };
    const opened = (card: HoverCard) => {
        point(null);
        open({ book: card.book, entry: card.entry });
    };
    const fromWord = inTopLayer(() => pointed()?.word);

    const Drawn = () => (
        <Show when={shown()}>
            {(both) => (
                <Show
                    when={both().at.sheet}
                    fallback={
                        <div
                            ref={(element) => {
                                box = element;
                                fromWord(element);
                            }}
                            class={['wb-chat-card-at', { 'wb-hover-above': both().at.above }]}
                            style={{
                                left: `${both().at.left}px`,
                                top: `${both().at.top}px`,
                                '--wb-preview-height': `${both().at.height}px`,
                            }}
                            onMouseLeave={(event) => unpeek(event.relatedTarget)}
                        >
                            <div class="st-floating wb-chat-card">
                                <For each={both().cards}>
                                    {(card, at) => (
                                        <>
                                            <Show when={at() > 0}>
                                                <div class="wb-chat-card-sep" />
                                            </Show>
                                            <button
                                                type="button"
                                                class="wb-chat-card-item"
                                                onClick={() => opened(card)}
                                            >
                                                <HoverItem card={card} reply={both().at.latest ? 'latest' : 'other'} />
                                            </button>
                                        </>
                                    )}
                                </For>
                            </div>
                        </div>
                    }
                >
                    <Sheet
                        ref={fromWord}
                        cards={both().cards}
                        reply={both().at.latest ? 'latest' : 'other'}
                        onOpen={opened}
                        onClose={() => point(null)}
                    />
                </Show>
            )}
        </Show>
    );
    return { peek, tap, unpeek, Drawn };
}

function Sheet(props: {
    ref: (element: HTMLElement) => void;
    cards: HoverCard[];
    reply: 'latest' | 'other';
    onOpen: (card: HoverCard) => void;
    onClose: () => void;
}) {
    const { commands, t } = useUi();
    let pulledFrom: number | null = null;
    // Wherever focus is, before a field's own Escape and the old page's drawers.
    onSettled(() =>
        commands.register(
            [
                {
                    id: 'worldbuilding.closeCard',
                    label: t('Close the card'),
                    category: t('Worldbuilding'),
                    keys: ['Escape'],
                    typing: true,
                    run: () => props.onClose(),
                },
            ],
            { capture: true, everywhere: true },
        ),
    );
    return (
        <div ref={props.ref} class="wb-chat-sheet-at">
            <div class="wb-chat-scrim" onClick={() => props.onClose()} />
            <div
                class="st-floating wb-chat-sheet"
                role="dialog"
                aria-label={props.cards[0]?.label.text}
                onTouchStart={(event) => (pulledFrom = event.touches[0]?.clientY ?? null)}
                onTouchEnd={(event) => {
                    const to = event.changedTouches[0]?.clientY;
                    if (pulledFrom !== null && to !== undefined && to - pulledFrom > SHEET_PULL_CLOSES) props.onClose();
                    pulledFrom = null;
                }}
            >
                <span class="wb-chat-sheet-grab" aria-hidden="true" />
                <For each={props.cards}>
                    {(card, at) => (
                        <>
                            <Show when={at() > 0}>
                                <div class="wb-chat-card-sep" />
                            </Show>
                            <HoverItem card={card} reply={props.reply} />
                            <button type="button" class="wb-chat-sheet-open" onClick={() => props.onOpen(card)}>
                                {t('Open')}
                            </button>
                        </>
                    )}
                </For>
            </div>
        </div>
    );
}
