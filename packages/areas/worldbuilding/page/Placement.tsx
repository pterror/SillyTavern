import { For, Match, Show, Switch, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import { useUi } from '@st/page/context';
import { TRIGGERS } from '../protocol.ts';
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

export type Comes = 'brought up' | 'always' | 'found' | 'never';

export const comesOf = (placement: Pick<Placement, 'constant' | 'disable' | 'vectorized'>): Comes =>
    placement.disable ? 'never' : placement.constant ? 'always' : placement.vectorized ? 'found' : 'brought up';

const COMES: { comes: Comes; words: string; change: Partial<Placement> }[] = [
    {
        comes: 'brought up',
        words: 'when it’s brought up',
        change: { constant: false, vectorized: false, disable: false },
    },
    { comes: 'always', words: 'always', change: { constant: true, vectorized: false, disable: false } },
    {
        comes: 'found',
        words: 'when a vector search finds it',
        change: { constant: false, vectorized: true, disable: false },
    },
    { comes: 'never', words: 'never', change: { disable: true } },
];

const ROLES: { value: Placement['role']; words: string }[] = [
    { value: 0, words: 'the system' },
    { value: 1, words: 'the user' },
    { value: 2, words: 'the assistant' },
];

// Upstream's `selectiveLogic`: 0 AND ANY, 1 NOT ALL, 2 NOT ANY, 3 AND ALL.
export const LOGICS: { value: Placement['selectiveLogic']; words: string }[] = [
    { value: 0, words: 'any of' },
    { value: 3, words: 'all of' },
    { value: 2, words: 'none of' },
    { value: 1, words: 'not all of' },
];

const TRIGGER_WORDS: Record<Placement['triggers'][number], string> = {
    normal: 'new replies',
    continue: 'continuing',
    impersonate: 'impersonating',
    swipe: 'swipes',
    regenerate: 'regenerating',
    quiet: 'quiet prompts',
};

const SOURCES = [
    { field: 'matchPersonaDescription', words: 'the persona’s description' },
    { field: 'matchCharacterDescription', words: 'the character’s description' },
    { field: 'matchCharacterPersonality', words: 'the character’s personality' },
    { field: 'matchCharacterDepthPrompt', words: 'the character’s note' },
    { field: 'matchScenario', words: 'the scenario' },
    { field: 'matchCreatorNotes', words: 'the creator’s notes' },
] as const;

type Source = (typeof SOURCES)[number]['field'];

export const chanceOf = (placement: Pick<Placement, 'probability' | 'useProbability'>): number =>
    placement.useProbability ? placement.probability : 100;

type NumberField = 'sticky' | 'cooldown' | 'delay' | 'scanDepth' | 'groupWeight';
type TextField = 'keysecondary' | 'group' | 'automationId';
type FlagField = 'excludeRecursion' | 'preventRecursion' | 'ignoreBudget' | 'groupOverride';
type ChoiceField = 'caseSensitive' | 'matchWholeWords' | 'useGroupScoring';

// A sentence of the popover past its first three: shown while its field differs from upstream's default, offered under
// "+ More" otherwise.
type Extra =
    | { kind: 'number'; field: NumberField; offer: string; before: string; after: string }
    | { kind: 'text'; field: TextField; offer: string; before: string; after: string }
    | { kind: 'flag'; field: FlagField; offer: string; words: string }
    | {
          kind: 'choice';
          field: ChoiceField;
          offer: string;
          before: string;
          after: string;
          options: { value: boolean; words: string }[];
      }
    | { kind: 'recursionLevel'; field: 'delayUntilRecursion'; offer: string }
    | { kind: 'triggers'; field: 'triggers'; offer: string }
    | { kind: 'sources'; field: 'sources'; offer: string };

type ExtraField = Extra['field'];

const EXTRAS: Extra[] = [
    {
        kind: 'number',
        field: 'sticky',
        offer: 'Stays for some replies after coming up',
        before: 'Stays for ',
        after: ' replies after coming up.',
    },
    {
        kind: 'number',
        field: 'cooldown',
        offer: 'Waits some replies before coming up again',
        before: 'Waits ',
        after: ' replies before coming up again.',
    },
    {
        kind: 'number',
        field: 'delay',
        offer: 'Only after the chat has some messages',
        before: 'Only after the chat has ',
        after: ' messages.',
    },
    {
        kind: 'text',
        field: 'keysecondary',
        offer: 'Needs other words written too',
        before: ' these words written too: ',
        after: '.',
    },
    {
        kind: 'text',
        field: 'group',
        offer: 'Only one of a group comes in',
        before: 'Only one of the group ',
        after: ' comes in.',
    },
    {
        kind: 'number',
        field: 'groupWeight',
        offer: 'Is more or less likely to be its group’s pick',
        before: 'Counts ',
        after: ' times when its group is picked by chance.',
    },
    {
        kind: 'flag',
        field: 'groupOverride',
        offer: 'Wins its group by order',
        words: 'Wins its group when its order is highest.',
    },
    {
        kind: 'choice',
        field: 'useGroupScoring',
        offer: 'Its group picks by matching keys or by chance',
        before: 'Its group picks ',
        after: '.',
        options: [
            { value: true, words: 'the entry matching the most keys' },
            { value: false, words: 'by chance' },
        ],
    },
    {
        kind: 'number',
        field: 'scanDepth',
        offer: 'Looks further back in the chat for its keys',
        before: 'Looks ',
        after: ' messages back in the chat for its keys.',
    },
    {
        kind: 'choice',
        field: 'caseSensitive',
        offer: 'Matches its keys’ case or not',
        before: 'Its keys match ',
        after: '.',
        options: [
            { value: true, words: 'only the same case' },
            { value: false, words: 'any case' },
        ],
    },
    {
        kind: 'choice',
        field: 'matchWholeWords',
        offer: 'Matches whole words or inside words',
        before: 'Its keys match ',
        after: '.',
        options: [
            { value: true, words: 'only whole words' },
            { value: false, words: 'inside words too' },
        ],
    },
    { kind: 'sources', field: 'sources', offer: 'Looks for its keys outside the chat too' },
    { kind: 'triggers', field: 'triggers', offer: 'Comes in only for some kinds of reply' },
    {
        kind: 'flag',
        field: 'excludeRecursion',
        offer: 'Isn’t brought up by other entries’ text',
        words: 'Other entries’ text doesn’t bring it up.',
    },
    {
        kind: 'flag',
        field: 'preventRecursion',
        offer: 'Its text doesn’t bring up other entries',
        words: 'Its text doesn’t bring up other entries.',
    },
    {
        kind: 'recursionLevel',
        field: 'delayUntilRecursion',
        offer: 'Comes in only when other entries’ text brings it up',
    },
    {
        kind: 'flag',
        field: 'ignoreBudget',
        offer: 'Comes in even when the budget is full',
        words: 'Comes in even when the budget is full.',
    },
    {
        kind: 'text',
        field: 'automationId',
        offer: 'Runs an automation when it comes in',
        before: 'Runs the automation ',
        after: ' when it comes in.',
    },
];

const sourcesOf = (placement: Placement): Source[] =>
    SOURCES.filter((source) => placement[source.field]).map((source) => source.field);

// The extra's value as its sentence shows it, or null when it is at upstream's default and so isn't shown.
const extraValue = (placement: Placement, extra: Extra): string | null => {
    switch (extra.kind) {
        case 'number': {
            const value = placement[extra.field];
            if (extra.field === 'groupWeight') return value === 100 ? null : String(value);
            return value === null || (extra.field !== 'scanDepth' && value === 0) ? null : String(value);
        }
        case 'text':
            if (extra.field === 'keysecondary')
                return placement.keysecondary.length === 0 ? null : placement.keysecondary.join(', ');
            return placement[extra.field].trim() === '' ? null : placement[extra.field];
        case 'flag':
            return placement[extra.field] ? '' : null;
        case 'choice': {
            const value = placement[extra.field];
            return value === null ? null : (extra.options.find((option) => option.value === value)?.words ?? null);
        }
        case 'recursionLevel': {
            const value = placement.delayUntilRecursion;
            return value === false || value === 0 ? null : value === true ? '' : String(value);
        }
        case 'triggers':
            return placement.triggers.length === 0 ? null : placement.triggers.join(',');
        case 'sources':
            return sourcesOf(placement).length === 0 ? null : sourcesOf(placement).join(',');
    }
};

// What setting the extra to upstream's default writes: the sentence's ×.
const extraCleared = (extra: Extra): Partial<Omit<Placement, 'characterFilter'>> => {
    switch (extra.kind) {
        case 'number':
            return extra.field === 'groupWeight' ? { groupWeight: 100 } : { [extra.field]: null };
        case 'text':
            return extra.field === 'keysecondary' ? { keysecondary: [] } : { [extra.field]: '' };
        case 'flag':
            return { [extra.field]: false };
        case 'choice':
            return { [extra.field]: null };
        case 'recursionLevel':
            return { delayUntilRecursion: false };
        case 'triggers':
            return { triggers: [] };
        case 'sources':
            return Object.fromEntries(SOURCES.map((source) => [source.field, false]));
    }
};

// The change that sets a typed extra from what was typed; an empty answer takes it away.
const typedChange = (extra: Extract<Extra, { kind: 'number' | 'text' }>, typed: string): Partial<Placement> | null => {
    const text = typed.trim();
    if (extra.field === 'keysecondary')
        return {
            keysecondary:
                text === ''
                    ? []
                    : text
                          .split(',')
                          .map((word) => word.trim())
                          .filter((word) => word !== ''),
            selective: true,
        };
    if (extra.kind === 'text') return { [extra.field]: text };
    if (text === '') return extraCleared(extra);
    const n = Number(text);
    const least = extra.field === 'groupWeight' ? 1 : 0;
    if (!Number.isInteger(n) || n < least) return null;
    return { [extra.field]: n };
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

type Change = Partial<Omit<Placement, 'characterFilter'>>;

function Remove(props: { label: string; onRemove: () => void }) {
    return (
        <button type="button" class="wb-filter-remove" aria-label={props.label} onClick={() => props.onRemove()}>
            ×
        </button>
    );
}

// Picks any number of `items`; each click is one change.
function Several<T>(props: {
    label: string;
    items: { value: T; words: string }[];
    chosen: T[];
    onToggle: (value: T, on: boolean) => void;
}) {
    const { t } = useUi();
    return (
        <span
            class="list-group st-floating wb-choices"
            role="listbox"
            aria-multiselectable="true"
            aria-label={props.label}
        >
            <For each={props.items}>
                {(item) => (
                    <button
                        type="button"
                        role="option"
                        class="list-group-item wb-choice"
                        classList={{ 'wb-on': props.chosen.includes(item.value) }}
                        aria-selected={props.chosen.includes(item.value)}
                        onClick={() => props.onToggle(item.value, !props.chosen.includes(item.value))}
                    >
                        {t(item.words)}
                    </button>
                )}
            </For>
        </span>
    );
}

function ExtraSentence(props: {
    extra: Extra;
    placement: Placement;
    adding: boolean;
    onSet: (change: Change) => void;
    onAdded: () => void;
}) {
    const { t } = useUi();
    const [open, setOpen] = createSignal(props.adding);
    const p = () => props.placement;
    const remove = () => {
        props.onAdded();
        props.onSet(extraCleared(props.extra));
    };
    const level = () => (typeof p().delayUntilRecursion === 'number' ? String(p().delayUntilRecursion) : '');
    const RemoveIt = () => <Remove label={fill(t('Take away: ${0}'), t(props.extra.offer))} onRemove={remove} />;
    const kinded = <K extends Extra['kind']>(kind: K) =>
        props.extra.kind === kind ? (props.extra as Extract<Extra, { kind: K }>) : false;
    const typed = () =>
        props.extra.kind === 'number' || props.extra.kind === 'text'
            ? (props.extra as Extract<Extra, { kind: 'number' | 'text' }>)
            : false;
    return (
        <Switch>
            <Match when={typed()}>
                {(extra) => (
                    <p>
                        <Show when={extra().field === 'keysecondary'}>
                            {t('Also needs ')}
                            <LogicToken placement={p()} onSet={props.onSet} />
                        </Show>
                        {t(extra().before)}
                        <Token
                            shown={extraValue(p(), extra()) ?? ''}
                            value={extraValue(p(), extra()) ?? ''}
                            label={t(extra().offer)}
                            wide={extra().kind === 'text'}
                            editing={props.adding}
                            onSet={(typedWords) => {
                                props.onAdded();
                                const change = typedChange(extra(), typedWords);
                                if (change) props.onSet(change);
                            }}
                            onCancel={() => props.onAdded()}
                        />
                        {t(extra().after)}
                    </p>
                )}
            </Match>
            <Match when={kinded('flag')}>
                {(extra) => (
                    <p>
                        {t(extra().words)}
                        <RemoveIt />
                    </p>
                )}
            </Match>
            <Match when={kinded('choice')}>
                {(extra) => (
                    <p>
                        {t(extra().before)}
                        <button type="button" class="wb-tok" aria-expanded={open()} onClick={() => setOpen(!open())}>
                            {t(extraValue(p(), extra()) ?? extra().options[0]?.words ?? '')}
                        </button>
                        {t(extra().after)}
                        <RemoveIt />
                        <Show when={open()}>
                            <Choices
                                label={t(extra().offer)}
                                items={extra().options}
                                chosen={p()[extra().field] ?? undefined}
                                onPick={(value) => {
                                    setOpen(false);
                                    props.onAdded();
                                    props.onSet({ [extra().field]: value });
                                }}
                            />
                        </Show>
                    </p>
                )}
            </Match>
            <Match when={kinded('recursionLevel')}>
                <p>
                    {t('Comes in only when other entries’ text brings it up, from step ')}
                    <Token
                        shown={level() === '' ? t('any') : level()}
                        value={level()}
                        label={t('From which step of bringing up')}
                        onSet={(typedWords) => {
                            const text = typedWords.trim();
                            const n = Number(text);
                            if (text === '') props.onSet({ delayUntilRecursion: true });
                            else if (Number.isInteger(n) && n >= 1) props.onSet({ delayUntilRecursion: n });
                        }}
                    />
                    .
                    <RemoveIt />
                </p>
            </Match>
            <Match when={kinded('triggers')}>
                {(extra) => (
                    <p>
                        {t('Comes in only for ')}
                        <button type="button" class="wb-tok" aria-expanded={open()} onClick={() => setOpen(!open())}>
                            {p().triggers.length === 0
                                ? t('…')
                                : p()
                                      .triggers.map((one) => t(TRIGGER_WORDS[one]))
                                      .join(', ')}
                        </button>
                        .
                        <RemoveIt />
                        <Show when={open()}>
                            <Several
                                label={t(extra().offer)}
                                items={TRIGGERS.map((one) => ({ value: one, words: TRIGGER_WORDS[one] }))}
                                chosen={p().triggers}
                                onToggle={(one, on) => {
                                    props.onAdded();
                                    props.onSet({
                                        triggers: on
                                            ? [...p().triggers, one]
                                            : p().triggers.filter((have) => have !== one),
                                    });
                                }}
                            />
                        </Show>
                    </p>
                )}
            </Match>
            <Match when={kinded('sources')}>
                {(extra) => (
                    <p>
                        {t('Also looks for its keys in ')}
                        <button type="button" class="wb-tok" aria-expanded={open()} onClick={() => setOpen(!open())}>
                            {sourcesOf(p()).length === 0
                                ? t('…')
                                : SOURCES.filter((source) => p()[source.field])
                                      .map((source) => t(source.words))
                                      .join(', ')}
                        </button>
                        .
                        <RemoveIt />
                        <Show when={open()}>
                            <Several
                                label={t(extra().offer)}
                                items={SOURCES.map((source) => ({ value: source.field, words: source.words }))}
                                chosen={sourcesOf(p())}
                                onToggle={(field, on) => {
                                    props.onAdded();
                                    props.onSet({ [field]: on });
                                }}
                            />
                        </Show>
                    </p>
                )}
            </Match>
        </Switch>
    );
}

function LogicToken(props: { placement: Placement; onSet: (change: Change) => void }) {
    const { t } = useUi();
    const [open, setOpen] = createSignal(false);
    return (
        <>
            <button type="button" class="wb-tok" aria-expanded={open()} onClick={() => setOpen(!open())}>
                {t(LOGICS.find((logic) => logic.value === props.placement.selectiveLogic)?.words ?? '')}
            </button>
            <Show when={open()}>
                <Choices
                    label={t('How many of these words')}
                    items={LOGICS}
                    chosen={props.placement.selectiveLogic}
                    onPick={(value) => {
                        setOpen(false);
                        props.onSet({ selectiveLogic: value });
                    }}
                />
            </Show>
        </>
    );
}

export function PlacementPopover(props: {
    placement: Placement;
    characterFilter: CharacterFilterShown;
    tokens: number | null;
    opener: () => HTMLElement | undefined;
    onSet: (fields: Change) => void;
    onFilter: (change: FilterChange) => void;
    onClose: () => void;
}) {
    const { t } = useUi();
    const [list, setList] = createSignal<'comes' | 'where' | 'role' | 'more' | null>(null);
    const [adding, setAdding] = createSignal<ExtraField | null>(null);
    const [filtering, setFiltering] = createSignal(false);
    const filterShown = () => filterIsSet(props.characterFilter) || filtering();
    let box: HTMLDivElement | undefined;
    dismissOn(() => box, props.onClose, props.opener);
    const p = () => props.placement;
    const chance = () => chanceOf(p());
    const wheres = () => [...WHERES, { position: OUTLET, words: 'into an outlet' }];
    const whereWords = () => t(wheres().find((where) => where.position === p().position)?.words ?? '');
    const toggle = (which: 'comes' | 'where' | 'role' | 'more') => setList(list() === which ? null : which);
    const shownExtras = () => EXTRAS.filter((extra) => extraValue(p(), extra) !== null || adding() === extra.field);
    const offered = () => EXTRAS.filter((extra) => extraValue(p(), extra) === null && adding() !== extra.field);
    const add = (extra: Extra) => {
        setList(null);
        if (extra.kind === 'flag') props.onSet({ [extra.field]: true });
        else if (extra.kind === 'recursionLevel') props.onSet({ delayUntilRecursion: true });
        else setAdding(extra.field);
    };
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
                    <Show when={p().position === OUTLET}>
                        {' '}
                        <Token
                            shown={p().outletName.trim() === '' ? t('(no name)') : `“${p().outletName}”`}
                            value={p().outletName}
                            label={t('The outlet’s name')}
                            wide
                            onSet={(typed) => props.onSet({ outletName: typed.trim() })}
                        />
                    </Show>
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
                        {t(' messages up, as ')}
                        <button
                            type="button"
                            class="wb-tok"
                            aria-expanded={list() === 'role'}
                            onClick={() => toggle('role')}
                        >
                            {t(ROLES.find((role) => role.value === p().role)?.words ?? '')}
                        </button>
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
                    <Show when={list() === 'role'}>
                        <Choices
                            label={t('Whose message it is')}
                            items={ROLES}
                            chosen={p().role}
                            onPick={(role) => {
                                setList(null);
                                props.onSet({ role });
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
                        <ExtraSentence
                            extra={extra}
                            placement={p()}
                            adding={adding() === extra.field}
                            onSet={props.onSet}
                            onAdded={() => setAdding(null)}
                        />
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
                                    <button type="button" class="list-group-item wb-choice" onClick={() => add(extra)}>
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
