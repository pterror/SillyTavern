import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { useUi } from '@st/page/context';
import type { HoverCard } from '../protocol.ts';
import { Label, Picture } from './Label.tsx';
import { LOGICS, WHERES } from './Placement.tsx';

type Content = Pick<HoverCard, 'label' | 'picture' | 'title' | 'keys' | 'text' | 'placement'>;

// Shared entry presentation. The full entry supplies editable fields; previews use the read-only defaults.
export function EntryContent(props: { entry: Content; title?: JSX.Element; keys?: JSX.Element; body?: JSX.Element }) {
    const { t } = useUi();
    const names = () =>
        props.entry.keys
            .filter((key) => key.isName)
            .map((key) => key.text)
            .join(', ');
    const triggers = () =>
        props.entry.keys
            .filter((key) => !key.isName)
            .map((key) => key.text)
            .join(', ');
    return (
        <>
            <header class="wb-entry-head">
                <Show when={props.entry.picture}>{(url) => <Picture url={url()} class="wb-entry-pic" />}</Show>
                <div class="wb-entry-headwords">
                    <div class="wb-entry-title">
                        {props.title ?? (
                            <Show when={props.entry.label.shownAs !== 'opening'} fallback={t('Untitled entry')}>
                                <Label named={props.entry.label} />
                            </Show>
                        )}
                    </div>
                    <Show
                        when={
                            props.title === undefined &&
                            props.entry.title !== null &&
                            props.entry.title !== props.entry.label.text
                        }
                    >
                        <div class="wb-entry-caption">{props.entry.title}</div>
                    </Show>
                    {props.keys ?? (
                        <>
                            <Show when={names()}>
                                <div class="wb-keys">
                                    <span class="wb-keys-label">{t('Also called')}</span>
                                    <span>{names()}</span>
                                </div>
                            </Show>
                            <Show when={triggers()}>
                                <div class="wb-keys">
                                    <span class="wb-keys-label">{t('Triggers')}</span>
                                    <span>{triggers()}</span>
                                </div>
                            </Show>
                        </>
                    )}
                </div>
            </header>
            <Show when={props.entry.placement}>
                {(placement) => {
                    const rows = () => {
                        const p = placement();
                        const activation = p.disable
                            ? t('Disabled')
                            : p.constant
                              ? t('Constant')
                              : p.vectorized
                                ? t('Vectorized')
                                : t('Normal');
                        const where = WHERES.find((one) => one.position === p.position)?.words ?? 'Outlet';
                        return [
                            [t('Activation'), activation],
                            [
                                t('Placement'),
                                `${t(where)}${p.position === 4 ? ` ${p.depth}` : p.position === 7 ? `: ${p.outletName}` : ''}`,
                            ],
                            [t('Order'), String(p.order)],
                            ...(p.useProbability ? [[t('Probability'), `${p.probability}%`]] : []),
                            ...(p.keysecondary.length > 0
                                ? [
                                      [
                                          t('Secondary keys'),
                                          `${t(LOGICS.find((one) => one.value === p.selectiveLogic)?.words ?? '')}: ${p.keysecondary.join(', ')}`,
                                      ],
                                  ]
                                : []),
                            ...(p.group !== '' ? [[t('Group'), p.group]] : []),
                            ...(p.sticky !== null && p.sticky > 0 ? [[t('Sticky'), String(p.sticky)]] : []),
                            ...(p.cooldown !== null && p.cooldown > 0 ? [[t('Cooldown'), String(p.cooldown)]] : []),
                            ...(p.delay !== null && p.delay > 0 ? [[t('Delay'), String(p.delay)]] : []),
                            ...(p.characterFilter.names.length > 0
                                ? [
                                      [
                                          t('Characters'),
                                          `${p.characterFilter.isExclude ? t('Exclude') : t('Include')}: ${p.characterFilter.names.join(', ')}`,
                                      ],
                                  ]
                                : []),
                            ...(p.characterFilter.tags.length > 0
                                ? [[t('Tags'), p.characterFilter.tags.join(', ')]]
                                : []),
                        ];
                    };
                    return (
                        <dl class="wb-entry-summary">
                            <For each={rows()}>
                                {(row) => (
                                    <div>
                                        <dt>{row[0]}</dt>
                                        <dd>{row[1]}</dd>
                                    </div>
                                )}
                            </For>
                        </dl>
                    );
                }}
            </Show>
            {props.body ?? <div class="wb-text wb-entry-readonly">{props.entry.text}</div>}
        </>
    );
}
