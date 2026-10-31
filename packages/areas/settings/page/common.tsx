import { useUi } from '@st/page/context';
import { Checkbox, FieldBlock, Slider, UnsetButton } from './fields.tsx';

const BLOCK =
    'range-block-range-and-counter alignitemscenter flex-container marginBot5 flexFlowColumn flexBasis48p flexGrow flexShrink gap0';
const STREAMING_TIP =
    'Display the response bit by bit as it is generated.\rWhen this is off, responses will be displayed all at once when they are complete.';

function Streaming(props: { id: string }) {
    const { t } = useUi();
    return (
        <FieldBlock
            id={props.id}
            blockId={`${props.id}_block`}
            class="flex-container alignitemscenter justifyCenter marginTop5"
        >
            {(field) => (
                <label class="checkbox_label" for={props.id}>
                    <Checkbox field={field} />
                    <small>
                        <span>{t('Streaming')}</span>
                        <div
                            class="margin5 fa-solid fa-circle-info opacity50p"
                            title={t(STREAMING_TIP, 'Streaming_desc')}
                        />
                    </small>
                    <UnsetButton field={field} />
                </label>
            )}
        </FieldBlock>
    );
}

export function CommonLengths() {
    const { t } = useUi();
    return (
        <>
            <FieldBlock id="amount_gen" blockId="amount_gen_block" class={BLOCK}>
                {(field) => (
                    <>
                        <small>
                            {t('Response (tokens)', 'response legth(tokens)')}
                            <UnsetButton field={field} />
                        </small>
                        <Slider field={field} counterId="amount_gen_counter" look="neo-wide" />
                        <Streaming id="streaming_textgenerationwebui" />
                        <Streaming id="streaming_kobold" />
                        <Streaming id="streaming_novel" />
                    </>
                )}
            </FieldBlock>
            <FieldBlock id="max_context" blockId="max_context_block" class={BLOCK}>
                {(field) => (
                    <>
                        <small>
                            {t('Context (tokens)', 'context size(tokens)')}
                            <UnsetButton field={field} />
                        </small>
                        <Slider field={field} counterId="max_context_counter" look="neo-wide" />
                        <FieldBlock
                            id="max_context_unlocked"
                            blockId="max_context_unlocked_block"
                            class="flex-container alignitemscenter justifyCenter marginTop5"
                        >
                            {(unlock) => (
                                <label class="checkbox_label">
                                    <Checkbox field={unlock} />
                                    <small>
                                        <span>{t('Unlocked', 'unlocked')}</span>
                                        <div
                                            id="max_context_unlocked_warning"
                                            class="fa-solid fa-circle-info opacity50p "
                                            title={t(
                                                "Only enable this if your model supports context sizes greater than 8192 tokens.\rIncrease only if you know what you're doing.",
                                                'Only enable this if your model supports context sizes greater than 8192 tokens',
                                            )}
                                        />
                                    </small>
                                    <UnsetButton field={unlock} />
                                </label>
                            )}
                        </FieldBlock>
                    </>
                )}
            </FieldBlock>
        </>
    );
}
