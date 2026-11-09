import { For } from 'solid-js';
import { useUi } from '@st/page/context';
import { Checkbox, FieldBlock, NumberBox, Select } from './fields.tsx';
import type { FieldState } from './fields.tsx';

const SECTIONS: { title: string; ids: string[] }[] = [
    {
        title: 'Finding entries',
        ids: ['wi_scan_depth', 'wi_include_names', 'wi_case_sensitive', 'wi_match_whole_words', 'wi_use_group_scoring'],
    },
    {
        title: 'Room for entries',
        ids: ['wi_budget', 'wi_budget_cap', 'wi_character_strategy', 'wi_overflow_alert'],
    },
    {
        title: 'Bringing up more',
        ids: ['wi_recursive', 'wi_max_recursion_steps', 'wi_min_activations', 'wi_min_activations_depth_max'],
    },
];

function Control(props: { field: FieldState }) {
    const kind = props.field.field.kind;
    if (kind === 'checkbox') return <Checkbox field={props.field} />;
    if (kind === 'select') return <Select field={props.field} class="text_pole wi-settings-select" />;
    return <NumberBox field={props.field} class="text_pole wi-settings-number" />;
}

function Row(props: { id: string }) {
    const { t } = useUi();
    return (
        <FieldBlock id={props.id} class="wi-settings-row">
            {(field) => (
                <label class="wi-settings-label" for={field.field.id}>
                    <span class="wi-settings-control">
                        <Control field={field} />
                    </span>
                    <span class="wi-settings-words">
                        <span class="wi-settings-name">{t(field.field.label)}</span>
                        <small class="wi-settings-tip">{t(field.field.tip ?? '')}</small>
                    </span>
                </label>
            )}
        </FieldBlock>
    );
}

export function WorldInfoSettings() {
    const { t } = useUi();
    return (
        <div class="wi-settings">
            <For each={SECTIONS}>
                {(section) => (
                    <section class="wi-settings-section">
                        <h4 class="wi-settings-title">{t(section.title)}</h4>
                        <For each={section.ids}>{(id) => <Row id={id} />}</For>
                    </section>
                )}
            </For>
        </div>
    );
}
