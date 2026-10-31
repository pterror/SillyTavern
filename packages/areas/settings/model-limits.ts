import { FIELDS, labRangeOf, rangeOf } from './protocol.ts';

const K = 1000;
const MAX = {
    '2k': 2047,
    '4k': 4095,
    '8k': 8191,
    '16k': 16383,
    '32k': 32767,
    '64k': 65535,
    '128k': 128 * K,
    '200k': 200 * K,
    '256k': 256 * K,
    '400k': 400 * K,
    '1mil': 1000 * K,
    '1050k': 1050 * K,
    '2mil': 2000 * K,
} as const;

export const UNLOCKED_CONTEXT = MAX['2mil'];

export type ModelRecord = Record<string, unknown> & { id?: unknown };

export type ModelLimits = { context: number; temperature: number; penalties: { min: number; max: number } };

export const MODEL_SETTING: Record<string, string> = {
    openai: 'openai_model',
    azure_openai: 'azure_openai_model',
    claude: 'claude_model',
    openrouter: 'openrouter_model',
    ai21: 'ai21_model',
    makersuite: 'google_model',
    vertexai: 'vertexai_model',
    mistralai: 'mistralai_model',
    custom: 'custom_model',
    cohere: 'cohere_model',
    perplexity: 'perplexity_model',
    groq: 'groq_model',
    siliconflow: 'siliconflow_model',
    minimax: 'minimax_model',
    electronhub: 'electronhub_model',
    chutes: 'chutes_model',
    nanogpt: 'nanogpt_model',
    deepseek: 'deepseek_model',
    xai: 'xai_model',
    pollinations: 'pollinations_model',
    aimlapi: 'aimlapi_model',
    moonshot: 'moonshot_model',
    fireworks: 'fireworks_model',
    cometapi: 'cometapi_model',
    zai: 'zai_model',
    workers_ai: 'workers_ai_model',
};

function byPattern(model: string, rules: readonly (readonly [RegExp, number])[], fallback: number): number {
    return rules.find(([pattern]) => pattern.test(model))?.[1] ?? fallback;
}

function byName(model: string, rules: readonly (readonly [string, number])[], fallback: number): number {
    let best: readonly [string, number] | undefined;
    for (const rule of rules) if (model.includes(rule[0]) && (!best || rule[0].length > best[0].length)) best = rule;
    return best?.[1] ?? fallback;
}

function listed(models: readonly ModelRecord[], model: string, read: (record: ModelRecord) => unknown): number | null {
    const record = models.find((m) => m.id === model);
    const value = record ? read(record) : undefined;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

const field = (name: string) => (record: ModelRecord) => record[name];

const OPENAI_CONTEXT = [
    [/^gpt-6-/, MAX['1050k']],
    [/^gpt-5\.6/, MAX['1050k']],
    [/^gpt-5\.[45]/, MAX['1mil']],
    [/^gpt-5/, MAX['400k']],
    [/gpt-4\.1/, MAX['1mil']],
    [/gpt-audio/, MAX['128k']],
    [/^o1/, MAX['128k']],
    [/^o[34]/, MAX['200k']],
    [/chatgpt-4o-latest|gpt-4-turbo|gpt-4o|gpt-4-1106|gpt-4-0125|gpt-4-vision/, MAX['128k']],
    [/gpt-3\.5-turbo-1106/, MAX['16k']],
    [/^(gpt-4|gpt-4-0314|gpt-4-0613)$/, MAX['8k']],
    [/^(gpt-4-32k|gpt-4-32k-0314|gpt-4-32k-0613)$/, MAX['32k']],
    [/gpt-realtime/, MAX['32k']],
    [/^(gpt-3\.5-turbo-16k|gpt-3\.5-turbo-16k-0613)$/, MAX['16k']],
    [/^code-davinci-002$/, MAX['8k']],
    [/^(text-curie-001|text-babbage-001|text-ada-001)$/, MAX['2k']],
    [/gpt-3/, MAX['4k']],
] as const;

const GEMINI_CONTEXT = [
    [/^gemini-4-argon(?:$|-)/, MAX['1mil']],
    [/gemini-2\.5-flash-image/, MAX['32k']],
    [/gemini-3\.1-flash-image/, MAX['128k']],
    [/gemini-3-pro-image/, MAX['64k']],
    [/gemini-(?:3[.\d]*|2\.(?:5|0))-(pro|flash)/, MAX['1mil']],
    [/(gemini-exp|learnlm-2\.0-flash|gemini-robotics)/, MAX['1mil']],
    [/gemma-3-27b-it/, MAX['128k']],
    [/gemma-3n-e4b-it/, MAX['8k']],
    [/gemma-3/, MAX['32k']],
    [/gemma-4/, MAX['256k']],
] as const;

const GROQ_CONTEXT = [
    ['gemma2-9b-it', MAX['8k']],
    ['llama-3.3-70b-versatile', MAX['128k']],
    ['llama-3.1-8b-instant', MAX['128k']],
    ['llama3-70b-8192', MAX['8k']],
    ['llama3-8b-8192', MAX['8k']],
    ['llama-guard-3-8b', MAX['8k']],
    ['mixtral-8x7b-32768', MAX['32k']],
    ['deepseek-r1-distill-llama-70b', MAX['128k']],
    ['llama-3.3-70b-specdec', MAX['8k']],
    ['llama-3.2-1b-preview', MAX['128k']],
    ['llama-3.2-3b-preview', MAX['128k']],
    ['llama-3.2-11b-vision-preview', MAX['128k']],
    ['llama-3.2-90b-vision-preview', MAX['128k']],
    ['qwen-2.5-32b', MAX['128k']],
    ['deepseek-r1-distill-qwen-32b', MAX['128k']],
    ['deepseek-r1-distill-llama-70b-specdec', MAX['128k']],
    ['mistral-saba-24b', MAX['32k']],
    ['meta-llama/llama-4-scout-17b-16e-instruct', MAX['128k']],
    ['meta-llama/llama-4-maverick-17b-128e-instruct', MAX['128k']],
    ['compound-beta', MAX['128k']],
    ['compound-beta-mini', MAX['128k']],
    ['qwen/qwen3-32b', MAX['128k']],
] as const;

const ZAI_CONTEXT = [
    ['glm-5.2', MAX['1mil']],
    ['glm-5.1', MAX['200k']],
    ['glm-5-turbo', MAX['200k']],
    ['glm-5v-turbo', MAX['200k']],
    ['glm-5', MAX['200k']],
    ['glm-4.7', MAX['200k']],
    ['glm-4.7-flash', MAX['200k']],
    ['glm-4.7-flashx', MAX['200k']],
    ['glm-4.6v', MAX['128k']],
    ['glm-4.6v-flash', MAX['128k']],
    ['glm-4.6v-flashx', MAX['128k']],
    ['glm-4.6', MAX['200k']],
    ['glm-4.5', MAX['128k']],
    ['glm-4-32b-0414-128k', MAX['128k']],
    ['glm-4.5-air', MAX['128k']],
    ['glm-4.5v', MAX['64k']],
    ['autoglm-phone-multilingual', MAX['64k']],
] as const;

const SILICONFLOW_CONTEXT = [
    ['baidu/ERNIE-4.5-300B-A47B', MAX['128k']],
    ['ByteDance-Seed/Seed-OSS-36B-Instruct', MAX['256k']],
    ['deepseek-ai/DeepSeek-R1', MAX['128k']],
    ['deepseek-ai/DeepSeek-V3', MAX['128k']],
    ['deepseek-ai/DeepSeek-V3.1', MAX['128k']],
    ['deepseek-ai/DeepSeek-V3.1-Terminus', MAX['128k']],
    ['deepseek-ai/DeepSeek-V3.2-Exp', MAX['128k']],
    ['deepseek-ai/deepseek-vl2', MAX['4k']],
    ['inclusionAI/Ling-1T', MAX['128k']],
    ['inclusionAI/Ling-flash-2.0', MAX['128k']],
    ['inclusionAI/Ling-mini-2.0', MAX['128k']],
    ['inclusionAI/Ring-1T', MAX['128k']],
    ['inclusionAI/Ring-flash-2.0', MAX['128k']],
    ['meta-llama/Llama-3.3-70B-Instruct', MAX['32k']],
    ['meta-llama/Meta-Llama-3.1-8B-Instruct', MAX['32k']],
    ['MiniMaxAI/MiniMax-M1-80k', MAX['128k']],
    ['MiniMaxAI/MiniMax-M2', MAX['128k']],
    ['moonshotai/Kimi-K2-Instruct', MAX['128k']],
    ['moonshotai/Kimi-K2-Instruct-0905', MAX['256k']],
    ['moonshotai/Kimi-K2-Thinking', MAX['256k']],
    ['openai/gpt-oss-120b', MAX['128k']],
    ['openai/gpt-oss-20b', MAX['128k']],
    ['Qwen/Qwen3-235B-A22B-Instruct-2507', MAX['256k']],
    ['Qwen/Qwen3-235B-A22B-Thinking-2507', MAX['256k']],
    ['Qwen/Qwen3-30B-A3B-Instruct-2507', MAX['256k']],
    ['Qwen/Qwen3-30B-A3B-Thinking-2507', MAX['256k']],
    ['Qwen/Qwen3-VL-235B-A22B-Instruct', MAX['256k']],
    ['Qwen/Qwen3-VL-235B-A22B-Thinking', MAX['256k']],
    ['Qwen/Qwen3-VL-30B-A3B-Instruct', MAX['256k']],
    ['Qwen/Qwen3-VL-30B-A3B-Thinking', MAX['256k']],
    ['Qwen/Qwen3-VL-32B-Instruct', MAX['256k']],
    ['Qwen/Qwen3-VL-32B-Thinking', MAX['256k']],
    ['Qwen/Qwen3-VL-8B-Instruct', MAX['256k']],
    ['Qwen/Qwen3-VL-8B-Thinking', MAX['256k']],
    ['stepfun-ai/step3', MAX['64k']],
    ['tencent/Hunyuan-A13B-Instruct', MAX['128k']],
    ['zai-org/GLM-4.5', MAX['128k']],
    ['zai-org/GLM-4.5-Air', MAX['128k']],
    ['zai-org/GLM-4.5V', MAX['64k']],
    ['zai-org/GLM-4.6', MAX['200k']],
] as const;

const MOONSHOT_CONTEXT = [
    ['moonshot-v1-8k', MAX['8k']],
    ['moonshot-v1-32k', MAX['32k']],
    ['moonshot-v1-128k', MAX['128k']],
    ['moonshot-v1-auto', MAX['128k']],
    ['moonshot-v1-8k-vision-preview', MAX['8k']],
    ['moonshot-v1-32k-vision-preview', MAX['32k']],
    ['moonshot-v1-128k-vision-preview', MAX['128k']],
    ['kimi-k2-0711-preview', MAX['32k']],
    ['kimi-latest', MAX['256k']],
    ['kimi-thinking-preview', MAX['32k']],
    ['kimi-k2.5', MAX['256k']],
    ['kimi-k2-0905-preview', MAX['256k']],
    ['kimi-k2-turbo-preview', MAX['256k']],
    ['kimi-k2-thinking', MAX['256k']],
    ['kimi-k2-thinking-turbo', MAX['256k']],
] as const;

const COHERE_CONTEXT = [
    [/^(command-light-nightly|command-light|command)$/, MAX['4k']],
    [/command-r|^(c4ai-aya-23|c4ai-aya-expanse-32b|command-nightly|command-a-vision-07-2025)$/, MAX['128k']],
    [/^command-a-03-2025$/, MAX['256k']],
    [/^(c4ai-aya-23-8b|c4ai-aya-expanse-8b)$/, MAX['8k']],
    [/^(c4ai-aya-vision-8b|c4ai-aya-vision-32b)$/, MAX['16k']],
] as const;

const PERPLEXITY_CONTEXT = [
    [/^(sonar|sonar-reasoning|sonar-reasoning-pro|r1-1776)$/, 127000],
    [/^sonar-pro$/, 200000],
    [/llama-3\.1.*online/, 128 * 1024 - 4000],
    [/llama-3\.1/, 128 * 1024],
] as const;

const XAI_CONTEXT = [
    ['grok-2-vision', MAX['32k']],
    ['grok-4-fast', MAX['2mil']],
    ['grok-4', MAX['256k']],
    ['grok-code', MAX['256k']],
] as const;

const TEMPERATURE = { openai: 2.0, claude: 1.0, mistral: 1.5, workersAi: 5.0 } as const;
const PENALTIES = { usual: { min: -2, max: 2 }, cohere: { min: 0, max: 1 } } as const;

export function limitsFor(
    source: string,
    model: string,
    unlocked: boolean,
    models: readonly ModelRecord[] = [],
): ModelLimits {
    const context = (locked: () => number) => (unlocked ? UNLOCKED_CONTEXT : locked());
    const limits = (contextMax: number, temperature: number): ModelLimits => ({
        context: contextMax,
        temperature,
        penalties: source === 'cohere' ? PENALTIES.cohere : PENALTIES.usual,
    });
    switch (source) {
        case 'makersuite':
        case 'vertexai': {
            const temperature =
                listed(models, model, field('maxTemperature')) ?? (/(vision|ultra|gemma)/.test(model) ? 1.0 : 2.0);
            return limits(
                context(
                    () =>
                        listed(models, model, field('inputTokenLimit')) ??
                        byPattern(model, GEMINI_CONTEXT, MAX['128k']),
                ),
                temperature,
            );
        }
        case 'openrouter':
            return limits(
                context(() => listed(models, model, field('context_length')) ?? MAX['128k']),
                model.includes('claude') || model.includes('palm-2') ? TEMPERATURE.claude : TEMPERATURE.openai,
            );
        case 'claude':
            return limits(
                context(() =>
                    /^claude-(sonnet-4-5|sonnet-4-6|sonnet-5|opus-4-6|opus-4-7|opus-4-8|opus-5|fable)/.test(model)
                        ? MAX['1mil']
                        : MAX['200k'],
                ),
                TEMPERATURE.claude,
            );
        case 'openai':
        case 'azure_openai':
            return limits(
                context(() => byPattern(model, OPENAI_CONTEXT, MAX['128k'])),
                TEMPERATURE.openai,
            );
        case 'mistralai':
            return limits(
                context(() => listed(models, model, field('max_context_length')) ?? MAX['32k']),
                TEMPERATURE.mistral,
            );
        case 'cohere':
            return limits(
                context(() => byPattern(model, COHERE_CONTEXT, MAX['4k'])),
                TEMPERATURE.claude,
            );
        case 'perplexity':
            return limits(
                context(() => byPattern(model, PERPLEXITY_CONTEXT, MAX['128k'])),
                TEMPERATURE.openai,
            );
        case 'groq':
            return limits(
                context(
                    () => listed(models, model, field('context_window')) ?? byName(model, GROQ_CONTEXT, MAX['128k']),
                ),
                TEMPERATURE.openai,
            );
        case 'ai21':
            return limits(
                context(() => MAX['256k']),
                TEMPERATURE.openai,
            );
        case 'custom':
            return limits(UNLOCKED_CONTEXT, TEMPERATURE.openai);
        case 'chutes':
            return limits(
                context(() => listed(models, model, field('context_length')) ?? MAX['8k']),
                TEMPERATURE.openai,
            );
        case 'electronhub':
            return limits(
                context(() => listed(models, model, field('tokens')) ?? MAX['128k']),
                TEMPERATURE.openai,
            );
        case 'nanogpt':
            return limits(
                context(() => listed(models, model, field('context_length')) ?? MAX['128k']),
                TEMPERATURE.openai,
            );
        case 'pollinations':
        case 'cometapi':
            return limits(
                context(() => MAX['128k']),
                TEMPERATURE.openai,
            );
        case 'deepseek':
            return limits(
                context(() => MAX['1mil']),
                TEMPERATURE.openai,
            );
        case 'workers_ai': {
            const window = (record: ModelRecord) =>
                Array.isArray(record['properties'])
                    ? Number(
                          (record['properties'] as { property_id?: unknown; value?: unknown }[]).find(
                              (p) => p.property_id === 'context_window',
                          )?.value,
                      )
                    : undefined;
            return limits(
                context(() => listed(models, model, window) ?? MAX['8k']),
                TEMPERATURE.workersAi,
            );
        }
        case 'xai':
            return limits(
                context(() => byName(model, XAI_CONTEXT, MAX['128k'])),
                TEMPERATURE.openai,
            );
        case 'aimlapi': {
            const length = (record: ModelRecord) =>
                (record['info'] as { contextLength?: unknown } | undefined)?.contextLength ?? record['context_length'];
            return limits(
                context(() => listed(models, model, length) ?? MAX['32k']),
                TEMPERATURE.openai,
            );
        }
        case 'moonshot':
            return limits(
                context(
                    () => listed(models, model, field('context_length')) ?? byName(model, MOONSHOT_CONTEXT, MAX['32k']),
                ),
                TEMPERATURE.claude,
            );
        case 'fireworks':
            return limits(
                context(
                    () =>
                        listed(models, model, field('context_length')) ??
                        listed(models, model, field('context_window')) ??
                        MAX['32k'],
                ),
                TEMPERATURE.openai,
            );
        case 'siliconflow':
            return limits(
                context(() => byName(model, SILICONFLOW_CONTEXT, MAX['32k'])),
                TEMPERATURE.openai,
            );
        case 'minimax':
            return limits(model === 'M2-her' ? 65536 : 204800, TEMPERATURE.claude);
        case 'zai':
            return limits(
                context(() => byName(model, ZAI_CONTEXT, MAX['128k'])),
                TEMPERATURE.claude,
            );
        default:
            return limits(
                context(() => MAX['128k']),
                TEMPERATURE.openai,
            );
    }
}

export type ModelLists = (source: string) => readonly ModelRecord[];

export function limitRecord(record: ModelRecord): ModelRecord {
    const kept: ModelRecord = { id: record.id };
    for (const name of [
        'context_length',
        'inputTokenLimit',
        'maxTemperature',
        'max_context_length',
        'context_window',
        'tokens',
    ])
        if (name in record) kept[name] = record[name];
    if (Array.isArray(record['properties']))
        kept['properties'] = (record['properties'] as ({ property_id?: unknown } | null)[]).filter(
            (p) => p?.property_id === 'context_window',
        );
    const info = record['info'] as { contextLength?: unknown } | undefined;
    if (info && typeof info === 'object' && 'contextLength' in info)
        kept['info'] = { contextLength: info.contextLength };
    return kept;
}

export function limitsOfSettings(oai: Record<string, unknown>, models: ModelLists): ModelLimits {
    const text = (key: string) => {
        const value = oai[key];
        return typeof value === 'string' ? value : '';
    };
    const source = text('chat_completion_source');
    const setting = MODEL_SETTING[source];
    return limitsFor(
        source,
        setting !== undefined ? text(setting) : '',
        oai['max_context_unlocked'] === true,
        models(source),
    );
}

export function withinLimits<T extends Record<string, unknown>>(settings: T, models: ModelLists): T {
    const oai: unknown = settings['oai_settings'];
    if (typeof oai !== 'object' || oai === null || Array.isArray(oai)) return settings;
    const stored = oai as Record<string, unknown>;
    const limits = limitsOfSettings(stored, models);
    const bounds: [key: string, min: number, max: number][] = [
        ['openai_max_context', -Infinity, limits.context],
        ['temp_openai', -Infinity, limits.temperature],
        ['freq_pen_openai', limits.penalties.min, limits.penalties.max],
        ['pres_pen_openai', limits.penalties.min, limits.penalties.max],
    ];
    const bounded = bounds.flatMap(([key, min, max]) => {
        const value = stored[key];
        return typeof value === 'number' && (value < min || value > max)
            ? [[key, Math.min(max, Math.max(min, value))] as const]
            : [];
    });
    return bounded.length === 0
        ? settings
        : { ...settings, oai_settings: { ...stored, ...Object.fromEntries(bounded) } };
}

export const MINUS_ONE_BACKENDS: readonly string[] = ['vllm', 'aphrodite', 'infermaticai'];

export function withinBackend<T extends Record<string, unknown>>(settings: T): T {
    const textgen: unknown = settings['textgenerationwebui_settings'];
    if (typeof textgen !== 'object' || textgen === null || Array.isArray(textgen)) return settings;
    const stored = textgen as Record<string, unknown>;
    const minusOne = typeof stored['type'] === 'string' && MINUS_ONE_BACKENDS.includes(stored['type']);
    const off = minusOne ? -1 : 0;
    if (stored['top_k'] !== 0 && stored['top_k'] !== -1) return settings;
    if (stored['top_k'] === off) return settings;
    return { ...settings, textgenerationwebui_settings: { ...stored, top_k: off } };
}

export function withinUnlock<T extends Record<string, unknown>>(settings: T): T {
    const powerUser: unknown = settings['power_user'];
    const unlocked =
        typeof powerUser === 'object' &&
        powerUser !== null &&
        (powerUser as Record<string, unknown>)['max_context_unlocked'] === true;
    const lab =
        typeof powerUser === 'object' &&
        powerUser !== null &&
        (powerUser as Record<string, unknown>)['enableLabMode'] === true;
    let out: Record<string, unknown> = settings;
    for (const field of FIELDS) {
        if (field.limits === undefined || (lab && labRangeOf(field) !== undefined)) continue;
        const { max } = rangeOf(field, unlocked);
        const keys = field.path.split('.');
        const parent = keys.length === 1 ? out : out[keys[0] ?? ''];
        const key = keys.at(-1) ?? '';
        if (typeof parent !== 'object' || parent === null) continue;
        const value = (parent as Record<string, unknown>)[key];
        if (typeof value !== 'number' || max === undefined || value <= max) continue;
        out =
            keys.length === 1
                ? { ...out, [key]: max }
                : { ...out, [keys[0] ?? '']: { ...(parent as Record<string, unknown>), [key]: max } };
    }
    return out as T;
}

export function withinAllowed<T extends Record<string, unknown>>(settings: T, models: ModelLists): T {
    return withinUnlock(withinBackend(withinLimits(settings, models)));
}
