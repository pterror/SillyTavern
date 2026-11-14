import { For, Show, createSignal, onCleanup } from 'solid-js';
import { useUi } from '@st/page/context';
import { CARD_VIEW } from '../protocol.ts';
import type { CardAsked, CardView, EntryAt, HoverCard } from '../protocol.ts';
import { Label, Picture } from './Cards.tsx';
import { useWb } from './context.ts';
import { PHONE } from './layout.ts';
import { shownView } from './views.ts';
import { fill } from './words.ts';

const CARD_WIDTH = 360;
const CARD_HEIGHT_GUESS = 160;

const sameAsked = (one: CardAsked | null, other: CardAsked): boolean =>
    one !== null &&
    one.reply === other.reply &&
    one.entries.length === other.entries.length &&
    one.entries.every((at, i) => {
        const theirs = other.entries[i];
        return theirs !== undefined && at.book === theirs.book && at.entry === theirs.entry;
    });

// The cards the view holds for `asked`, or null while it holds another request's.
export const cardsFor = (view: CardView | undefined, asked: CardAsked): HoverCard[] | null =>
    view !== undefined && sameAsked(view.asked, asked) ? view.cards : null;

// “Ilse”, “Ilse” and “ledger”, “a”, “b” and “c”.
export function quotedList(keys: string[], and: string): string {
    const quoted = keys.map((key) => `“${key}”`);
    if (quoted.length < 2) return quoted.join('');
    return `${quoted.slice(0, -1).join(', ')} ${and} ${quoted.at(-1) ?? ''}`;
}

// What brought the card's entry into the reply it was asked about, as a sentence; null when it wasn't asked or nothing did.
export function broughtUpSentence(
    card: HoverCard,
    reply: 'latest' | 'other',
    t: (text: string) => string,
): string | null {
    const keys = card.broughtUpBy;
    if (keys === null || keys.length === 0) return null;
    const sentence =
        reply === 'latest' ? t('Activated by ${0} in the last reply') : t('Activated by ${0} in that reply');
    return fill(sentence, quotedList(keys, t('and')));
}

// "kind: target · kind: target".
export function RelationsPath(props: { card: HoverCard; class: string }) {
    return (
        <Show when={props.card.relations.length > 0}>
            <span class={props.class}>
                <For each={props.card.relations}>
                    {(relation, at) => (
                        <>
                            {at() > 0 ? ' · ' : ''}
                            {relation.kindName ?? ''}: {relation.target?.text ?? ''}
                        </>
                    )}
                </For>
            </span>
        </Show>
    );
}

// One entry's part of a card: its picture, its name in its look, its relations, its text's opening, and, when the card
// was asked about a reply, what brought it into that reply.
export function HoverItem(props: { card: HoverCard; reply: 'latest' | 'other' }) {
    const { t } = useUi();
    return (
        <>
            <Show when={props.card.picture}>{(url) => <Picture url={url()} class="wb-hover-pic" />}</Show>
            <span class="wb-hover-words">
                <span class="wb-hover-name">
                    <Label named={props.card.label} />
                </span>
                <RelationsPath card={props.card} class="wb-hover-path" />
                <span class="wb-hover-text">{props.card.text}</span>
                <Show when={broughtUpSentence(props.card, props.reply, t)}>
                    {(said) => <span class="wb-hover-why">{said()}</span>}
                </Show>
            </span>
        </>
    );
}

type Pointed = { asked: CardAsked; word: HTMLElement; left: number; top: number; above: boolean };

// The card of a linked name, shown while the name or the card is pointed at; each name pointed at asks for its card.
// The card's box reaches the name, so moving the pointer from one to the other never leaves both.
// Pointing shows no card on a phone, where a tap opens instead, nor while a card is dragged, where it would cover what
// the drag points at; a card pointed at before either goes with the change.
export function hoverCards() {
    const { client } = useUi();
    const wb = useWb();
    const view = shownView<CardView>(client, CARD_VIEW);
    const [pointed, setPointed] = createSignal<Pointed | null>(null);
    const phone = window.matchMedia(PHONE);
    const [onPhone, setOnPhone] = createSignal(phone.matches);
    const layoutChanged = () => {
        setOnPhone(phone.matches);
        if (phone.matches) setPointed(null);
    };
    phone.addEventListener('change', layoutChanged);
    onCleanup(() => phone.removeEventListener('change', layoutChanged));
    let box: HTMLElement | undefined;
    const enter = (book: string, entry: string, word: HTMLElement) => {
        if (onPhone() || wb.drag.held() !== null || pointed()?.word === word) return;
        const host = word.closest('.wb-hover-host');
        const pane = word.closest('.wb-pane');
        if (!(host instanceof HTMLElement) || !(pane instanceof HTMLElement)) return;
        const frame = host.getBoundingClientRect();
        const seen = pane.getBoundingClientRect();
        const at = word.getBoundingClientRect();
        const left = Math.max(16, Math.min(at.left - frame.left - 12, frame.width - CARD_WIDTH - 16));
        const above = at.bottom + CARD_HEIGHT_GUESS > seen.bottom;
        const top = above ? at.top - frame.top : at.bottom - frame.top;
        const asked: CardAsked = { entries: [{ book, entry } satisfies EntryAt], reply: null };
        setPointed({ asked, word, left, top, above });
        void wb.act('worldbuilding.showCard', asked);
    };
    const leave = (event: MouseEvent) => {
        const to = event.relatedTarget;
        if (to instanceof Node && (box?.contains(to) === true || pointed()?.word.contains(to) === true)) return;
        setPointed(null);
    };
    const shown = () => {
        const at = onPhone() || wb.drag.held() !== null ? null : pointed();
        const card = at ? cardsFor(view(), at.asked)?.[0] : undefined;
        return at && card ? { at, card } : null;
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
                        class="st-floating wb-hover"
                        onClick={() => {
                            setPointed(null);
                            wb.open(both().card.entry);
                        }}
                    >
                        <HoverItem card={both().card} reply="other" />
                    </button>
                </div>
            )}
        </Show>
    );
    return { enter, leave, hide: () => setPointed(null), Drawn };
}
