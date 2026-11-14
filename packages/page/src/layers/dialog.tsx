import { For, Show, createSignal, onMount } from 'solid-js';
import { render } from 'solid-js/web';

export type Question =
    | { kind: 'input'; message: string; value: string }
    | {
          kind: 'confirm';
          message: string;
          detail?: string;
          numbers?: { id: string; label: string; value: number; min: number }[];
          checkbox?: { label: string; checked: boolean };
      }
    | { kind: 'choose'; message: string; options: { id: string; label: string; checked: boolean }[] };

type Answer<Q extends Question> = Q extends { kind: 'input' }
    ? string
    : Q extends { kind: 'confirm' }
      ? { checked: boolean; numbers: Record<string, number> }
      : string[];

export function ask<Q extends Question>(question: Q, t: (text: string) => string): Promise<Answer<Q> | null> {
    return new Promise((resolve) => {
        const host = document.createElement('div');
        document.body.append(host);
        const dispose = render(
            () =>
                dialog(question, t, (answer) => {
                    dispose();
                    host.remove();
                    resolve(answer as Answer<Q> | null);
                }),
            host,
        );
    });
}

function dialog(
    question: Question,
    t: (text: string) => string,
    onAnswer: (answer: string | { checked: boolean; numbers: Record<string, number> } | string[] | null) => void,
) {
    const [text, setText] = createSignal(question.kind === 'input' ? question.value : '');
    const [checked, setChecked] = createSignal(
        question.kind === 'confirm' ? (question.checkbox?.checked ?? false) : false,
    );
    const [chosen, setChosen] = createSignal(
        new Set(question.kind === 'choose' ? question.options.filter((o) => o.checked).map((o) => o.id) : []),
    );
    const [numbers, setNumbers] = createSignal<Record<string, number>>(
        question.kind === 'confirm'
            ? Object.fromEntries((question.numbers ?? []).map((field) => [field.id, field.value]))
            : {},
    );
    const answer = () => {
        if (question.kind === 'input') return text().trim() === '' ? null : text().trim();
        if (question.kind === 'confirm') return { checked: checked(), numbers: numbers() };
        return [...chosen()];
    };
    const toggle = (id: string, on: boolean) => {
        const next = new Set(chosen());
        if (on) next.add(id);
        else next.delete(id);
        setChosen(next);
    };
    const message = question.message;
    const detail = question.kind === 'confirm' ? question.detail : undefined;
    const checkbox = question.kind === 'confirm' ? question.checkbox : undefined;
    const numberFields = question.kind === 'confirm' ? question.numbers : undefined;
    const options = question.kind === 'choose' ? question.options : undefined;
    const isInput = question.kind === 'input';
    let element: HTMLDialogElement | undefined;
    onMount(() => element?.showModal());

    return (
        <dialog
            ref={(el: HTMLDialogElement) => (element = el)}
            class="popup"
            onCancel={(event) => {
                event.preventDefault();
                onAnswer(null);
            }}
        >
            <form
                class="popup-body"
                method="dialog"
                onSubmit={(event) => {
                    event.preventDefault();
                    onAnswer(answer());
                }}
            >
                <div class="popup-content">
                    <h3 class="popup-header">{message}</h3>
                    <Show when={detail}>{(shown) => <p>{shown()}</p>}</Show>
                </div>
                <Show when={isInput}>
                    {
                        <input
                            class="popup-input text_pole"
                            autofocus
                            value={text()}
                            onInput={(event) => setText(event.currentTarget.value)}
                        />
                    }
                </Show>
                <Show when={numberFields}>
                    {(fields) => (
                        <div class="popup-inputs">
                            <For each={fields()}>
                                {(field) => (
                                    <label class="popup-input-label">
                                        <span>{field.label}</span>
                                        <input
                                            type="number"
                                            class="text_pole"
                                            min={field.min}
                                            step="1"
                                            value={numbers()[field.id]}
                                            onInput={(event) => {
                                                const value = Math.max(
                                                    field.min,
                                                    Math.floor(Number(event.currentTarget.value)),
                                                );
                                                if (Number.isFinite(value))
                                                    setNumbers({ ...numbers(), [field.id]: value });
                                            }}
                                        />
                                    </label>
                                )}
                            </For>
                        </div>
                    )}
                </Show>
                <Show when={checkbox}>
                    {(box) => (
                        <label class="checkbox_label">
                            <input
                                type="checkbox"
                                checked={checked()}
                                onChange={(event) => setChecked(event.currentTarget.checked)}
                            />
                            <span>{box().label}</span>
                        </label>
                    )}
                </Show>
                <Show when={options}>
                    {(list) => (
                        <div class="popup-inputs">
                            <For each={list()}>
                                {(option) => (
                                    <label class="checkbox_label">
                                        <input
                                            type="checkbox"
                                            checked={chosen().has(option.id)}
                                            onChange={(event) => toggle(option.id, event.currentTarget.checked)}
                                        />
                                        <span>{option.label}</span>
                                    </label>
                                )}
                            </For>
                        </div>
                    )}
                </Show>
                <div class="popup-controls">
                    <button type="submit" class="popup-button-ok menu_button">
                        {t('OK')}
                    </button>
                    <button type="button" class="popup-button-cancel menu_button" onClick={() => onAnswer(null)}>
                        {t('Cancel')}
                    </button>
                </div>
            </form>
        </dialog>
    );
}
