import { createEffect, createSignal, onCleanup } from 'solid-js';
import { Autocomplete } from '@st/page/autocomplete';
import { Name } from '@st/page/name';
import { useUi } from '@st/page/context';

export type TagSuggestion = { value: string; thing?: string };
export type InputConfig = { id: string; className: string; placeholder: string; maxLength?: number | undefined };
export type InputPorts = {
    search(this: void, term: string): Promise<TagSuggestion[]>;
    choose(this: void, name: string): Promise<void>;
};

export function TagInput(props: { config: InputConfig; old: InputPorts }) {
    const { t } = useUi();
    const [term, setTerm] = createSignal('');
    const [open, setOpen] = createSignal(false);
    const [rows, setRows] = createSignal<TagSuggestion[]>([]);
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal('');
    let request = 0;
    let alive = true;
    onCleanup(() => {
        alive = false;
        request++;
    });
    createEffect(
        () => ({ term: term(), open: open() }),
        (state) => {
            const current = ++request;
            if (!state.open) return;
            setRows([]);
            setLoading(true);
            setError('');
            void props.old
                .search(state.term)
                .then((answer) => {
                    if (current === request) setRows(answer);
                })
                .catch(() => {
                    if (current === request) setError(t('The tags could not be loaded.'));
                })
                .finally(() => {
                    if (current === request) setLoading(false);
                });
        },
    );
    const choose = async (value: string) => {
        setOpen(false);
        setTerm('');
        try {
            await props.old.choose(value);
        } catch {
            if (alive) setError(t('The tag could not be added.'));
        }
    };
    return (
        <Autocomplete
            id={props.config.id}
            label={t('Search / Create tags')}
            class={props.config.className}
            placeholder={t(props.config.placeholder)}
            maxLength={props.config.maxLength}
            value={term()}
            open={open()}
            options={rows().map((row) => ({ value: row.value, label: row.value }))}
            status={
                loading()
                    ? t('Loading tags...')
                    : error() !== ''
                      ? error()
                      : rows().length === 0
                        ? t('No tag has that name.')
                        : ''
            }
            onInput={(value) => {
                setTerm(value);
                setOpen(true);
            }}
            onOpen={setOpen}
            onChoose={(value) => {
                void choose(value);
            }}
            renderItem={(value) => {
                const row = rows().find((row) => row.value === value);
                return row?.thing === undefined ? (
                    value
                ) : (
                    <Name named={{ thing: row.thing, text: value, shownAs: 'name' }} />
                );
            }}
        />
    );
}
