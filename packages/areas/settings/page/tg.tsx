import { For, Show, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import { SAMPLER_NAMES, VIEW, samplerSelectOf } from '../protocol.ts';
import type { Field, SettingsView } from '../protocol.ts';
import { Portal } from 'solid-js/web';
import { useUi } from '@st/page/context';
import {
    Checkbox,
    FieldBlock,
    JsonArea,
    NumberBox,
    Slider,
    TextArea,
    UnsetButton,
    bySamplerSelect,
    forBackend,
} from './fields.tsx';
import type { FieldState } from './fields.tsx';

const KEY = '_textgenerationwebui';

function useView() {
    const { client } = useUi();
    return client.view<SettingsView>(VIEW);
}

function Block(props: {
    id?: string;
    class: string;
    sampler?: string;
    types?: Field['textgen'];
    children: JSX.Element;
}) {
    const view = useView();
    const shown = () => {
        const current = view();
        if (!current) return false;
        const chosen = bySamplerSelect(
            props.sampler === undefined ? undefined : [props.sampler],
            samplerSelectOf(current),
        );
        return chosen ?? forBackend(props.types, current.api.textgen);
    };
    return (
        <Show when={shown()}>
            <div id={props.id} class={props.class}>
                {props.children}
            </div>
        </Show>
    );
}

function Info(props: { tip: string; i18n?: string | undefined; class?: string }) {
    const { t } = useUi();
    return <div class={props.class ?? 'fa-solid fa-circle-info opacity50p'} title={t(props.tip, props.i18n)} />;
}

const COLUMN = 'alignitemscenter flex-container flexFlowColumn flexBasis30p flexGrow flexShrink gap0';
const HALF = 'alignitemscenter flex-container flexFlowColumn flexBasis48p flexGrow flexShrink gap0';
const GROWING = 'alignitemscenter flex-container marginBot5 flexFlowColumn flexGrow flexShrink gap0';

function TgSlider(props: {
    name: string;
    label: string;
    i18n?: string;
    tip?: string;
    tipI18n?: string;
    class?: string;
    unlocked?: boolean;
}) {
    const { t } = useUi();
    return (
        <FieldBlock id={`${props.name}${KEY}`} class={props.class ?? COLUMN}>
            {(field) => (
                <>
                    <small>
                        <span>{t(props.label, props.i18n)}</span>
                        <Show when={props.tip}>{(tip) => <Info tip={tip()} i18n={props.tipI18n} />}</Show>
                        <UnsetButton field={field} />
                    </small>
                    <Slider
                        field={field}
                        counterId={`${props.name}_counter${KEY}`}
                        look="neo"
                        unlocked={props.unlocked === true}
                    />
                </>
            )}
        </FieldBlock>
    );
}

function TgCheckbox(props: {
    name: string;
    label: string;
    i18n?: string;
    tip?: string;
    tipI18n?: string;
    grow?: boolean;
}) {
    const { t } = useUi();
    return (
        <FieldBlock
            id={`${props.name}${KEY}`}
            class={props.grow === false ? 'checkbox_label' : 'checkbox_label flexGrow flexShrink'}
        >
            {(field) => (
                <label class="checkbox_label" for={`${props.name}${KEY}`}>
                    <Checkbox field={field} />
                    <small>{t(props.label, props.i18n)}</small>
                    <Show when={props.tip}>
                        {(tip) => <Info tip={tip()} i18n={props.tipI18n} class="fa-solid fa-circle-info opacity50p " />}
                    </Show>
                    <UnsetButton field={field} />
                </label>
            )}
        </FieldBlock>
    );
}

export function TgTop() {
    const { client, t } = useUi();
    const [selecting, setSelecting] = createSignal(false);
    return (
        <>
            <div class="flex-container justifyCenter">
                <small class="flex-container alignitemscenter">
                    <div
                        id="samplerResetButton"
                        class="menu_button whitespacenowrap"
                        onClick={() => void client.send('settings.neutralize', {})}
                    >
                        {t('Neutralize Samplers')}
                    </div>
                    <Info tip="Set all samplers to their neutral/disabled state." />
                </small>
                <small class="flex-container alignitemscenter">
                    <div
                        id="samplerSelectButton"
                        class="menu_button whitespacenowrap"
                        onClick={() => setSelecting(true)}
                    >
                        {t('Sampler Select')}
                    </div>
                    <Info tip="Customize displayed samplers or add custom samplers." />
                </small>
            </div>
            <Show when={selecting()}>
                {/* On the body: the panel may be in a closed drawer, and a dialog under a hidden element isn't drawn. */}
                <Portal>
                    <SamplerSelectDialog onClose={() => setSelecting(false)} />
                </Portal>
            </Show>
            <FieldBlock
                id={`n${KEY}`}
                class="flex-container flexFlowColumn alignitemscenter flexBasis100p flexGrow flexShrink gap0"
            >
                {(field) => (
                    <>
                        <small>{t('Multiple swipes per generation')}</small>
                        <NumberBox field={field} class="text_pole textAlignCenter" />
                    </>
                )}
            </FieldBlock>
        </>
    );
}

function SamplerSelectDialog(props: { onClose: () => void }) {
    const { client, t } = useUi();
    const view = useView();
    const select = () => {
        const current = view();
        return current ? samplerSelectOf(current) : { manual: false, shown: [] };
    };
    const toggle = (name: string, on: boolean) => {
        const shown = select().shown.filter((each) => each !== name);
        void client.send('settings.samplers', { shown: on ? [...shown, name] : shown });
    };
    return (
        <dialog
            ref={(element: HTMLDialogElement) => onMount(() => element.showModal())}
            id="sampler_view_list"
            class="popup wide_dialogue_popup large_dialogue_popup"
            onCancel={(event) => {
                event.preventDefault();
                props.onClose();
            }}
        >
            <div class="popup-body">
                <div class="popup-content flex-container flexFlowColumn">
                    <div class="title_restorable flexFlowColumn alignItemsBaseline">
                        <div class="flex-container justifySpaceBetween alignItemsBaseline wide100p">
                            <h3>{t('Sampler Select')}</h3>
                            <div class="flex-container alignItemsBaseline">
                                <div
                                    id="resetSelectedSamplers"
                                    class="menu_button menu_button_icon"
                                    title={t('Reset custom sampler selection')}
                                    onClick={() => void client.send('settings.samplers.reset', {})}
                                >
                                    <i class="fa-solid fa-recycle" />
                                    <span>{t('Reset')}</span>
                                </div>
                                <div
                                    id="prioritizeManuallySelectedSamplers"
                                    class="menu_button menu_button_icon"
                                    classList={{ toggleEnabled: select().manual }}
                                    title={t('Prioritize showing samplers manually selected from this popup.')}
                                    onClick={() => void client.send('settings.samplers', { manual: !select().manual })}
                                >
                                    <i class="fa-solid fa-lock" />
                                    <span>{t('Prioritize')}</span>
                                </div>
                                <div
                                    class="margin5 fa-solid fa-exclamation-circle"
                                    title={t(
                                        'Toggle on to force the samplers selected in this menu to be shown when switching to the current API Type (API Connections Panel). By default, SillyTavern automatically selects samplers used or needed by the selected API Type.',
                                    )}
                                />
                            </div>
                        </div>
                        <small>{t('Here you can toggle the display of individual samplers. (WIP)')}</small>
                    </div>
                    <hr />
                    <div id="apiSamplersList" class="flex-container flexNoGap">
                        <For each={SAMPLER_NAMES}>
                            {(name) => (
                                <label class="sampler_view_list_item wide50p flex-container">
                                    <input
                                        type="checkbox"
                                        name={`${name}_checkbox`}
                                        checked={select().shown.includes(name)}
                                        onChange={(event) => toggle(name, event.currentTarget.checked)}
                                    />
                                    <small class="sampler_name">{name}</small>
                                </label>
                            )}
                        </For>
                    </div>
                </div>
                <div class="popup-controls">
                    <div class="popup-button-ok menu_button" onClick={() => props.onClose()}>
                        {t('Close')}
                    </div>
                </div>
            </div>
        </dialog>
    );
}

export function TgSamplers() {
    const { t } = useUi();
    return (
        <>
            <TgSlider
                name="temp"
                label="Temperature"
                tip={
                    'Temperature controls the randomness in token selection:\r- low temperature (<1.0) leads to more predictable text, favoring higher probability tokens.\r- high temperature (>1.0) increases creativity and diversity in the output by giving lower probability tokens a better chance.\rSet to 1.0 for the original probabilities.'
                }
                tipI18n="Temperature controls the randomness in token selection"
            />
            <TgSlider
                name="top_k"
                label="Top K"
                tip={
                    'Top K sets a maximum amount of top tokens that can be chosen from.\rE.g Top K is 20, this means only the 20 highest ranking tokens will be kept (regardless of their probabilities being diverse or limited).\rSet to 0 (or -1, depending on your backend) to disable.'
                }
                tipI18n="Top_K_desc"
            />
            <TgSlider
                name="top_p"
                label="Top P"
                tip={
                    'Top P (a.k.a. nucleus sampling) adds up all the top tokens required to add up to the target percentage.\rE.g If the Top 2 tokens are both 25%, and Top P is 0.50, only the Top 2 tokens are considered.\rSet to 1.0 to disable.'
                }
                tipI18n="Top_P_desc"
            />
            <TgSlider
                name="typical_p"
                label="Typical P"
                tip={
                    'Typical P Sampling prioritizes tokens based on their deviation from the average entropy of the set.\rIt maintains tokens whose cumulative probability is close to a predefined threshold (e.g., 0.5), emphasizing those with average information content.\rSet to 1.0 to disable.'
                }
                tipI18n="Typical_P_desc"
            />
            <TgSlider
                name="min_p"
                label="Min P"
                tip={
                    "Min P sets a base minimum probability. This is scaled according to the top token's probability.\rE.g If Top token is 80% probability, and Min P is 0.1, only tokens higher than 8% would be considered.\rSet to 0 to disable."
                }
                tipI18n="Min_P_desc"
            />
            <TgSlider
                name="top_a"
                label="Top A"
                tip={
                    "Top A sets a threshold for token selection based on the square of the highest token probability.\rE.g if the Top-A value is 0.2 and the top token's probability is 50%, tokens with probabilities below 5% (0.2 * 0.5^2) are excluded.\rSet to 0 to disable."
                }
                tipI18n="Top_A_desc"
            />
            <TgSlider
                name="tfs"
                label="TFS"
                tip={
                    'Tail-Free Sampling (TFS) searches for a tail of low-probability tokens in the distribution,\rby analyzing the rate of change in token probabilities using derivatives. It retains tokens up to a threshold (e.g., 0.3) based on the normalized second derivative.\rThe closer to 0, the more discarded tokens. Set to 1.0 to disable.'
                }
                tipI18n="Tail_Free_Sampling_desc"
            />
            <TgSlider
                name="epsilon_cutoff"
                label="Epsilon Cutoff"
                tip={
                    'Epsilon cutoff sets a probability floor below which tokens are excluded from being sampled.\rIn units of 1e-4; a reasonable value is 3.\rSet to 0 to disable.'
                }
                tipI18n="Epsilon cutoff sets a probability floor below which tokens are excluded from being sampled"
            />
            <TgSlider
                name="nsigma"
                label="Top nsigma"
                tip="A sampling method that filters logits based on their statistical properties. It keeps tokens within n standard deviations of the maximum logit value, providing a simpler alternative to top-p/top-k sampling while maintaining sampling stability across different temperatures."
            />
            <TgSlider
                name="min_keep"
                label="Min Keep"
                tip="A sampling modifier that ensures that truncation samplers such as top-p, min-p, typical-p, and xtc return at least this many tokens. Set to 0 to disable."
            />
            <TgSlider
                name="eta_cutoff"
                label="Eta Cutoff"
                tip={
                    'Eta cutoff is the main parameter of the special Eta Sampling technique.\rIn units of 1e-4; a reasonable value is 3.\rSet to 0 to disable.\rSee the paper Truncation Sampling as Language Model Desmoothing by Hewitt et al. (2022) for details.'
                }
                tipI18n="Eta_Cutoff_desc"
            />
            <TgSlider name="rep_pen" label="Repetition Penalty" i18n="rep.pen" />
            <TgSlider name="rep_pen_range" label="Rep Pen Range" i18n="rep.pen range" unlocked={useUnlocked()()} />
            <TgSlider name="rep_pen_slope" label="Rep Pen Slope" i18n="Rep. Pen. Slope" />
            <TgSlider name="rep_pen_decay" label="Rep Pen Decay" i18n="rep.pen decay" />
            <TgSlider name="encoder_rep_pen" label="Encoder Penalty" i18n="Encoder Rep. Pen." />
            <TgSlider name="freq_pen" label="Frequency Penalty" />
            <TgSlider name="presence_pen" label="Presence Penalty" />
            <TgSlider name="no_repeat_ngram_size" label="No Repeat Ngram Size" />
            <TgSlider name="skew" label="Skew" />
            <TgSlider name="min_length" label="Min Length" />
            <TgSlider name="max_tokens_second" label="Maximum tokens/second" i18n="Max Tokens Second" />

            <Block id="adaptive_p_block" class="wide100p" types={{ only: ['koboldcpp', 'llamacpp', 'ooba', 'tabby'] }}>
                <h4 class="wide100p textAlignCenter">
                    <label>{t('Adaptive-P')}</label>
                    <a href="https://github.com/MrJackSpade/adaptive-p-docs" target="_blank">
                        <Info tip="" />
                    </a>
                </h4>
                <div class="flex-container flexFlowRow alignitemscenter gap10px flexShrink">
                    <TgSlider name="adaptive_target" label="Target" class={GROWING} />
                    <TgSlider name="adaptive_decay" label="Decay" class={GROWING} />
                </div>
            </Block>

            <div class="inline-drawer wide100p">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>{t('Advanced Sampler Settings')}</b>
                    <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down" />
                </div>
                <div class="inline-drawer-content wide100p">
                    <Block
                        id="smoothingBlock"
                        class="wide100p"
                        sampler="smoothing_factor"
                        types={{ only: ['mancer', 'ooba', 'koboldcpp', 'aphrodite', 'tabby'] }}
                    >
                        <h4 class="wide100p textAlignCenter">
                            <label>{t('Smooth Sampling')}</label>
                            <Info
                                class=" fa-solid fa-circle-info opacity50p "
                                tip="Allows you to use quadratic/cubic transformations to adjust the distribution. Lower Smoothing Factor values will be more creative, usually between 0.2-0.3 is the sweetspot (assuming the curve = 1). Higher Smoothing Curve values will make the curve steeper, which will punish low probability choices more aggressively. 1.0 curve is equivalent to only using Smoothing Factor."
                                i18n="Smooth_Sampling_desc"
                            />
                        </h4>
                        <div class="flex-container flexFlowRow gap10px flexShrink">
                            <TgSlider name="smoothing_factor" label="Smoothing Factor" class={HALF} />
                            <TgSlider name="smoothing_curve" label="Smoothing Curve" class={HALF} />
                        </div>
                    </Block>
                    <Block
                        id="xtc_block"
                        class="wide100p"
                        sampler="xtc_probability"
                        types={{ only: ['koboldcpp', 'aphrodite', 'mancer', 'tabby', 'ooba', 'llamacpp'] }}
                    >
                        <h4 class="wide100p textAlignCenter">
                            <label>{t('Exclude Top Choices (XTC)')}</label>
                            <a href="https://github.com/oobabooga/text-generation-webui/pull/6335" target="_blank">
                                <Info class=" fa-solid fa-circle-info opacity50p" tip="" />
                            </a>
                        </h4>
                        <div class="flex-container flexFlowRow gap10px flexShrink">
                            <TgSlider name="xtc_threshold" label="Threshold" class={HALF} />
                            <TgSlider name="xtc_probability" label="Probability" class={HALF} />
                        </div>
                    </Block>
                    <Block
                        id="dryBlock"
                        class="wide100p"
                        sampler="dry_multiplier"
                        types={{ only: ['aphrodite', 'mancer', 'ooba', 'koboldcpp', 'tabby', 'llamacpp', 'dreamgen'] }}
                    >
                        <h4
                            class="wide100p textAlignCenter"
                            title={t(
                                'DRY penalizes tokens that would extend the end of the input into a sequence that has previously occurred in the input. Set multiplier to 0 to disable.',
                                'DRY_Repetition_Penalty_desc',
                            )}
                        >
                            <label>{t('DRY Repetition Penalty')}</label>
                            <a href="https://github.com/oobabooga/text-generation-webui/pull/5677" target="_blank">
                                <Info class=" fa-solid fa-circle-info opacity50p" tip="" />
                            </a>
                        </h4>
                        <div class="flex-container flexFlowRow gap10px flexShrink">
                            <TgSlider name="dry_multiplier" label="Multiplier" class={HALF} />
                            <TgSlider name="dry_base" label="Base" class={HALF} />
                            <TgSlider name="dry_allowed_length" label="Allowed Length" class={HALF} />
                            <TgSlider name="dry_penalty_last_n" label="Penalty Range" class={HALF} />
                        </div>
                        <FieldBlock id={`dry_sequence_breakers${KEY}`} class="range-block marginTop5">
                            {(field) => (
                                <>
                                    <div class="range-block-title textAlignCenter flex-container justifyCenter alignitemscenter">
                                        <small>{t('Sequence Breakers')}</small>
                                        <UnsetButton field={field} />
                                    </div>
                                    <TextArea
                                        field={field}
                                        class="text_pole textarea_compact"
                                        name="sequence_breakers"
                                        placeholder={t('JSON-serialized array of strings.')}
                                    />
                                </>
                            )}
                        </FieldBlock>
                    </Block>
                    <Block
                        id="dynatemp_block_ooba"
                        class="wide100p"
                        sampler="dynatemp"
                        types={{ only: ['ooba', 'mancer', 'koboldcpp', 'tabby', 'llamacpp', 'aphrodite'] }}
                    >
                        <h4 class="wide100p textAlignCenter">
                            <FieldBlock id={`dynatemp${KEY}`} class="flex-container alignitemscenter justifyCenter">
                                {(field) => (
                                    <>
                                        <div class="checkbox_label">
                                            <Checkbox field={field} />
                                        </div>
                                        <span class="textAlignCenter">{t('Dynamic Temperature')}</span>
                                        <Info
                                            tip="Scale Temperature dynamically per token, based on the variation of probabilities."
                                            i18n="Scale Temperature dynamically per token, based on the variation of probabilities"
                                        />
                                        <UnsetButton field={field} />
                                    </>
                                )}
                            </FieldBlock>
                        </h4>
                        <div class="flex-container flexFlowRow alignitemscenter gap10px flexShrink">
                            <TgSlider name="min_temp" label="Minimum Temp" class={GROWING} />
                            <TgSlider name="max_temp" label="Maximum Temp" class={GROWING} />
                            <TgSlider name="dynatemp_exponent" label="Exponent" class={GROWING} />
                        </div>
                    </Block>
                    <Block
                        id="mirostat_block_ooba"
                        class="wide100p"
                        sampler="mirostat_mode"
                        types={{ only: ['ooba', 'infermaticai', 'koboldcpp', 'llamacpp', 'tabby'] }}
                    >
                        <h4 class="wide100p textAlignCenter">
                            <label>{t('Mirostat', 'Mirostat (mode=1 is only for llama.cpp)')}</label>
                            <Info
                                class=" fa-solid fa-circle-info opacity50p "
                                tip={
                                    'Mirostat is a thermostat for output perplexity.\rMirostat matches the output perplexity to that of the input, thus avoiding the repetition trap\r(where, as the autoregressive inference produces text, the perplexity of the output tends toward zero)\rand the confusion trap (where the perplexity diverges).\rFor details, see the paper Mirostat: A Neural Text Decoding Algorithm that Directly Controls Perplexity by Basu et al. (2020).\rMode chooses the Mirostat version. 0=disable, 1=Mirostat 1.0 (llama.cpp only), 2=Mirostat 2.0.\rTau = Variability parameter for Mirostat outputs.\rEta = Learning rate of Mirostat.'
                                }
                                i18n="Mirostat_desc"
                            />
                        </h4>
                        <div class="flex-container flexFlowRow gap10px flexShrink">
                            <TgSlider name="mirostat_mode" label="Mode" i18n="Mirostat Mode" class={GROWING} />
                            <TgSlider name="mirostat_tau" label="Tau" i18n="Mirostat Tau" class={GROWING} />
                            <TgSlider name="mirostat_eta" label="Eta" i18n="Mirostat Eta" class={GROWING} />
                        </div>
                    </Block>
                    <Block
                        id="grammar_block_ooba"
                        class="wide100p"
                        sampler="grammar_string"
                        types={{ only: ['ooba', 'aphrodite', 'tabby'] }}
                    >
                        <hr class="wide100p" />
                        <h4 class="wide100p textAlignCenter">
                            <div class="flex-container justifyCenter alignitemscenter">
                                <span>{t('Grammar String')}</span>
                                <Info
                                    class="margin5 fa-solid fa-circle-info opacity50p "
                                    tip="GBNF or EBNF, depends on the backend in use. If you're using this you should know which."
                                />
                                <a
                                    href="https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md"
                                    target="_blank"
                                >
                                    <div class="fa-solid fa-up-right-from-square note-link-span" />
                                </a>
                            </div>
                        </h4>
                        <FieldBlock id={`grammar_string${KEY}`} class="wide100p">
                            {(field) => (
                                <TextArea
                                    field={field}
                                    rows={4}
                                    class="text_pole textarea_compact monospace"
                                    placeholder={t('Type in the desired custom grammar')}
                                />
                            )}
                        </FieldBlock>
                    </Block>
                    <Block
                        id="json_schema_block"
                        class="wide100p"
                        sampler="json_schema"
                        types={{ only: ['tabby', 'llamacpp', 'aphrodite'] }}
                    >
                        <hr class="wide100p" />
                        <h4 class="wide100p textAlignCenter">
                            <span>{t('JSON Schema')}</span>
                            <a href="https://json-schema.org/learn/getting-started-step-by-step" target="_blank">
                                <small>
                                    <div class="fa-solid fa-circle-question note-link-span" />
                                </small>
                            </a>
                        </h4>
                        <FieldBlock id="tabby_json_schema" class="wide100p">
                            {(field) => <JsonArea field={field} placeholder={t('Type in the desired JSON schema')} />}
                        </FieldBlock>
                        <FieldBlock id={`json_schema_allow_empty${KEY}`} class="wide100p">
                            {(field) => (
                                <label
                                    for={`json_schema_allow_empty${KEY}`}
                                    class="checkbox_label"
                                    title={t('Treat empty JSON object as a valid JSON schema.')}
                                >
                                    <Checkbox field={field} />
                                    <small>{t('Allow empty schema objects')}</small>
                                </label>
                            )}
                        </FieldBlock>
                    </Block>
                </div>
            </div>

            <Block id="beamSearchBlock" class="wide100p" sampler="num_beams" types={{ only: ['ooba'] }}>
                <h4 class="wide100p textAlignCenter">
                    <label>
                        <span>{t('Beam Search', 'Beam search')}</span>
                        <Info
                            class=" fa-solid fa-circle-info opacity50p "
                            tip="A greedy, brute-force algorithm used in LLM sampling to find the most likely sequence of words or tokens. It expands multiple candidate sequences at once, maintaining a fixed number (beam width) of top sequences at each step."
                        />
                    </label>
                </h4>
                <div class="flex-container flexFlowRow alignitemscenter gap10px flexShrink">
                    <TgSlider
                        name="num_beams"
                        label="# of Beams"
                        tip="The number of sequences generated at each step with Beam Search."
                        class={GROWING}
                    />
                    <TgSlider
                        name="length_penalty"
                        label="Length Penalty"
                        tip="Penalize sequences based on their length."
                        class={GROWING}
                    />
                    <TgCheckbox
                        name="early_stopping"
                        label="Early Stopping"
                        tip="Controls the stopping condition for beam search. If checked, the generation stops as soon as there are '# of Beams' sequences. If not checked, a heuristic is applied and the generation is stopped when it's very unlikely to find better candidates."
                        grow={false}
                    />
                </div>
            </Block>
            <Block id="contrastiveSearchBlock" class={HALF} sampler="penalty_alpha" types={{ only: ['ooba'] }}>
                <h4 class="textAlignCenter">
                    <span>{t('Contrastive Search', 'Contrastive search')}</span>
                    <Info
                        class=" fa-solid fa-circle-info opacity50p "
                        tip="A sampler that encourages diversity while maintaining coherence, by exploiting the isotropicity of the representation space of most LLMs. For details, see the paper A Contrastive Framework for Neural Text Generation by Su et al. (2022)."
                        i18n="Contrastive_search_txt"
                    />
                </h4>
                <TgSlider
                    name="penalty_alpha"
                    label="Penalty Alpha"
                    tip="Strength of the Contrastive Search regularization term. Set to 0 to disable CS."
                    tipI18n="Strength of the Contrastive Search regularization term. Set to 0 to disable CS"
                    class="alignitemscenter flex-container flexFlowColumn wide100p gap0"
                />
            </Block>
            <div class="flex-container flexBasis48p justifyCenter flexGrow flexShrink ">
                <div class="flex-container flexFlowColumn marginTop5">
                    <TgCheckbox name="do_sample" label="Do Sample" />
                    <TgCheckbox
                        name="add_bos_token"
                        label="Add BOS Token"
                        tip="Add the bos_token to the beginning of prompts. Disabling this can make the replies more creative."
                        tipI18n="Add the bos_token to the beginning of prompts. Disabling this can make the replies more creative"
                    />
                    <TgCheckbox
                        name="ban_eos_token"
                        label="Ban EOS Token"
                        tip="Ban the eos_token. This forces the model to never end the generation prematurely."
                        tipI18n="Ban the eos_token. This forces the model to never end the generation prematurely"
                    />
                    <TgCheckbox
                        name="ignore_eos_token"
                        label="Ignore EOS Token"
                        tip="Ignore the EOS Token even if it generates."
                        grow={false}
                    />
                    <TgCheckbox name="skip_special_tokens" label="Skip Special Tokens" />
                    <TgCheckbox name="include_reasoning" label="Request Model Reasoning" />
                    <TgCheckbox
                        name="temperature_last"
                        label="Temperature Last"
                        tip={
                            'Use the temperature sampler last. This is almost always the sensible thing to do.\rWhen enabled: sample the set of plausible tokens first, then apply temperature to adjust their relative probabilities (technically, logits).\rWhen disabled: apply temperature to adjust the relative probabilities of ALL tokens first, then sample plausible tokens from that.\rDisabling Temperature Last boosts the probabilities in the tail of the distribution, which tends to amplify the chances of getting an incoherent response.'
                        }
                        tipI18n="Temperature_Last_desc"
                    />
                    <TgCheckbox
                        name="speculative_ngram"
                        label="Speculative Ngram"
                        tip={
                            'Use a different speculative decoding method without a draft model.\rUsing a draft model is preferred. Speculative ngram is not as effective.'
                        }
                        tipI18n="Use a different speculative decoding method without a draft model"
                    />
                    <TgCheckbox
                        name="spaces_between_special_tokens"
                        label="Spaces Between Special Tokens"
                        grow={false}
                    />
                </div>
            </div>
            <FieldBlock
                id={`seed${KEY}`}
                class="flex-container flexFlowColumn alignitemscenter flexBasis48p flexGrow flexShrink gap0"
            >
                {(field) => (
                    <>
                        <label>
                            <small>{t('Seed')}</small>
                            <Info
                                class="fa-solid fa-circle-info opacity50p "
                                tip="A random seed to use for deterministic and reproducable outputs. Set to -1 to use a random seed."
                                i18n="Seed_desc"
                            />
                        </label>
                        <NumberBox field={field} class="text_pole textAlignCenter" />
                    </>
                )}
            </FieldBlock>
            <BannedTokens />
        </>
    );
}

function BannedTokens() {
    const { t } = useUi();
    return (
        <Block id="banned_tokens_block_ooba" class="wide100p" sampler="banned_tokens" types={{ except: ['generic'] }}>
            <hr class="width100p" />
            <FieldBlock id={`send_banned_tokens${KEY}`} class="range-block-title title_restorable">
                {(send) => (
                    <>
                        <div>
                            <strong>{t('Banned Tokens/Strings', 'Banned Tokens')}</strong>
                            <Info
                                class="margin5 fa-solid fa-circle-info opacity50p "
                                tip={
                                    "Enter sequences you don't want to appear in the output.\rUnquoted text will be tokenized in the back end and banned as tokens.\r[token ids] will be banned as-is.\rMost tokens have a leading space. Use token counter (with the correct tokenizer selected first!) if you are unsure.\rEnclose text in double quotes to ban the entire string as a set.\rQuoted Strings and [Token ids] must be on their own line."
                                }
                                i18n="LLaMA / Mistral / Yi models only"
                            />
                        </div>
                        <label
                            id="send_banned_tokens_label"
                            for={`send_banned_tokens${KEY}`}
                            class="checkbox_label"
                            title={
                                send.value() === true ? t('Banned tokens are sent') : t('Banned tokens are not sent')
                            }
                        >
                            <span style={{ display: 'none' }}>
                                <Checkbox field={send} />
                            </span>
                            <small>
                                <i
                                    class="fa-solid fa-power-off menu_button togglable margin0"
                                    classList={{ toggleEnabled: send.value() === true }}
                                />
                            </small>
                        </label>
                    </>
                )}
            </FieldBlock>
            <div id="banned_tokens_controls_ooba">
                <div class="textAlignCenter">
                    <small>{t('Global list')}</small>
                </div>
                <FieldBlock id={`global_banned_tokens${KEY}`} class="wide100p marginBot10">
                    {(field) => <BannedList field={field} />}
                </FieldBlock>
                <div class="textAlignCenter">
                    <small>{t('Preset-specific list')}</small>
                </div>
                <FieldBlock id={`banned_tokens${KEY}`} class="wide100p">
                    {(field) => <BannedList field={field} />}
                </FieldBlock>
            </div>
        </Block>
    );
}

function BannedList(props: { field: FieldState }) {
    const { t } = useUi();
    return (
        <TextArea
            field={props.field}
            class="text_pole textarea_compact"
            name={props.field.field.id}
            placeholder={t(
                'some text as tokens\n[420, 69, 1337]\n"Some verbatim string"',
                'Example: some text [42, 69, 1337]',
            )}
        />
    );
}

export function TgCfg() {
    const { t } = useUi();
    return (
        <Block
            id="cfg_block_ooba"
            class="flex-container flexFlowColumn wide100p"
            sampler="guidance_scale"
            types={{ only: ['ooba', 'tabby'] }}
        >
            <hr class="width100p" />
            <h4 class="textAlignCenter">
                <span>{t('CFG')}</span>
                <Info
                    class="margin5 fa-solid fa-circle-info opacity50p "
                    tip="Classifier Free Guidance. More helpful tip coming soon."
                    i18n="Classifier Free Guidance. More helpful tip coming soon"
                />
            </h4>
            <TgSlider
                name="guidance_scale"
                label="Scale"
                class="alignitemscenter flex-container flexFlowColumn flexShrink gap0"
            />
            <FieldBlock id={`negative_prompt${KEY}`} class="range-block">
                {(field) => (
                    <>
                        <div class="alignitemscenter justifyCenter flex-container flexShrink">
                            <small>{t('Negative Prompt')}</small>
                            <Info
                                tip="Used if CFG Scale is unset globally, per chat or character"
                                i18n="Used if CFG Scale is unset globally, per chat or character"
                            />
                            <UnsetButton field={field} />
                        </div>
                        <TextArea
                            field={field}
                            class="wide100p text_pole textarea_compact"
                            name="negative_prompt"
                            placeholder={t(
                                "Add text here that would make the AI generate things you don't want in your outputs.",
                            )}
                        />
                    </>
                )}
            </FieldBlock>
        </Block>
    );
}

function useUnlocked() {
    const view = useView();
    return () => view()?.values['power_user.max_context_unlocked'] === true;
}
