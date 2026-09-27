/** Mirrors public/scripts/tokenizers.js's `tokenizers` enum exactly. */
export const tokenizers = {
    NONE: 0,
    GPT2: 1,
    OPENAI: 2,
    LLAMA: 3,
    NERD: 4,
    NERD2: 5,
    API_CURRENT: 6,
    MISTRAL: 7,
    YI: 8,
    API_TEXTGENERATIONWEBUI: 9,
    API_KOBOLD: 10,
    CLAUDE: 11,
    LLAMA3: 12,
    GEMMA: 13,
    JAMBA: 14,
    QWEN2: 15,
    COMMAND_R: 16,
    NEMO: 17,
    DEEPSEEK: 18,
    COMMAND_A: 19,
    BEST_MATCH: 99,
    // Registry entries (src/tokenizer-sources.js), from 1000 up, above upstream's range. A value is
    // fixed forever once shipped: never renumbered, reused or removed.
    QWEN3: 1000,
    LLAMA3_1: 1001,
    NEMO_TEKKEN: 1002,
    KIMI: 1003,
    QWEN2_VL: 1004,
    QWEN2_5: 1005,
    QWEN3_5: 1006,
    QWEN3_5_BASE: 1007,
    QWEN3_8: 1008,
    CODEQWEN1_5: 1009,
    DEEPSEEK_V2: 1010,
    DEEPSEEK_V2_5: 1011,
    DEEPSEEK_R1: 1012,
    DEEPSEEK_V3_1: 1013,
    DEEPSEEK_V3_2: 1014,
    DEEPSEEK_V4: 1015,
    DEEPSEEK_V4_1: 1016,
    DEEPSEEK_R1_DISTILL_QWEN: 1017,
    DEEPSEEK_R1_DISTILL_LLAMA: 1018,
    DEEPSEEK_R1_0528_QWEN3: 1019,
};

/**
 * Numeric tokenizer enum -> string key used by encodeTextByLocalTokenizerType() and the
 * '/api/tokenizers/<key>/encode' routes. Derived from the string segment of each entry's `encode`
 * URL in public/scripts/tokenizers.js's TOKENIZER_URLS. Only covers tokenizer types that have a
 * local encoder (i.e. every ENCODE_TOKENIZERS entry, plus CLAUDE, GPT2, NERD and NERD2, which also
 * have real local encoders even though they're not in ENCODE_TOKENIZERS - that list is about the
 * UI's encode/decode playground, not about what's locally encodable).
 *
 * A registry value's key is instead its src/tokenizer-sources.js entry id, which has no local type
 * or route of its own.
 */
export const TOKENIZER_TYPE_KEYS = {
    [tokenizers.GPT2]: 'gpt2',
    [tokenizers.LLAMA]: 'llama',
    [tokenizers.NERD]: 'nerdstash',
    [tokenizers.NERD2]: 'nerdstash_v2',
    [tokenizers.MISTRAL]: 'mistral',
    [tokenizers.YI]: 'yi',
    [tokenizers.CLAUDE]: 'claude',
    [tokenizers.LLAMA3]: 'llama3',
    [tokenizers.GEMMA]: 'gemma',
    [tokenizers.JAMBA]: 'jamba',
    [tokenizers.QWEN2]: 'qwen2',
    [tokenizers.COMMAND_R]: 'command-r',
    [tokenizers.COMMAND_A]: 'command-a',
    [tokenizers.NEMO]: 'nemo',
    [tokenizers.DEEPSEEK]: 'deepseek',
    [tokenizers.QWEN3]: 'qwen3',
    [tokenizers.LLAMA3_1]: 'llama3.1',
    [tokenizers.NEMO_TEKKEN]: 'nemo-tekken',
    [tokenizers.KIMI]: 'kimi',
    [tokenizers.QWEN2_VL]: 'qwen2-vl',
    [tokenizers.QWEN2_5]: 'qwen2.5',
    [tokenizers.QWEN3_5]: 'qwen3.5',
    [tokenizers.QWEN3_5_BASE]: 'qwen3.5-base',
    [tokenizers.QWEN3_8]: 'qwen3.8',
    [tokenizers.CODEQWEN1_5]: 'codeqwen1.5',
    [tokenizers.DEEPSEEK_V2]: 'deepseek-v2',
    [tokenizers.DEEPSEEK_V2_5]: 'deepseek-v2.5',
    [tokenizers.DEEPSEEK_R1]: 'deepseek-r1',
    [tokenizers.DEEPSEEK_V3_1]: 'deepseek-v3.1',
    [tokenizers.DEEPSEEK_V3_2]: 'deepseek-v3.2',
    [tokenizers.DEEPSEEK_V4]: 'deepseek-v4',
    [tokenizers.DEEPSEEK_V4_1]: 'deepseek-v4.1',
    [tokenizers.DEEPSEEK_R1_DISTILL_QWEN]: 'deepseek-r1-distill-qwen',
    [tokenizers.DEEPSEEK_R1_DISTILL_LLAMA]: 'deepseek-r1-distill-llama',
    [tokenizers.DEEPSEEK_R1_0528_QWEN3]: 'deepseek-r1-0528-qwen3',
};
