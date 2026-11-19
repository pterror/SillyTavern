import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { useUi } from '@st/page/context';
import { Select } from '@st/page/select';
import { Name } from '@st/page/name';
import { elementSetup } from '@st/page/element';

export type MergeTag = { id: string; name: string; thing?: string };
export type DeletePorts = {
    search(
        this: void,
        term: string,
        cursor: string | null,
    ): Promise<{ rows: MergeTag[]; cursor: string | null } | null>;
    choose(this: void, tag: MergeTag | null): void;
};

export function DeleteTag(props: { tag: MergeTag; old: DeletePorts }) {
    const { t, focusActions } = useUi();
    const [term, setTerm] = createSignal('');
    const [rows, setRows] = createSignal<MergeTag[]>([]);
    const [cursor, setCursor] = createSignal<string | null>(null);
    const [chosen, setChosen] = createSignal<MergeTag | null>(null);
    const [loading, setLoading] = createSignal(false);
    const [failed, setFailed] = createSignal(false);
    const [failedMore, setFailedMore] = createSignal(false);
    let request = 0;
    let host: HTMLDivElement | undefined;
    onCleanup(() => {
        request++;
    });
    const load = async (more: boolean) => {
        const current = ++request;
        setLoading(true);
        setFailed(false);
        setFailedMore(more);
        if (!more) {
            setRows([]);
            setCursor(null);
        }
        try {
            const answer = await props.old.search(term().trim(), more ? cursor() : null);
            if (current !== request) return;
            if (answer === null) {
                setFailed(true);
                return;
            }
            const found = answer.rows.filter((tag) => tag.id !== props.tag.id);
            setRows((previous) => {
                const unique = new Map((more ? previous : []).map((tag) => [tag.id, tag]));
                for (const tag of found) unique.set(tag.id, tag);
                return [...unique.values()];
            });
            setCursor(answer.cursor);
        } catch {
            if (current === request) setFailed(true);
        } finally {
            if (current === request) setLoading(false);
        }
    };
    createEffect(term, () => {
        void load(false);
    });
    const options = createMemo(() => {
        const selected = chosen();
        return selected && !rows().some((tag) => tag.id === selected.id) ? [selected, ...rows()] : rows();
    });
    const label = (id: string) => {
        const tag = options().find((tag) => tag.id === id);
        return tag?.thing === undefined ? (
            (tag?.name ?? t('Delete without merging'))
        ) : (
            <Name named={{ thing: tag.thing, text: tag.name, shownAs: 'name' }} />
        );
    };
    return (
        <div
            ref={(element) => {
                host = element;
            }}
            class="tag_delete_dialog"
        >
            <h3>{t('Delete Tag')}</h3>
            <div>
                {t('Do you want to delete the tag')}{' '}
                <span id="tag_to_delete" class="tags_inline inline-flex margin-r2">
                    <Show when={props.tag.thing} fallback={props.tag.name}>
                        {(thing) => <Name named={{ thing: thing(), text: props.tag.name, shownAs: 'name' }} />}
                    </Show>
                </span>
                ?
            </div>
            <p>{t('If you want to merge all references to this tag into another tag, select it below:')}</p>
            <label class="tag_merge_search">
                <span>{t('Find a merge target')}</span>
                <input
                    type="search"
                    class="text_pole"
                    placeholder={t('Search for a tag to merge into')}
                    value={term()}
                    ref={elementSetup((element) =>
                        focusActions.attach(element, {
                            confirm: () => {
                                host?.querySelector<HTMLButtonElement>('#merge_tag_select')?.focus();
                            },
                        }),
                    )}
                    onInput={(event) => setTerm(event.currentTarget.value)}
                />
            </label>
            <Select
                id="merge_tag_select"
                label={t('Merge into')}
                class="text_pole"
                value={chosen()?.id ?? ''}
                options={[
                    { value: '', label: t('Delete without merging') },
                    ...options().map((tag) => ({ value: tag.id, label: tag.name })),
                ]}
                renderItem={label}
                onChange={(value) => {
                    const tag = options().find((tag) => tag.id === value) ?? null;
                    setChosen(tag);
                    props.old.choose(tag);
                }}
            />
            <div role="status" aria-live="polite">
                <Show when={loading()}>{t('Loading tags...')}</Show>
                <Show when={failed()}>
                    <span>{t('The tags could not be loaded.')}</span>
                    <button type="button" class="menu_button" onClick={() => void load(failedMore())}>
                        {t('Try again')}
                    </button>
                </Show>
                <Show when={!loading() && !failed() && rows().length === 0}>{t('No tag has that name.')}</Show>
            </div>
            <Show when={cursor() !== null && !failed()}>
                <button
                    type="button"
                    class="menu_button tag_merge_more"
                    disabled={loading()}
                    onClick={() => void load(true)}
                >
                    {t('More tags')}
                </button>
            </Show>
        </div>
    );
}
