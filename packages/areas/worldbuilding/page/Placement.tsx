import { For, Show, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import { useUi } from '@st/page/context';
import type { CharacterFilterShown, Placement } from '../protocol.ts';
import { CharacterFilterSentence, filterIsSet } from './CharacterFilter.tsx';
import type { FilterChange } from './CharacterFilter.tsx';
import { dismissOn } from './dismiss.ts';
import { count, fill } from './words.ts';

// Where an entry goes, in the order the sentence offers them, with upstream's `position` for each.
export const WHERES: { position: Placement['position']; words: string }[] = [
    { position: 0, words: 'before the character’s description' },
    { position: 1, words: 'after the character’s description' },
    { position: 5, words: 'before the example messages' },
    { position: 6, words: 'after the example messages' },
    { position: 2, words: 'at the top of the author’s note' },
    { position: 3, words: 'at the bottom of the author’s note' },
    { position: 4, words: 'into the chat' },
];
const OUTLET: Placement['position'] = 7;
const IN_CHAT: Placement['position'] = 4;

export type Comes = 'brought up' | 'always' | 'never';

export const comesOf = (placement: Pick<Placement, 'constant' | 'disable'>): Comes =>
    placement.disable ? 'never' : placement.constant ? 'always' : 'brought up';

const COMES: { comes: Comes; words: string; change: Partial<Placement> }[] = [
    { comes: 'brought up', words: 'when it’s brought up', change: { constant: false, disable: false } },
    { comes: 'always', words: 'always', change: { constant: true, disable: false } },
    { comes: 'never', words: 'never', change: { constant: false, disable: true } },
];

export const chanceOf = (placement: Pick<Placement, 'probability' | 'useProbability'>): number =>
    placement.useProbability ? placement.probability : 100;

type Extra = 'sticky' | 'cooldown' | 'delay' | 'keysecondary' | 'group' | 'scanDepth';

const EXTRAS: { extra: Extra; offer: string; before: string; after: string }[] = [
    {
        extra: 'sticky',
        offer: 'Stays for some replies after coming up',
        before: 'Stays for ',
        after: ' replies after coming up.',
    },
    {
        extra: 'cooldown',
        offer: 'Waits some replies before coming up again',
        before: 'Waits ',
        after: ' replies before coming up again.',
    },
    {
        extra: 'delay',
        offer: 'Only after the chat has some messages',
        before: 'Only after the chat has ',
        after: ' messages.',
    },
    {
        extra: 'keysecondary',
        offer: 'Needs other words written too',
        before: 'Needs these words written too: ',
        after: '.',
    },
    { extra: 'group', offer: 'Only one of a group comes in', before: 'Only one of the group ', after: ' comes in.' },
    {
        extra: 'scanDepth',
        offer: 'Looks further back in the chat for its keys',
        before: 'Looks ',
        after: ' messages back in the chat for its keys.',
    },
];

const extraValue = (placement: Placement, extra: Extra): string | null => {
    switch (extra) {
        case 'sticky':
        case 'cooldown':
        case 'delay':
        case 'scanDepth': {
            const value = placement[extra];
            return value === null || (extra !== 'scanDepth' && value === 0) ? null : String(value);
        }
        case 'keysecondary':
            return placement.keysecondary.length === 0 ? null : placement.keysecondary.join(', ');
        case 'group':
            return placement.group.trim() === '' ? null : placement.group;
    }
};

// The change that sets an extra from what was typed; an empty answer takes it away.
const extraChange = (extra: Extra, typed: string): Partial<Placement> | null => {
    const text = typed.trim();
    if (extra === 'keysecondary')
        return {
            keysecondary:
                text === ''
                    ? []
                    : text
                          .split(',')
                          .map((word) => word.trim())
                          .filter((word) => word !== ''),
        };
    if (extra === 'group') return { group: text };
    if (text === '') return { [extra]: null };
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0) return null;
    return { [extra]: n };
};

function Token(props: {
    shown: string;
    value: string;
    label: string;
    wide?: boolean;
    editing?: boolean;
    onSet: (typed: string) => void;
    onCancel?: () => void;
}) {
    const [editing, setEditing] = createSignal(props.editing === true);
    return (
        <Show
            when={editing()}
            fallback={
                <button type="button" class="wb-tok" aria-label={props.label} onClick={() => setEditing(true)}>
                    {props.shown}
                </button>
            }
        >
            <TokenField
                value={props.value}
                label={props.label}
                wide={props.wide === true}
                onDone={(typed) => {
                    setEditing(false);
                    if (typed === null) props.onCancel?.();
                    else props.onSet(typed);
                }}
            />
        </Show>
    );
}

function TokenField(props: { value: string; label: string; wide: boolean; onDone: (typed: string | null) => void }) {
    let field: HTMLInputElement | undefined;
    let finished = false;
    const finish = (typed: string | null) => {
        if (finished) return;
        finished = true;
        props.onDone(typed);
    };
    onMount(() => field?.select());
    return (
        <input
            ref={(element) => (field = element)}
            class="text_pole margin0 wb-tok-field"
            classList={{ 'wb-tok-wide': props.wide }}
            aria-label={props.label}
            value={props.value}
            on:keydown={(event) => {
                if (event.key === 'Enter') finish((event.currentTarget as HTMLInputElement).value);
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                finish(null);
            }}
            onBlur={(event) => finish(event.currentTarget.value)}
        />
    );
}

function Choices<T>(props: {
    label: string;
    items: { value: T; words: string }[];
    chosen: T;
    onPick: (value: T) => void;
    style?: JSX.CSSProperties;
}) {
    const { t } = useUi();
    return (
        <span class="list-group st-floating wb-choices" role="listbox" aria-label={props.label} style={props.style}>
            <For each={props.items}>
                {(item) => (
                    <button
                        type="button"
                        role="option"
                        class="list-group-item wb-choice"
                        classList={{ 'wb-on': item.value === props.chosen }}
                        aria-selected={item.value === props.chosen}
                        onClick={() => props.onPick(item.value)}
                    >
                        {t(item.words)}
                    </button>
                )}
            </For>
        </span>
    );
}

const CHARACTERS_OFFER = 'Only for some characters';

export function PlacementPopover(props: {
    placement: Placement;
    characterFilter: CharacterFilterShown;
    tokens: number | null;
    opener: () => HTMLElement | undefined;
    onSet: (fields: Partial<Omit<Placement, 'characterFilter'>>) => void;
    onFilter: (change: FilterChange) => void;
    onClose: () => void;
}) {
    const { t } = useUi();
    const [list, setList] = createSignal<'comes' | 'where' | 'more' | null>(null);
    const [adding, setAdding] = createSignal<Extra | null>(null);
    const [filtering, setFiltering] = createSignal(false);
    const filterShown = () => filterIsSet(props.characterFilter) || filtering();
    let box: HTMLDivElement | undefined;
    dismissOn(() => box, props.onClose, props.opener);
    const p = () => props.placement;
    const chance = () => chanceOf(p());
    const wheres = () =>
        p().position === OUTLET
            ? [...WHERES, { position: OUTLET, words: fill('into the outlet “${0}”', p().outletName) }]
            : WHERES;
    const whereWords = () => t(wheres().find((where) => where.position === p().position)?.words ?? '');
    const toggle = (which: 'comes' | 'where' | 'more') => setList(list() === which ? null : which);
    const shownExtras = () =>
        EXTRAS.filter((extra) => extraValue(p(), extra.extra) !== null || adding() === extra.extra);
    const offered = () => EXTRAS.filter((extra) => extraValue(p(), extra.extra) === null && adding() !== extra.extra);
    return (
        <div class="wb-place" role="dialog" aria-label={t('In the prompt')} ref={(element) => (box = element)}>
            <div class="wb-place-head">
                <b>{t('In the prompt')}</b>
                <Show when={props.tokens !== null}>
                    <span>{fill(t('${0} tokens'), count(props.tokens ?? 0))}</span>
                </Show>
            </div>
            <div class="wb-place-body">
                <p>
                    {t('Comes in ')}
                    <button
                        type="button"
                        class="wb-tok"
                        aria-expanded={list() === 'comes'}
                        onClick={() => toggle('comes')}
                    >
                        {t(COMES.find((item) => item.comes === comesOf(p()))?.words ?? '')}
                    </button>
                    {', '}
                    <Token
                        shown={chance() >= 100 ? t('every time') : fill(t('${0}% of the time'), String(chance()))}
                        value={String(chance())}
                        label={t('How often, in percent')}
                        onSet={(typed) => {
                            const n = Number(typed);
                            if (!Number.isFinite(n) || n < 0 || n > 100) return;
                            props.onSet({ probability: n, useProbability: n < 100 });
                        }}
                    />
                    .
                    <Show when={list() === 'comes'}>
                        <Choices
                            label={t('When it comes in')}
                            items={COMES.map((item) => ({ value: item.comes, words: item.words }))}
                            chosen={comesOf(p())}
                            onPick={(comes) => {
                                setList(null);
                                props.onSet(COMES.find((item) => item.comes === comes)?.change ?? {});
                            }}
                        />
                    </Show>
                </p>
                <p>
                    {t('Goes ')}
                    <button
                        type="button"
                        class="wb-tok"
                        aria-expanded={list() === 'where'}
                        onClick={() => toggle('where')}
                    >
                        {whereWords()}
                    </button>
                    <Show when={p().position === IN_CHAT}>
                        {', '}
                        <Token
                            shown={String(p().depth)}
                            value={String(p().depth)}
                            label={t('How many messages up')}
                            onSet={(typed) => {
                                const n = Number(typed);
                                if (Number.isInteger(n) && n >= 0) props.onSet({ depth: n });
                            }}
                        />
                        {t(' messages up')}
                    </Show>
                    .
                    <Show when={list() === 'where'}>
                        <Choices
                            label={t('Where it goes')}
                            items={wheres().map((where) => ({ value: where.position, words: where.words }))}
                            chosen={p().position}
                            onPick={(position) => {
                                setList(null);
                                props.onSet({ position });
                            }}
                        />
                    </Show>
                </p>
                <p>
                    {t('Order among entries in the same place: ')}
                    <Token
                        shown={String(p().order)}
                        value={String(p().order)}
                        label={t('Order among entries in the same place')}
                        onSet={(typed) => {
                            const n = Number(typed);
                            if (Number.isFinite(n)) props.onSet({ order: n });
                        }}
                    />
                </p>
                <For each={shownExtras()}>
                    {(extra) => (
                        <p>
                            {t(extra.before)}
                            <Token
                                shown={extraValue(p(), extra.extra) ?? ''}
                                value={extraValue(p(), extra.extra) ?? ''}
                                label={t(extra.offer)}
                                wide={extra.extra === 'keysecondary' || extra.extra === 'group'}
                                editing={adding() === extra.extra}
                                onSet={(typed) => {
                                    setAdding(null);
                                    const change = extraChange(extra.extra, typed);
                                    if (change) props.onSet(change);
                                }}
                                onCancel={() => setAdding(null)}
                            />
                            {t(extra.after)}
                        </p>
                    )}
                </For>
                <Show when={filterShown()}>
                    <CharacterFilterSentence
                        filter={props.characterFilter}
                        adding={filtering()}
                        onAdding={setFiltering}
                        onChange={props.onFilter}
                    />
                </Show>
                <Show when={offered().length > 0 || !filterShown()}>
                    <button
                        type="button"
                        class="menu_button margin0 whitespacenowrap wb-place-more"
                        aria-expanded={list() === 'more'}
                        onClick={() => toggle('more')}
                    >
                        {t('+ More')}
                    </button>
                    <Show when={list() === 'more'}>
                        <span class="list-group wb-choices wb-choices-static">
                            <For each={offered()}>
                                {(extra) => (
                                    <button
                                        type="button"
                                        class="list-group-item wb-choice"
                                        onClick={() => {
                                            setList(null);
                                            setAdding(extra.extra);
                                        }}
                                    >
                                        {t(extra.offer)}
                                    </button>
                                )}
                            </For>
                            <Show when={!filterShown()}>
                                <button
                                    type="button"
                                    class="list-group-item wb-choice"
                                    onClick={() => {
                                        setList(null);
                                        setFiltering(true);
                                    }}
                                >
                                    {t(CHARACTERS_OFFER)}
                                </button>
                            </Show>
                        </span>
                    </Show>
                </Show>
            </div>
        </div>
    );
}
