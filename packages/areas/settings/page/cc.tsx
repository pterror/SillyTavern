import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { VIEW } from '../protocol.ts';
import type { SettingsView } from '../protocol.ts';
import { useUi } from '@st/page/context';
import { Checkbox, FieldBlock, NumberBox, Radio, Select, Slider, TextArea, UnsetButton, useField } from './fields.tsx';
import type { FieldState } from './fields.tsx';

// The chat completion fields of the AI response configuration panel, laid out as the old markup (public/index.html,
// #range_block_openai and #openai_settings) had them. Each section replaces one run of the old field blocks; what's
// between them (the middle-out transform, prompt costs, quick prompts, logit bias, the prompt manager) is still the
// old page's.

/** What the old page knows of the model and the page shows by the toggles (until connections are the server's). */
export type Support = { functionCalling: boolean; image: boolean; video: boolean; audio: boolean };

/** The chat completion source now. */
function useSource() {
    const { client } = useUi();
    const view = client.view<SettingsView>(VIEW);
    return () => view()?.api.source ?? '';
}

/** Shown only for these chat completion sources (the old markup's data-source), or for all but them. */
function ForSources(props: { sources: string; except?: boolean; children: JSX.Element }) {
    const source = useSource();
    const listed = () => props.sources.split(',').includes(source());
    return <Show when={props.except === true ? !listed() : listed()}>{props.children}</Show>;
}

/** A block's title row: the label and the unset button. */
function Title(props: { field: FieldState; text: string; i18n?: string | undefined; class?: string }) {
    const { t } = useUi();
    return (
        <div class={props.class ?? 'range-block-title'}>
            {t(props.text, props.i18n)}
            <UnsetButton field={props.field} />
        </div>
    );
}

/** A slider block: title, then slider and counter. */
function SliderBlock(props: { id: string; counterId: string; title: string; i18n?: string }) {
    return (
        <FieldBlock id={props.id}>
            {(field) => (
                <>
                    <Title field={field} text={props.title} i18n={props.i18n} />
                    <Slider field={field} counterId={props.counterId} />
                </>
            )}
        </FieldBlock>
    );
}

/** A checkbox block: the box and its label, a description under them. */
function CheckboxBlock(props: { id: string; label: string; i18n?: string; title?: string; children?: JSX.Element }) {
    const { t } = useUi();
    return (
        <FieldBlock id={props.id}>
            {(field) => (
                <>
                    <label
                        for={props.id}
                        class="checkbox_label widthFreeExpand"
                        title={props.title !== undefined ? t(props.title) : undefined}
                    >
                        <Checkbox field={field} />
                        <span>{t(props.label, props.i18n)}</span>
                        <UnsetButton field={field} />
                    </label>
                    {props.children}
                </>
            )}
        </FieldBlock>
    );
}

/** Unlocked context, context size, response length and swipes per generation (the old blocks before middle-out). */
export function CcContext() {
    const { t } = useUi();
    return (
        <>
            <CheckboxBlock id="oai_max_context_unlocked" label="Unlocked Context Size">
                <div class="toggle-description justifyLeft">
                    <span>
                        {t(
                            "Unrestricted maximum value for the context size slider. Enable only if you know what you're doing.",
                            'Unrestricted maximum value for the context slider',
                        )}
                    </span>
                </div>
            </CheckboxBlock>
            <SliderBlock id="openai_max_context" counterId="openai_max_context_counter" title="Context Size (tokens)" />
            <FieldBlock id="openai_max_tokens">
                {(field) => (
                    <>
                        <Title field={field} text="Max Response Length (tokens)" />
                        <div class="wide100p">
                            <NumberBox field={field} />
                        </div>
                    </>
                )}
            </FieldBlock>
            <FieldBlock id="n_openai">
                {(field) => (
                    <>
                        <Title field={field} text="Multiple swipes per generation" />
                        <div class="wide100p">
                            <NumberBox field={field} />
                        </div>
                    </>
                )}
            </FieldBlock>
        </>
    );
}

/** Streaming and the samplers (the old blocks after the prompt costs). */
export function CcSamplers() {
    const { t } = useUi();
    return (
        <>
            <CheckboxBlock id="stream_toggle" label="Streaming" title="Enable OpenAI completion streaming">
                <div class="toggle-description justifyLeft">
                    <span>{t('Display the response bit by bit as it is generated.')}</span>
                    <br />
                    <span>
                        {t('When this is off, responses will be displayed all at once when they are complete.')}
                    </span>
                </div>
            </CheckboxBlock>
            <SliderBlock id="temp_openai" counterId="temp_counter_openai" title="Temperature" />
            <SliderBlock id="freq_pen_openai" counterId="freq_pen_counter_openai" title="Frequency Penalty" />
            <SliderBlock id="pres_pen_openai" counterId="pres_pen_counter_openai" title="Presence Penalty" />
            <SliderBlock id="top_k_openai" counterId="top_k_counter_openai" title="Top K" />
            <SliderBlock id="top_p_openai" counterId="top_p_counter_openai" title="Top P" />
            <SliderBlock
                id="repetition_penalty_openai"
                counterId="repetition_penalty_counter_openai"
                title="Repetition Penalty"
            />
            <SliderBlock id="min_p_openai" counterId="min_p_counter_openai" title="Min P" />
            <SliderBlock id="top_a_openai" counterId="top_a_counter_openai" title="Top A" />
        </>
    );
}

/** A utility prompt: title with its restore button, a description, the text. */
function UtilityPrompt(props: {
    id: string;
    title: string;
    i18n?: string;
    restoreId?: string;
    restoreTitle?: string;
    name?: string;
    children: JSX.Element;
}) {
    const { t } = useUi();
    return (
        <FieldBlock id={props.id} class="range-block m-t-1">
            {(field) => (
                <>
                    <div
                        class={
                            props.restoreId !== undefined
                                ? 'range-block-title openai_restorable'
                                : 'range-block-title justifyLeft'
                        }
                    >
                        <span>{t(props.title, props.i18n)}</span>
                        <UnsetButton field={field} />
                        <Show when={props.restoreId}>
                            <div
                                id={props.restoreId}
                                title={t(props.restoreTitle ?? 'Restore default prompt')}
                                class="right_menu_button"
                                onClick={() => field.reset()}
                            >
                                <div class="fa-solid fa-clock-rotate-left" />
                            </div>
                        </Show>
                    </div>
                    <div class="toggle-description justifyLeft">{props.children}</div>
                    <div class="wide100p">
                        <TextArea field={field} name={props.name} />
                    </div>
                </>
            )}
        </FieldBlock>
    );
}

/** The utility prompts drawer and the seed (the old blocks after the quick prompts). */
export function CcUtility() {
    const { t } = useUi();
    const use = () => t('Use', 'scenario_format_template_part_1');
    const place = () => t('to mark a place where the content is inserted.', 'scenario_format_template_part_2');
    return (
        <>
            <div class="inline-drawer wide100p">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>{t('Utility Prompts')}</b>
                    <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down" />
                </div>
                <div class="inline-drawer-content">
                    <UtilityPrompt
                        id="impersonation_prompt_textarea"
                        title="Impersonation prompt"
                        restoreId="impersonation_prompt_restore"
                        name="impersonation_prompt"
                    >
                        {t('Prompt that is used for Impersonation function')}
                    </UtilityPrompt>
                    <UtilityPrompt
                        id="wi_format_textarea"
                        title="World Info format template"
                        i18n="World Info Format Template"
                        restoreId="wi_format_restore"
                        restoreTitle="Restore default format"
                    >
                        <span>{t('Wraps activated World Info entries before inserting into the prompt.')}</span>{' '}
                        <span>{use()}</span>
                        <code>{'{0}'}</code> <span>{place()}</span>
                    </UtilityPrompt>
                    <UtilityPrompt
                        id="scenario_format_textarea"
                        title="Scenario format template"
                        i18n="Scenario Format Template"
                        restoreId="scenario_format_restore"
                        restoreTitle="Restore default format"
                    >
                        <span>{use()}</span> <code>{'{{scenario}}'}</code> <span>{place()}</span>
                    </UtilityPrompt>
                    <UtilityPrompt
                        id="personality_format_textarea"
                        title="Personality format template"
                        i18n="Personality Format Template"
                        restoreId="personality_format_restore"
                        restoreTitle="Restore default format"
                    >
                        <span>{use()}</span> <code>{'{{personality}}'}</code> <span>{place()}</span>
                    </UtilityPrompt>
                    <UtilityPrompt
                        id="group_nudge_prompt_textarea"
                        title="Group Nudge prompt template"
                        i18n="Group Nudge Prompt Template"
                        restoreId="group_nudge_prompt_restore"
                        restoreTitle="Restore default format"
                    >
                        {t('Sent at the end of the group chat history to force reply from a specific character.')}
                    </UtilityPrompt>
                    <UtilityPrompt
                        id="newchat_prompt_textarea"
                        title="New Chat"
                        restoreId="newchat_prompt_restore"
                        restoreTitle="Restore new chat prompt"
                        name="new_chat"
                    >
                        {t('Set at the beginning of the chat history to indicate that a new chat is about to start.')}
                    </UtilityPrompt>
                    <UtilityPrompt
                        id="newgroupchat_prompt_textarea"
                        title="New Group Chat"
                        restoreId="newgroupchat_prompt_restore"
                        restoreTitle="Restore new group chat prompt"
                        name="new_group_chat"
                    >
                        {t(
                            'Set at the beginning of the chat history to indicate that a new group chat is about to start.',
                        )}
                    </UtilityPrompt>
                    <UtilityPrompt
                        id="newexamplechat_prompt_textarea"
                        title="New Example Chat"
                        restoreId="newexamplechat_prompt_restore"
                        restoreTitle="Restore new example chat prompt"
                        name="new_example_chat"
                    >
                        {t(
                            'Set at the beginning of Dialogue examples to indicate that a new example chat is about to start.',
                        )}
                    </UtilityPrompt>
                    <UtilityPrompt
                        id="continue_nudge_prompt_textarea"
                        title="Continue nudge"
                        restoreId="continue_nudge_prompt_restore"
                        restoreTitle="Restore new chat prompt"
                        name="continue_nudge"
                    >
                        {t('Set at the end of the chat history when the continue button is pressed.')}
                    </UtilityPrompt>
                    <UtilityPrompt id="send_if_empty_textarea" title="Replace empty message" name="send_if_empty">
                        {t('Send this text instead of nothing when the text box is empty.')}
                    </UtilityPrompt>
                </div>
            </div>
            <FieldBlock id="seed_openai">
                {(field) => (
                    <>
                        <Title field={field} text="Seed" class="range-block-title justifyLeft" />
                        <div class="toggle-description justifyLeft">
                            {t('Set to get deterministic results. Use -1 for random seed.')}
                        </div>
                        <div class="wide100p">
                            <NumberBox field={field} />
                        </div>
                    </>
                )}
            </FieldBlock>
        </>
    );
}

/** A choice field as an inline drawer of radios, the choice's label shown in the header. */
function ChoiceDrawer(props: {
    id: string;
    title: string;
    tip: string;
    name: string;
    class: string;
    /** The id of the span showing the choice in the header (the old markup's). */
    displayId: string;
    /** Each option's label key and description (key and English), by the option's index. */
    options: { i18n?: string; description?: [string, string] }[];
}) {
    const { t } = useUi();
    const field = useField(props.id);
    const shown = () => {
        const option = field.field.options?.find((o) => o.value === field.value());
        return option ? t(option.label) : '';
    };
    return (
        <Show when={field.shown()}>
            <div class={props.class} attr:data-field={props.id} attr:data-settings-level={field.level()}>
                <div class="inline-drawer-toggle inline-drawer-header">
                    <div class="flex-container alignItemsCenter">
                        <b>{t(props.title)}</b>
                        <span title={t(props.tip)} class="opacity50p fa-solid fa-circle-info" />
                        <small class="flexBasis100p">
                            (<span id={props.displayId}>{shown()}</span>)
                        </small>
                        <UnsetButton field={field} />
                    </div>
                    <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down" />
                </div>
                <div class="inline-drawer-content">
                    <For each={field.field.options ?? []}>
                        {(option, index) => (
                            <label class="checkbox_label flexWrap alignItemsCenter" for={field.field.inputs?.[index()]}>
                                <Radio field={field} index={index()} name={props.name} />
                                <span>{t(option.label, props.options[index()]?.i18n)}</span>
                                <Show when={props.options[index()]?.description}>
                                    {(description) => (
                                        <small class="flexBasis100p">{t(description()[1], description()[0])}</small>
                                    )}
                                </Show>
                            </label>
                        )}
                    </For>
                    <Show when={field.refusal()}>{(text) => <small class="settings_refusal">{text()}</small>}</Show>
                </div>
            </div>
        </Show>
    );
}

/** Support icons for the model (the old page's capability checks), shown while their toggle is on. */
function SupportIcon(props: { id: string; supported: boolean; icon: string; sources?: string }) {
    const { t } = useUi();
    const icons = (
        <div id={props.id} attr:data-cc-toggle={String(props.supported)}>
            <i class={`icon-supported fa-solid ${props.icon}`} title={t('Supported by the current model')} />
            <i class={`icon-unsupported fa-solid ${props.icon}`} title={t('Unsupported by the current model')} />
        </div>
    );
    return props.sources !== undefined ? <ForSources sources={props.sources}>{icons}</ForSources> : icons;
}

/** The options under the samplers: names, continue, prompts, tools, media, reasoning, prefills. */
export function CcOptions(props: { support: () => Support }) {
    const { t } = useUi();
    const showThoughts = useField('openai_show_thoughts');
    return (
        <>
            <ChoiceDrawer
                id="names_behavior"
                title="Character Names Behavior"
                tip="Helps the model to associate messages with characters."
                name="character_names"
                displayId="character_names_display"
                class="inline-drawer wide100p flexFlowColumn"
                options={[
                    {
                        description: [
                            'character_names_none',
                            'Never add character name prefixes. May behave poorly in groups, choose with caution.',
                        ],
                    },
                    {
                        description: [
                            'character_names_default',
                            'Add prefixes for groups and past personas. Otherwise, make sure you provide names in the prompt.',
                        ],
                    },
                    {
                        description: [
                            'character_names_completion',
                            'Add character names to completion objects. Restrictions apply: only Latin alphanumerics and underscores.',
                        ],
                    },
                    {
                        description: [
                            'Prepend character names to message contents.',
                            'Prepend character names to message contents.',
                        ],
                    },
                ]}
            />
            <ChoiceDrawer
                id="continue_postfix"
                title="Continue Postfix"
                tip="The next chunk of the continued message will be appended using this as a separator."
                name="continue_postfix"
                displayId="continue_postfix_display"
                class="inline-drawer wide100p flexFlowColumn marginBot10"
                options={[{}, {}, {}, {}]}
            />
            <CheckboxBlock id="continue_prefill" label="Continue prefill">
                <div class="toggle-description justifyLeft">
                    <span>
                        {t(
                            'Continue sends the last message as assistant role instead of system message with instruction.',
                        )}
                    </span>
                </div>
            </CheckboxBlock>
            <CheckboxBlock id="squash_system_messages" label="Squash system messages" title="Squash system messages">
                <div class="toggle-description justifyLeft">
                    <span>
                        {t(
                            'Combines consecutive system messages into one (excluding example dialogues). May improve coherence for some models.',
                        )}
                    </span>
                </div>
            </CheckboxBlock>
            <CheckboxBlock id="use_sysprompt" label="Use system prompt">
                <div class="toggle-description justifyLeft marginBot5">
                    <span>
                        {t(
                            'Send the system prompt for supported models. If disabled, the user message is added to the beginning of the prompt.',
                        )}
                    </span>
                </div>
            </CheckboxBlock>
            <FieldBlock id="openai_enable_web_search">
                {(field) => (
                    <>
                        <label for="openai_enable_web_search" class="checkbox_label flexWrap widthFreeExpand">
                            <Checkbox field={field} />
                            <span>{t('Enable web search')}</span>
                            <UnsetButton field={field} />
                        </label>
                        <div class="flexBasis100p toggle-description justifyLeft">
                            <span>{t('Use search capabilities provided by the backend.')}</span>{' '}
                            <ForSources sources="openrouter">
                                <b>{t('Not free, adds a $0.02 fee to each prompt.', 'openrouter_web_search_fee')}</b>
                            </ForSources>
                        </div>
                    </>
                )}
            </FieldBlock>
            <FieldBlock id="openai_function_calling">
                {(field) => (
                    <>
                        <label for="openai_function_calling" class="checkbox_label flexWrap widthFreeExpand">
                            <Checkbox field={field} />
                            <span>{t('Enable function calling')}</span>
                            <SupportIcon
                                id="openai_function_calling_supported"
                                supported={props.support().functionCalling}
                                icon="fa-circle-check"
                            />
                            <UnsetButton field={field} />
                        </label>
                        <div class="flexBasis100p toggle-description justifyLeft">
                            <span>{t('Allows using ', 'enable_functions_desc_1')}</span>
                            <a href="https://platform.openai.com/docs/guides/function-calling" target="_blank">
                                {t('function tools', 'enable_functions_desc_2')}
                            </a>
                            .{' '}
                            <span>
                                {t(
                                    'Can be utilized by various extensions to provide additional functionality.',
                                    'enable_functions_desc_3',
                                )}
                            </span>{' '}
                            <strong>
                                {t(
                                    'Not supported when Prompt Post-Processing with "no tools" is used!',
                                    'enable_functions_desc_4',
                                )}
                            </strong>
                        </div>
                        <FieldBlock
                            id="tool_call_recurse_limit"
                            blockId="tool_call_recurse_limit_block"
                            class="range-block wide100p"
                        >
                            {(limit) => (
                                <>
                                    <div class="range-block-title">
                                        <small>{t('Tool Call Recurse Limit')}</small>
                                        <div
                                            class="fa-solid fa-circle-info opacity50p margin5"
                                            title={t('Maximum number of tool call recursion steps per generation.')}
                                        />
                                        <UnsetButton field={limit} />
                                    </div>
                                    <Slider field={limit} counterId="tool_call_recurse_limit_counter" />
                                </>
                            )}
                        </FieldBlock>
                    </>
                )}
            </FieldBlock>
            <FieldBlock id="tool_reasoning_mode">
                {(field) => (
                    <>
                        <div class="flex-container flexFlowColumn wide100p textAlignCenter marginTop10">
                            <div class="flex-container oneline-dropdown">
                                <label for="tool_reasoning_mode">{t('Interleaved Thinking')}</label>
                                <Select field={field} disabled={showThoughts.value() !== true} />
                                <UnsetButton field={field} />
                            </div>
                        </div>
                        <div class="toggle-description justifyLeft">
                            <span>
                                {t(
                                    'Sends reasoning from preceding assistant turns with tool-call requests to maintain interleaved thinking context.',
                                    'openrouter_interleaved_thinking_hint',
                                )}
                            </span>
                        </div>
                        <Show when={showThoughts.value() !== true}>
                            <div
                                id="openrouter_interleaved_thinking_disabled_hint"
                                class="toggle-description justifyLeft"
                            >
                                <em>{t('Enable "Request model reasoning" to use Interleaved Thinking.')}</em>
                            </div>
                        </Show>
                    </>
                )}
            </FieldBlock>
            <FieldBlock id="openai_media_inlining">
                {(field) => (
                    <>
                        <label for="openai_media_inlining" class="checkbox_label flexWrap widthFreeExpand">
                            <Checkbox field={field} />
                            <span>{t('Send inline media')}</span>
                            <div class="flex-container">
                                <SupportIcon
                                    id="openai_image_inlining_supported"
                                    supported={props.support().image}
                                    icon="fa-image"
                                />
                                <SupportIcon
                                    id="openai_video_inlining_supported"
                                    supported={props.support().video}
                                    icon="fa-film"
                                    sources="makersuite,vertexai,openrouter,zai"
                                />
                                <SupportIcon
                                    id="openai_audio_inlining_supported"
                                    supported={props.support().audio}
                                    icon="fa-music"
                                    sources="makersuite,vertexai,openrouter,openai,custom"
                                />
                            </div>
                            <UnsetButton field={field} />
                        </label>
                        <div id="image_inlining_hint" class="flexBasis100p toggle-description justifyLeft">
                            <span>
                                {t(
                                    'Sends attached media in prompts if supported by the model.',
                                    'image_inlining_hint_1',
                                )}
                            </span>{' '}
                            <ForSources sources="makersuite,vertexai">
                                <strong>
                                    {t(
                                        'Videos must be less than 20 MB and under 1 minute long.',
                                        'video_inlining_hint_4',
                                    )}
                                </strong>{' '}
                                <strong>{t('Audio must be less than 20 MB.', 'audio_inlining_hint_2')}</strong>
                            </ForSources>
                        </div>
                        <FieldBlock
                            id="openai_inline_image_quality"
                            class="flex-container flexFlowColumn wide100p textAlignCenter marginTop10"
                        >
                            {(quality) => (
                                <div class="flex-container oneline-dropdown">
                                    <label for="openai_inline_image_quality">{t('Inline Image Quality')}</label>
                                    <Select
                                        field={quality}
                                        keys={{
                                            auto: 'openai_inline_image_quality_auto',
                                            low: 'openai_inline_image_quality_low',
                                            high: 'openai_inline_image_quality_high',
                                        }}
                                    />
                                    <UnsetButton field={quality} />
                                </div>
                            )}
                        </FieldBlock>
                    </>
                )}
            </FieldBlock>
            <FieldBlock id="openai_request_images" blockId="request_images_block">
                {(field) => (
                    <>
                        <label for="openai_request_images" class="checkbox_label widthFreeExpand">
                            <Checkbox field={field} />
                            <span>
                                <span>{t('Request inline images')}</span>{' '}
                                <i
                                    class="opacity50p fa-solid fa-circle-info"
                                    title="Gemini 2.5 Flash Image / Gemini 3 Pro Image"
                                />
                            </span>
                            <UnsetButton field={field} />
                        </label>
                        <div class="toggle-description justifyLeft marginBot5">
                            <span>{t('Allows the model to return image attachments.')}</span>{' '}
                            <em>
                                {t(
                                    'Incompatible with the following features: function calling, web search, system prompt.',
                                    'Request inline images_desc_2',
                                )}
                            </em>
                        </div>
                        <div id="request_images_settings" class="flex-container wide100p textAlignCenter">
                            <FieldBlock id="request_image_resolution" class="flex1">
                                {(resolution) => (
                                    <>
                                        <label for="request_image_resolution">
                                            <small>{t('Resolution')}</small>
                                        </label>
                                        <Select field={resolution} class="text_pole" />
                                    </>
                                )}
                            </FieldBlock>
                            <FieldBlock id="request_image_aspect_ratio" class="flex1">
                                {(ratio) => (
                                    <>
                                        <label for="request_image_aspect_ratio">
                                            <small>{t('Aspect Ratio')}</small>
                                        </label>
                                        <Select field={ratio} class="text_pole" />
                                    </>
                                )}
                            </FieldBlock>
                        </div>
                    </>
                )}
            </FieldBlock>
            <CheckboxBlock id="openai_show_thoughts" label="Request model reasoning">
                <div class="toggle-description justifyLeft marginBot5">
                    <span>{t('Allows the model to return its thinking process.')}</span>{' '}
                    <ForSources sources="deepseek,zai,moonshot">
                        <strong>{t('This setting enables or disables reasoning generation by the model.')}</strong>
                    </ForSources>
                    <ForSources sources="zai,moonshot,openrouter,deepseek" except>
                        <strong>{t('This setting affects visibility only.')}</strong>
                    </ForSources>
                </div>
            </CheckboxBlock>
            <FieldBlock
                id="openai_reasoning_effort"
                class="flex-container flexFlowColumn wide100p textAlignCenter marginTop10"
            >
                {(field) => (
                    <div
                        class="flex-container oneline-dropdown"
                        title={t(
                            'Constrains effort on reasoning for reasoning models.\nReducing reasoning effort can result in faster responses and fewer tokens used on reasoning in a response.',
                            'Constrains effort on reasoning for reasoning models.',
                        )}
                    >
                        <label for="openai_reasoning_effort">
                            <span>{t('Reasoning Effort')}</span>{' '}
                            <a
                                href="https://docs.sillytavern.app/usage/prompts/reasoning/#reasoning-effort"
                                target="_blank"
                                class="opacity50p fa-solid fa-circle-question"
                            />
                        </label>
                        <Select
                            field={field}
                            keys={{
                                auto: 'openai_reasoning_effort_auto',
                                min: 'openai_reasoning_effort_minimum',
                                low: 'openai_reasoning_effort_low',
                                medium: 'openai_reasoning_effort_medium',
                                high: 'openai_reasoning_effort_high',
                                max: 'openai_reasoning_effort_maximum',
                            }}
                        />
                        <UnsetButton field={field} />
                        <ForSources sources="openai,custom,xai,aimlapi,openrouter,pollinations,perplexity,cometapi,electronhub,azure_openai,chutes">
                            <div class="toggle-description justifyLeft marginBot5">
                                {t(
                                    'OpenAI-compatible effort levels vary by model. Minimum and maximum may use model-specific aliases. Auto does not send an effort level.',
                                )}
                            </div>
                        </ForSources>
                        <ForSources sources="fireworks">
                            <div class="toggle-description justifyLeft marginBot5">
                                {t(
                                    'Fireworks supports low, medium, high, and max as distinct effort levels. Minimum is aliased to low. Auto does not send an effort level.',
                                )}
                            </div>
                        </ForSources>
                        <ForSources sources="openrouter">
                            <strong class="toggle-description justifyLeft marginBot5">
                                {t(
                                    'Request model reasoning = Off with Reasoning Effort = Minimum disables reasoning entirely on models that support that, but can cause errors with some models.',
                                )}
                            </strong>
                        </ForSources>
                        <ForSources sources="claude">
                            <div class="toggle-description justifyLeft marginBot5">
                                {t(
                                    'Selects an effort level on adaptive-thinking models. On older Claude models, it allocates a portion of the response length to thinking. Auto does not request thinking.',
                                )}
                            </div>
                        </ForSources>
                        <ForSources sources="makersuite,vertexai">
                            <div class="toggle-description justifyLeft marginBot5">
                                <span>
                                    {t(
                                        'Sets a dynamic reasoning depth level for thinking (Flash 3/Pro 3). High and low are supported by both, minimal and medium are Flash 3 only. Auto lets the model decide.',
                                    )}
                                </span>
                                <br />
                                <span>
                                    {t(
                                        'Allocates a portion of the response length for thinking (Flash 2.5/Pro 2.5) (min: 0/128 tokens, low: 10%, medium: 25%, high: 50%, max: 24576/32768 tokens). Auto lets the model decide.',
                                    )}
                                </span>
                            </div>
                        </ForSources>
                    </div>
                )}
            </FieldBlock>
            <FieldBlock
                id="openai_verbosity"
                class="flex-container flexFlowColumn wide100p textAlignCenter marginTop10"
            >
                {(field) => (
                    <div class="flex-container oneline-dropdown">
                        <label for="openai_verbosity">
                            <span>{t('Verbosity')}</span>
                        </label>
                        <Select
                            field={field}
                            keys={{
                                auto: 'openai_verbosity_auto',
                                low: 'openai_verbosity_low',
                                medium: 'openai_verbosity_medium',
                                high: 'openai_verbosity_high',
                            }}
                        />
                        <UnsetButton field={field} />
                        <div class="toggle-description justifyLeft marginBot5">
                            {t("Constrains the verbosity of the model's response.")}
                        </div>
                        <ForSources sources="claude">
                            <strong class="toggle-description justifyLeft marginBot5">
                                {t(
                                    'On adaptive-thinking Claude models, a non-automatic Reasoning Effort takes precedence over Verbosity.',
                                )}
                            </strong>
                        </ForSources>
                    </div>
                )}
            </FieldBlock>
            <ClaudePrefills />
        </>
    );
}

/** Claude's assistant prefills, and the warning that function calling with tools makes them not work. */
function ClaudePrefills() {
    const { t } = useUi();
    const prefill = useField('claude_assistant_prefill');
    const impersonation = useField('claude_assistant_impersonation');
    const functionCalling = useField('openai_function_calling');
    const warn = () => functionCalling.value() === true && (prefill.text() !== '' || impersonation.text() !== '');
    const maximize = (id: string) => (
        <i
            class="editor_maximize fa-solid fa-maximize right_menu_button"
            attr:data-for={id}
            title={t('Expand the editor')}
        />
    );
    return (
        <Show when={prefill.shown()}>
            <div class="range-block">
                <div class="wide100p">
                    <div
                        class="flex-container alignItemsCenter"
                        attr:data-field="claude_assistant_prefill"
                        attr:data-settings-level={prefill.level()}
                    >
                        <span id="claude_assistant_prefill_text">{t('Assistant Prefill')}</span>
                        {maximize('claude_assistant_prefill')}
                        <UnsetButton field={prefill} />
                    </div>
                    <TextArea
                        field={prefill}
                        rows={2}
                        name="assistant_prefill"
                        placeholder={t("Start Claude's answer with...")}
                    />
                    <div
                        class="flex-container alignItemsCenter"
                        attr:data-field="claude_assistant_impersonation"
                        attr:data-settings-level={impersonation.level()}
                    >
                        <span id="claude_assistant_impersonation_text">{t('Assistant Impersonation Prefill')}</span>
                        {maximize('claude_assistant_impersonation')}
                        <UnsetButton field={impersonation} />
                    </div>
                    <TextArea
                        field={impersonation}
                        rows={2}
                        name="assistant_impersonation"
                        placeholder={t("Start Claude's answer with...")}
                    />
                    <Show when={prefill.refusal() ?? impersonation.refusal()}>
                        {(text) => <small class="settings_refusal">{text()}</small>}
                    </Show>
                </div>
                <Show when={warn()}>
                    <div id="claude_function_prefill_warning">
                        <i class="fa-solid fa-circle-info" />
                        <span>
                            {t("Prefills won't work when function calling is enabled and any tools are registered.")}
                        </span>
                    </div>
                </Show>
            </div>
        </Show>
    );
}
