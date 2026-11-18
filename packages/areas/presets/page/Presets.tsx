import { For, Show, createSignal } from 'solid-js';
import { useUi } from '@st/page/context';
import { ask } from '@st/page/dialog';
import { Select } from '@st/page/select';
import { VIEW } from '../protocol.ts';
import type { Family, PresetsView } from '../protocol.ts';

import type { PresetsCompat } from './compat.ts';

const TITLES: Record<Family, string> = {
    kobold: 'KoboldAI Presets',
    novel: 'NovelAI Presets',
    openai: 'Chat Completion presets',
    textgenerationwebui: 'Text Completion presets',
};
const SENSITIVE = [
    'reverse_proxy',
    'proxy_password',
    'custom_url',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'vertexai_region',
    'vertexai_express_project_id',
    'azure_base_url',
    'azure_deployment_name',
    'workers_ai_account_id',
];

export function Presets(props: { family: Family; old: PresetsCompat; id: string }) {
    const { client, t } = useUi();
    const view = client.view<PresetsView>(VIEW);
    const catalog = () => view()?.[props.family];
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal('');
    const [ordering, setOrdering] = createSignal<string[] | null>(null);
    const selected = () => catalog()?.selected ?? '';
    const editable = () => catalog()?.presets.some((preset) => preset.name === selected()) === true;
    let fileInput: HTMLInputElement | undefined;

    const run = async (operation: () => Promise<void>) => {
        if (busy()) return;
        setBusy(true);
        setError('');
        try {
            await props.old.settled();
            await operation();
            await props.old.settled();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setBusy(false);
        }
    };
    const send = async (type: string, payload: Record<string, unknown>) => {
        const result = await client.send(type, { family: props.family, ...payload });
        if (!result.ok) throw new Error(result.error);
    };
    const save = async (as: boolean) => {
        const name = as ? await ask({ kind: 'input', message: t('Preset name:'), value: selected() }, t) : selected();
        if (name === null || name === '') return;
        if (
            as &&
            catalog()?.presets.some((preset) => preset.name === name) === true &&
            !(await ask({ kind: 'confirm', message: t('Preset name already exists. Overwrite?') }, t))
        )
            return;
        await send('presets.save', { name });
    };
    const rename = async () => {
        const name = selected();
        const to = await ask({ kind: 'input', message: t('Rename preset'), value: name }, t);
        if (to !== null && to !== '' && to !== name) await send('presets.rename', { name, to });
    };
    const remove = async () => {
        const name = selected();
        if (await ask({ kind: 'confirm', message: t('Delete this preset?'), detail: name }, t))
            await send('presets.delete', { name });
    };
    const restore = async () => {
        const name = selected();
        if (
            await ask(
                {
                    kind: 'confirm',
                    message: t('Restore current preset'),
                    detail: t(
                        'Shipped presets return to their defaults. Custom presets return to their last saved state.',
                    ),
                },
                t,
            )
        ) {
            await send('presets.restore', { name });
            await props.old.reload(props.family);
        }
    };
    const sensitive = async (data: Record<string, unknown>) => {
        const fields = SENSITIVE.filter((key) => Boolean(data[key]));
        if (fields.length === 0) return data;
        const answer = await ask(
            {
                kind: 'pick',
                message: t('This preset contains proxy or custom endpoint settings.'),
                detail: fields.join(', '),
                options: [
                    { id: 'remove', label: t('Remove them') },
                    { id: 'keep', label: t('Keep them') },
                ],
            },
            t,
        );
        if (answer === null) return null;
        return answer === 'remove'
            ? Object.fromEntries(Object.entries(data).filter(([key]) => !SENSITIVE.includes(key)))
            : data;
    };
    const importFile = async (file: File) => {
        const parsed: unknown = JSON.parse(await file.text());
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('Invalid file'));
        let data = props.old.prepareImport(props.family, parsed as Record<string, unknown>);
        if (props.family === 'openai') {
            const safe = await sensitive(data);
            if (!safe) return;
            data = safe;
        }
        const name =
            props.family !== 'openai' && typeof data['name'] === 'string'
                ? data['name']
                : file.name.replace(/\.[^/.]+$/, '');
        const overwrite = catalog()?.presets.some((preset) => preset.name === name) === true;
        if (overwrite && !(await ask({ kind: 'confirm', message: t('Preset name already exists. Overwrite?') }, t)))
            return;
        await send('presets.import', { name, data, overwrite });
    };
    const exportFile = async () => {
        const name = selected();
        const preset = catalog()?.presets.find((preset) => preset.name === name);
        if (!preset) return;
        let data = preset.data;
        if (props.family === 'openai') {
            const safe = await sensitive(data);
            if (!safe) return;
            data = safe;
        }
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 4)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${name}.json`;
        link.click();
        URL.revokeObjectURL(url);
    };
    const move = (index: number, direction: number) => {
        const names = [...(ordering() ?? [])];
        const target = index + direction;
        if (target < 0 || target >= names.length) return;
        [names[index], names[target]] = [names[target]!, names[index]!];
        setOrdering(names);
    };
    const button = (label: string, icon: string, operation: () => Promise<void>, needsPreset = false) => (
        <button
            type="button"
            class="menu_button menu_button_icon"
            title={t(label)}
            aria-label={t(label)}
            disabled={busy() || !catalog() || (needsPreset && !editable())}
            onClick={() => void run(operation)}
        >
            <i class={`fa-fw fa-solid ${icon}`} aria-hidden="true" />
        </button>
    );
    return (
        <section class="st-presets" aria-label={t(TITLES[props.family])} aria-busy={busy() ? 'true' : 'false'}>
            <div class="margin0 title_restorable standoutHeader">
                <strong>{t(TITLES[props.family])}</strong>
                <div class="flex-container gap3px">
                    {button('Import preset', 'fa-file-import', async () => {
                        fileInput?.click();
                    })}
                    {button('Export preset', 'fa-file-export', exportFile, true)}
                    {button('Delete the preset', 'fa-trash-can', remove, true)}
                </div>
            </div>
            <div class="st-preset-controls">
                <Select
                    id={props.id}
                    label={t(TITLES[props.family])}
                    value={selected()}
                    options={[
                        ...(props.family === 'kobold' ? [{ value: 'gui', label: t('GUI KoboldAI Settings') }] : []),
                        ...(catalog()?.presets ?? []).map((preset) => ({ value: preset.name, label: preset.name })),
                    ]}
                    disabled={busy() || !catalog()}
                    onChange={(name, refuse) => {
                        refuse();
                        void run(() => send('presets.select', { name }));
                    }}
                />
                <div class="flex-container gap3px">
                    {button('Update current preset', 'fa-save', () => save(false), true)}
                    {button('Rename current preset', 'fa-pencil', rename, true)}
                    {button('Save preset as', 'fa-file-circle-plus', () => save(true))}
                    {button('Restore current preset', 'fa-recycle', restore, true)}
                    {button('Reorder presets', 'fa-arrow-down-1-9', async () => {
                        setOrdering(catalog()?.presets.map((preset) => preset.name) ?? []);
                    })}
                </div>
            </div>
            <input
                ref={(element) => {
                    fileInput = element;
                }}
                type="file"
                hidden
                accept=".json,.settings,.preset"
                onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    if (file) void run(() => importFile(file));
                }}
            />
            <Show when={error() !== '' ? error() : props.old.error()}>
                {(message) => <p role="alert">{message()}</p>}
            </Show>
            <Show when={ordering() !== null}>
                <div class="st-preset-order" role="group" aria-label={t('Reorder presets')}>
                    <ol>
                        <For each={ordering() ?? []}>
                            {(name, index) => (
                                <li>
                                    <span>{name}</span>
                                    <button
                                        type="button"
                                        class="menu_button"
                                        aria-label={`${t('Move up')}: ${name}`}
                                        disabled={busy() || index() === 0}
                                        onClick={() => {
                                            move(index(), -1);
                                        }}
                                    >
                                        ↑
                                    </button>
                                    <button
                                        type="button"
                                        class="menu_button"
                                        aria-label={`${t('Move down')}: ${name}`}
                                        disabled={busy() || index() === (ordering()?.length ?? 0) - 1}
                                        onClick={() => {
                                            move(index(), 1);
                                        }}
                                    >
                                        ↓
                                    </button>
                                </li>
                            )}
                        </For>
                    </ol>
                    <button
                        type="button"
                        class="menu_button"
                        disabled={busy()}
                        onClick={() =>
                            void run(async () => {
                                await send('presets.order', { names: ordering() ?? [] });
                                setOrdering(null);
                            })
                        }
                    >
                        {t('Apply')}
                    </button>
                    <button type="button" class="menu_button" disabled={busy()} onClick={() => setOrdering(null)}>
                        {t('Cancel')}
                    </button>
                </div>
            </Show>
        </section>
    );
}
