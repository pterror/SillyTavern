import { For, Show } from 'solid-js';
import { LEVELS, VIEW } from '../protocol.ts';
import type { Level, SettingsView } from '../protocol.ts';
import { useUi } from '@st/page/context';

// The levels slider over the AI response configuration panel: which levels a tab shows and edits (its fields are in
// fields.tsx and the sections, e.g. cc.tsx).

/** The levels a tab shows and edits: two handles over the five levels, each labeled with how many fields it sets. */
export function LevelSlider() {
    const { client, t } = useUi();
    const view = client.view<SettingsView>(VIEW);
    const index = (level: Level) => LEVELS.indexOf(level);
    const from = () => index(view()?.range.from ?? 'default');
    const to = () => index(view()?.range.to ?? 'user');
    const move = (which: 'from' | 'to', position: number, input: HTMLInputElement) => {
        const shown = view();
        if (!shown) return;
        let next = { ...shown.range, [which]: LEVELS[position] ?? shown.range[which] };
        if (index(next.from) > index(next.to)) next = { from: next.to, to: next.from };
        void client.send('settings.range', next).then((result) => {
            if (!result.ok) input.value = String(which === 'from' ? from() : to());
        });
    };
    return (
        <div id="settings_level_range" class="settings_level_range">
            <div class="settings_level_track">
                <input
                    type="range"
                    id="settings_level_from"
                    min={0}
                    max={LEVELS.length - 1}
                    step={1}
                    value={from()}
                    onChange={(event) => move('from', Number(event.currentTarget.value), event.currentTarget)}
                />
                <input
                    type="range"
                    id="settings_level_to"
                    min={0}
                    max={LEVELS.length - 1}
                    step={1}
                    value={to()}
                    onChange={(event) => move('to', Number(event.currentTarget.value), event.currentTarget)}
                />
            </div>
            <div class="settings_level_labels">
                <For each={LEVELS}>
                    {(level, position) => (
                        <span
                            class="settings_level_label"
                            attr:data-level={level}
                            classList={{
                                settings_level_in_range: position() >= from() && position() <= to(),
                                settings_level_absent:
                                    (level === 'character' &&
                                        !(view()?.context && 'avatar' in (view()?.context ?? {}))) ||
                                    (level === 'group' && !(view()?.context && 'group' in (view()?.context ?? {}))),
                            }}
                        >
                            {t(level[0]!.toUpperCase() + level.slice(1))}
                            <Show when={level !== 'default' && (view()?.counts[level] ?? 0) > 0}>
                                <small class="settings_level_count">{view()?.counts[level]}</small>
                            </Show>
                        </span>
                    )}
                </For>
            </div>
        </div>
    );
}
