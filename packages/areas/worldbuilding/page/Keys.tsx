import { Show } from 'solid-js';
import { useUi } from '@st/page/context';
import type { EntryFacts, OpenEntryView } from '../protocol.ts';
import { useWb } from './context.ts';
import { KeyChips } from './KeyChips.tsx';
import { LOGICS, LogicToken } from './Placement.tsx';
import { count, fill } from './words.ts';

// The words that are the entry's name: what it is called, linked and drawn in its look where they are written.
export function Names(props: { entry: OpenEntryView }) {
    const { t } = useUi();
    return (
        <div class="wb-keys wb-names">
            <span class="wb-keys-label">{t('Also called')}</span>
            <KeyChips
                book={props.entry.book}
                entry={props.entry.entry}
                version={props.entry.version}
                kind="name"
                chips={props.entry.keys.filter((key) => key.isName)}
                sharers
            />
        </div>
    );
}

// What brings the entry up besides its names: its keys, then its secondary keys with their logic; or that it is constant.
export function Triggers(props: { entry: OpenEntryView }) {
    const { t } = useUi();
    const wb = useWb();
    const at = () => ({ book: props.entry.book, entry: props.entry.entry, version: props.entry.version });
    const placement = () => props.entry.placement;
    const constant = () => placement().constant && !placement().disable;
    return (
        <div class="wb-keys wb-triggers">
            <span class="wb-keys-label">{t('Triggers')}</span>
            <Show
                when={!constant()}
                fallback={
                    <>
                        <span class="wb-always">
                            {props.entry.tokens === null
                                ? t('Constant')
                                : fill(t('Constant · ${0} tokens'), count(props.entry.tokens))}
                        </span>
                        <button
                            type="button"
                            class="menu_button margin0 whitespacenowrap wb-key-add"
                            onClick={() =>
                                void wb.edit('worldbuilding.setPlacement', { ...at(), fields: { constant: false } })
                            }
                        >
                            {t('Make normal')}
                        </button>
                    </>
                }
            >
                <KeyChips
                    book={props.entry.book}
                    entry={props.entry.entry}
                    version={props.entry.version}
                    kind="trigger"
                    chips={props.entry.keys.filter((key) => !key.isName)}
                    sharers
                />
                <Show when={placement().keysecondary.length > 0}>
                    <LogicToken
                        placement={placement()}
                        onSet={(fields) => void wb.edit('worldbuilding.setPlacement', { ...at(), fields })}
                    />
                </Show>
                <KeyChips
                    book={props.entry.book}
                    entry={props.entry.entry}
                    version={props.entry.version}
                    kind="secondary"
                    chips={placement().keysecondary.map((text) => ({ text }))}
                    addWords={placement().keysecondary.length === 0 ? t('+ Secondary') : undefined}
                />
            </Show>
        </div>
    );
}

// The keys of an entry that bring it up, as a card or a row draws them: its trigger keys, then its secondary keys with
// their logic; a constant entry's card says that instead. The names are not among them.
export function TriggerLine(props: {
    book: string;
    entry: string;
    keys: string[];
    names: string[];
    facts: EntryFacts | undefined;
    constantInstead?: boolean;
}) {
    const { t } = useUi();
    const secondary = () => props.facts?.keysecondary ?? [];
    const triggers = () => props.keys.filter((key) => !props.names.includes(key));
    return (
        <Show
            when={!(props.constantInstead === true && props.facts?.comesIn === 'always')}
            fallback={<span class="wb-card-triggers-text">{t('Constant')}</span>}
        >
            <Show when={triggers().length === 0 && secondary().length === 0}>
                <span class="wb-dim">{t('No keys')}</span>
            </Show>
            <KeyChips
                book={props.book}
                entry={props.entry}
                version={props.facts?.version ?? null}
                kind="trigger"
                chips={triggers().map((text) => ({ text }))}
                compact
            />
            <Show when={secondary().length > 0}>
                <span class="wb-trigger-logic">
                    + {t(LOGICS.find((one) => one.value === props.facts?.selectiveLogic)?.words ?? '').toLowerCase()}
                </span>
                <KeyChips
                    book={props.book}
                    entry={props.entry}
                    version={props.facts?.version ?? null}
                    kind="secondary"
                    chips={secondary().map((text) => ({ text }))}
                    compact
                    canAdd={false}
                />
            </Show>
        </Show>
    );
}
