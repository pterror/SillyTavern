import { For } from 'solid-js';
import { useUi } from '@st/page/context';
import { Checkbox, FieldBlock, NumberBox, Select } from './fields.tsx';
import type { FieldState } from './fields.tsx';

const SECTIONS: string[][] = [
    ['wi_scan_depth', 'wi_include_names', 'wi_case_sensitive', 'wi_match_whole_words', 'wi_use_group_scoring'],
    ['wi_budget', 'wi_budget_cap', 'wi_character_strategy', 'wi_overflow_alert'],
    ['wi_recursive', 'wi_max_recursion_steps', 'wi_min_activations', 'wi_min_activations_depth_max'],
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
                <label class="wi-settings-label" for={field.field.id} title={t(field.field.tip ?? '')}>
                    <span class="wi-settings-control">
                        <Control field={field} />
                    </span>
                    <span class="wi-settings-name">{t(field.field.label)}</span>
                </label>
            )}
        </FieldBlock>
    );
}

export function WorldInfoSettings() {
    return (
        <div class="wi-settings">
            <For each={SECTIONS}>
                {(ids) => (
                    <section class="wi-settings-section">
                        <For each={ids}>{(id) => <Row id={id} />}</For>
                    </section>
                )}
            </For>
        </div>
    );
}
