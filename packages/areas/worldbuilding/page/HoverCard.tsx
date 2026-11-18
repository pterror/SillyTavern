import { For, Show, createSignal, onCleanup } from 'solid-js';
import { useUi } from '@st/page/context';
import { inTopLayer } from '@st/page/popover';
import { CARD_VIEW } from '../protocol.ts';
import type { CardAsked, CardView, EntryAt, HoverCard } from '../protocol.ts';
import { EntryContent } from './EntryContent.tsx';
import { useWb } from './context.ts';
import { PHONE } from './layout.ts';
import { shownView } from './views.ts';
import { fill } from './words.ts';

export const CARD_WIDTH = 640;
const CARD_HEIGHT_GUESS = 480;

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

// One entry's shared presentation and, when the card
// was asked about a reply, what brought it into that reply.
export function HoverItem(props: { card: HoverCard; reply: 'latest' | 'other' }) {
    const { t } = useUi();
    return (
        <>
            <div class="wb-hover-content">
                <RelationsPath card={props.card} class="wb-hover-path" />
                <Show when={props.card.moreRelations > 0}>
                    <span class="wb-hover-path">
                        {fill(t('+${0} more relationships'), String(props.card.moreRelations))}
                    </span>
                </Show>
                <EntryContent entry={props.card} />
                <Show when={broughtUpSentence(props.card, props.reply, t)}>
                    {(said) => <span class="wb-hover-why">{said()}</span>}
                </Show>
            </div>
        </>
    );
}

// `card`: pointed at from an entry's card, whose own click opens the entry.
type Pointed = {
    asked: CardAsked;
    word: HTMLElement;
    card: boolean;
    left: number;
    top: number;
    above: boolean;
    width: number;
    height: number;
};

// The card of a linked name, shown while the name or the card is pointed at; each name pointed at asks for its card.
// The card's box reaches the name, so moving the pointer from one to the other never leaves both. The card of an entry's
// card also stays open while the pointer moves into the preview to scroll it.
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
    const fromWord = inTopLayer(() => pointed()?.word);
    const enter = (book: string, entry: string, word: HTMLElement, from: 'word' | 'card' = 'word') => {
        if (onPhone() || wb.drag.held() !== null || pointed()?.word === word) return;
        const at = word.getBoundingClientRect();
        const width = Math.min(CARD_WIDTH, window.innerWidth - 32);
        const left = Math.max(16, Math.min(at.left - 12, window.innerWidth - width - 16));
        const below = window.innerHeight - at.bottom;
        const over = at.top;
        const above = below < CARD_HEIGHT_GUESS && over > below;
        const height = Math.max(80, Math.min(CARD_HEIGHT_GUESS, (above ? over : below) - 16));
        const top = above ? at.top : at.bottom;
        const asked: CardAsked = { entries: [{ book, entry } satisfies EntryAt], reply: null };
        setPointed({ asked, word, card: from === 'card', left, top, above, width, height });
        void wb.act('worldbuilding.showCard', asked);
    };
    const leave = (event: MouseEvent) => {
        const to = event.relatedTarget;
        const at = pointed();
        if (to instanceof Node && (box?.contains(to) === true || at?.word.contains(to) === true)) return;
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
                    ref={(element) => {
                        box = element;
                        fromWord(element);
                    }}
                    class={['wb-hover-at', { 'wb-hover-above': both().at.above }]}
                    style={{
                        left: `${both().at.left}px`,
                        top: `${both().at.top}px`,
                        width: `${both().at.width}px`,
                        '--wb-preview-height': `${both().at.height}px`,
                    }}
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
