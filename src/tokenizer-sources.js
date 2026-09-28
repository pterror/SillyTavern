import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import fetch from 'node-fetch';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { readSecret, SECRET_KEYS } from './endpoints/secrets.js';
import { getConfigValue } from './util.js';

/**
 * @typedef {'hf-json' | 'sentencepiece' | 'tekken' | 'tiktoken'} TokenizerFileFormat
 */

/**
 * One place a registry entry's file can be downloaded from: a Hugging Face repo pinned to a commit, or
 * a `url` on a host with no revisions to pin, such as Cohere's `tokenizer_url` files. Only the entry's
 * `sha256` and `bytes` pin a `url` source, so a file changed there is a failed download of that source.
 * @typedef {object} TokenizerSource
 * @property {string} [repo] Hugging Face repo, `owner/name`
 * @property {string} [revision] Full 40-hex commit sha
 * @property {string} [path] File path inside the repo at that revision
 * @property {boolean} [gated] Whether the repo is gated. Only an official repo can be.
 * @property {string} [url] Instead of `repo`, `revision`, `path` and `gated`: the file's URL as its host publishes it
 * @property {string} [license] This source's license, when it isn't the entry's
 * @property {string} [licenseUrl] Given with `license`
 */

/**
 * One official tokenizer file. Every source of an entry serves the same bytes.
 * @typedef {object} TokenizerSourceEntry
 * @property {string} id
 * @property {string} family
 * @property {TokenizerFileFormat} format
 * @property {string} sha256 64-hex sha256 of the file
 * @property {number} bytes File size in bytes
 * @property {string} license License name, of every source that names none of its own
 * @property {string} licenseUrl
 * @property {readonly TokenizerSource[]} sources Tried in order: the model's own repo first, then verified
 * byte-identical copies. When several official repos ship the bytes, the ungated ones come first, the more
 * permissive license first among them.
 * @property {string} [nameNote] What the name's parentheses say instead of `official`: for a model whose
 * official files disagree, its HF `tokenizer.json` entry is `official, HF tokenizer.json`
 * @property {import('./tokenizer-loader.js').TiktokenConfig} [tiktoken] For the `tiktoken` format: how the repo's own code builds its encoding
 */

// Kimi's tokenization_kimi.py and the older tokenization_moonshot.py (Kimi-VL, Moonlight) build their
// encoding with this pattern and split the text the same way before encoding. Each repo's
// tokenizer_config.json names its special tokens.
const KIMI_PAT_STR = [
    String.raw`[\p{Han}]+`,
    String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?`,
    String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?`,
    String.raw`\p{N}{1,3}`,
    String.raw` ?[^\s\p{L}\p{N}]+[\r\n]*`,
    String.raw`\s*[\r\n]+`,
    String.raw`\s+(?!\S)`,
    String.raw`\s+`,
].join('|');

/**
 * A Kimi repo's tiktoken config.
 * @param {Record<string, number>} specialTokens The special tokens its tokenizer_config.json names
 * @param {object} [options]
 * @param {number} [options.reservedCount] Special ids reserved after the ranks: 256 in tokenization_kimi.py, 258 in tokenization_moonshot.py
 * @param {'all' | 'none'} [options.allowedSpecial] `none` for Kimi-K2-Base, whose encode reads special-token text as text
 * @returns {import('./tokenizer-loader.js').TiktokenConfig}
 */
function kimiTiktoken(specialTokens, { reservedCount = 256, allowedSpecial = 'all' } = {}) {
    return {
        patStr: KIMI_PAT_STR,
        specialTokens,
        reservedSpecialTokens: { start: 163584, count: reservedCount, name: '<|reserved_token_{id}|>' },
        allowedSpecial,
        split: { maxChars: 400000, maxRun: 25000 },
    };
}

const KIMI_K2_SPECIAL_TOKENS = {
    '[BOS]': 163584,
    '[EOS]': 163585,
    '<|im_end|>': 163586,
    '<|im_user|>': 163587,
    '<|im_assistant|>': 163588,
    '<|start_header_id|>': 163590,
    '<|end_header_id|>': 163591,
    '[EOT]': 163593,
    '<|im_system|>': 163594,
    '<|tool_calls_section_begin|>': 163595,
    '<|tool_calls_section_end|>': 163596,
    '<|tool_call_begin|>': 163597,
    '<|tool_call_argument_begin|>': 163598,
    '<|tool_call_end|>': 163599,
    '<|im_middle|>': 163601,
    '[UNK]': 163838,
    '[PAD]': 163839,
};
const KIMI_THINK_TOKENS = { '<think>': 163606, '</think>': 163607 };
const KIMI_MEDIA_TOKENS = { '<|media_content|>': 163603, '<|media_end|>': 163604, '<|media_pad|>': 163605 };

// Phi-3-small's tokenization_phi3_small.py builds its encoding from tiktoken's cl100k_base pattern (as
// tiktoken 0.14.0 has it) and its own special tokens, and encodes the whole text with all of them allowed.
const CL100K_PAT_STR = String.raw`'(?i:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}]?+\p{L}++|\p{N}{1,3}+| ?[^\s\p{L}\p{N}]++[\r\n]*+|\s++$|\s*[\r\n]|\s+(?!\S)|\s`;
const PHI_3_SMALL_SPECIAL_TOKENS = {
    '<|dummy_id_2|>': 100256,
    '<|endoftext|>': 100257,
    '<|fim_prefix|>': 100258,
    '<|fim_middle|>': 100259,
    '<|fim_suffix|>': 100260,
    '<|system|>': 100261,
    '<|user|>': 100262,
    '<|assistant|>': 100263,
    '<|dummy_id_0|>': 100264,
    '<|dummy_id_1|>': 100265,
    '<|end|>': 100266,
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`<|dummy_id_${3 + i}|>`, 100267 + i])),
    '<|endofprompt|>': 100276,
    ...Object.fromEntries(Array.from({ length: 75 }, (_, i) => [`<|dummy_id_${12 + i}|>`, 100277 + i])),
};

/**
 * The pinned tokenizer registry. A fixed list in code: disk and memory are bounded by it, not by user data.
 * @type {readonly TokenizerSourceEntry[]}
 */
export const TOKENIZER_SOURCES = Object.freeze([
    {
        id: 'qwen3',
        family: 'Qwen3',
        format: 'hf-json',
        sha256: 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4',
        bytes: 11422654,
        license: 'Apache-2.0',
        licenseUrl: 'https://huggingface.co/Qwen/Qwen3-8B/blob/b968826d9c46dd6066d109eabc6255188de91218/LICENSE',
        sources: [
            { repo: 'Qwen/Qwen3-8B', revision: 'b968826d9c46dd6066d109eabc6255188de91218', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'llama3.1',
        family: 'Llama 3.1',
        format: 'hf-json',
        sha256: '79e3e522635f3171300913bb421464a87de6222182a0570b9b2ccba2a964b2b4',
        bytes: 9085657,
        license: 'Llama 3.1 Community License',
        licenseUrl: 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct/blob/0e9e39f249a16976918f6564b8830bc894c89659/LICENSE',
        sources: [
            { repo: 'meta-llama/Llama-3.1-8B-Instruct', revision: '0e9e39f249a16976918f6564b8830bc894c89659', path: 'tokenizer.json', gated: true },
            { repo: 'nvidia/Llama-3.1-Nemotron-70B-Instruct-HF', revision: '031d4042f36adc1a52cca51b331d25cbe3cf1022', path: 'tokenizer.json', gated: false },
            { repo: 'NousResearch/Meta-Llama-3.1-8B-Instruct', revision: 'd10aef7999a2b5ba950ab3974312feeedbfe0b77', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'nemo-tekken',
        family: 'Mistral Nemo',
        format: 'tekken',
        sha256: 'eccd1665d2e477697c33cb7f0daa6f6dfefc57a0a6bceb66d4be52952f827516',
        bytes: 14801223,
        license: 'Apache-2.0',
        // The pinned revision has no LICENSE file; its model card declares apache-2.0.
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'mistralai/Mistral-Nemo-Instruct-2407', revision: '04d8a90549d23fc6bd7f642064003592df51e9b3', path: 'tekken.json', gated: false },
        ],
    },
    {
        id: 'kimi',
        family: 'Kimi K2',
        format: 'tiktoken',
        sha256: 'b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103',
        bytes: 2795286,
        license: 'MIT',
        licenseUrl: 'https://opensource.org/license/mit',
        sources: [
            { repo: 'moonshotai/Kimi-Linear-48B-A3B-Base', revision: '3b171c17bfc4ee348599b6781a2ca8715c21c8dc', path: 'tiktoken.model', gated: false },
            { repo: 'moonshotai/Kimi-Linear-48B-A3B-Instruct', revision: 'e1df551a447157d4658b573f9a695d57658590e9', path: 'tiktoken.model', gated: false },
            { repo: 'moonshotai/Kimi-K2-Instruct', revision: 'fd1984e2b7a3350dbf7305fe73a4ede25c14de50', path: 'tiktoken.model', gated: false, license: 'Modified MIT License (model card: other)', licenseUrl: 'https://huggingface.co/moonshotai/Kimi-K2-Instruct/blob/fd1984e2b7a3350dbf7305fe73a4ede25c14de50/LICENSE' },
            { repo: 'moonshotai/Kimi-K2-Instruct-0905', revision: 'ac6c49f04883bd0a0598b790693a72061c676629', path: 'tiktoken.model', gated: false, license: 'Modified MIT License (model card: other)', licenseUrl: 'https://huggingface.co/moonshotai/Kimi-K2-Instruct-0905/blob/ac6c49f04883bd0a0598b790693a72061c676629/LICENSE' },
        ],
        tiktoken: kimiTiktoken(KIMI_K2_SPECIAL_TOKENS),
    },
    {
        id: 'qwen2-vl',
        family: 'Qwen2-VL',
        format: 'hf-json',
        sha256: 'cb63a0a23eef3d5b01063a9880a1925a65aaf4d1591d519910ee3527852950a0',
        bytes: 7029741,
        license: 'Apache-2.0',
        licenseUrl: 'https://huggingface.co/Qwen/Qwen2-VL-7B-Instruct/blob/eed13092ef92e448dd6875b2a00151bd3f7db0ac/LICENSE',
        sources: [
            { repo: 'Qwen/Qwen2-VL-7B-Instruct', revision: 'eed13092ef92e448dd6875b2a00151bd3f7db0ac', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'qwen2.5',
        family: 'Qwen2.5',
        format: 'hf-json',
        sha256: 'c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539',
        bytes: 7031645,
        license: 'Apache-2.0',
        licenseUrl: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct/blob/a09a35458c702b33eeacc393d103063234e8bc28/LICENSE',
        sources: [
            { repo: 'Qwen/Qwen2.5-7B-Instruct', revision: 'a09a35458c702b33eeacc393d103063234e8bc28', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'qwen3.5',
        family: 'Qwen3.5/3.6',
        format: 'hf-json',
        sha256: '5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42',
        bytes: 12807982,
        license: 'Apache-2.0',
        licenseUrl: 'https://huggingface.co/Qwen/Qwen3.5-9B/blob/c202236235762e1c871ad0ccb60c8ee5ba337b9a/LICENSE',
        sources: [
            { repo: 'Qwen/Qwen3.5-9B', revision: 'c202236235762e1c871ad0ccb60c8ee5ba337b9a', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'qwen3.5-base',
        family: 'Qwen3.5 base',
        format: 'hf-json',
        sha256: 'fe000e3ed39ed12b8d2481d527d44f93c65d37e87645d2dcc80d1bf9d50d2927',
        bytes: 12807196,
        license: 'Apache-2.0',
        licenseUrl: 'https://huggingface.co/Qwen/Qwen3.5-9B-Base/blob/68c46c4b3498877f3ef123c856ecfde50c39f404/LICENSE',
        sources: [
            { repo: 'Qwen/Qwen3.5-9B-Base', revision: '68c46c4b3498877f3ef123c856ecfde50c39f404', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'qwen3.8',
        family: 'Qwen3.8',
        format: 'hf-json',
        sha256: '0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3',
        bytes: 12809320,
        license: 'Apache-2.0',
        licenseUrl: 'https://huggingface.co/Qwen/Qwen3.8-27B/blob/1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0/LICENSE',
        sources: [
            { repo: 'Qwen/Qwen3.8-27B', revision: '1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'codeqwen1.5',
        family: 'CodeQwen1.5',
        format: 'hf-json',
        sha256: '76e125407daec8387eb5ce9bd8b6c455d2e96604f0b70219d73409b1b64d74fc',
        bytes: 4462887,
        license: 'Tongyi Qianwen LICENSE AGREEMENT (model card: tongyi-qianwen-research)',
        licenseUrl: 'https://huggingface.co/Qwen/CodeQwen1.5-7B/blob/5ce5a1554e50a9e3bb236de7c0b8a2a1746186e4/LICENSE',
        sources: [
            { repo: 'Qwen/CodeQwen1.5-7B', revision: '5ce5a1554e50a9e3bb236de7c0b8a2a1746186e4', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'deepseek-v2',
        family: 'DeepSeek-V2',
        format: 'hf-json',
        sha256: '41f3bf64213da8c012d8bd0871a58a1fdf70463e8f08f110ddbb1082f529f669',
        bytes: 4607451,
        license: 'DEEPSEEK LICENSE AGREEMENT (model card: other)',
        licenseUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-V2-Chat/blob/8e3f5f6c2226787e41ba3e9283a06389d178c926/LICENSE',
        sources: [
            { repo: 'deepseek-ai/DeepSeek-V2-Chat', revision: '8e3f5f6c2226787e41ba3e9283a06389d178c926', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'deepseek-v2.5',
        family: 'DeepSeek-V2.5',
        format: 'hf-json',
        sha256: '091b9dadb9845f0e8386c38bdb87e98db8adc7b0aacf36cb9257c00d0a668714',
        bytes: 4610628,
        license: 'DEEPSEEK LICENSE AGREEMENT (model card: other)',
        licenseUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-V2.5/blob/c85b5ede86f2a598af339624cac5723861e557ed/LICENSE',
        sources: [
            { repo: 'deepseek-ai/DeepSeek-V2.5', revision: 'c85b5ede86f2a598af339624cac5723861e557ed', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'deepseek-r1',
        family: 'DeepSeek-R1',
        format: 'hf-json',
        sha256: 'ecb6f9fc369894346f0511f4074ca75cee5cd5f3b06d02f1ba35fcd39f8e121d',
        bytes: 7847602,
        license: 'MIT',
        licenseUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-R1/blob/56d4cbbb4d29f4355bab4b9a39ccb717a14ad5ad/LICENSE',
        sources: [
            { repo: 'deepseek-ai/DeepSeek-R1', revision: '56d4cbbb4d29f4355bab4b9a39ccb717a14ad5ad', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'deepseek-v3.1',
        family: 'DeepSeek-V3.1',
        format: 'hf-json',
        sha256: '32b34a41212e92f62e859cbbea121ae705a1fabbf157d9acf22d134ecd8dcf70',
        bytes: 7847578,
        license: 'MIT',
        licenseUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-V3.1/blob/c0781d039fb7a1ba2abc4add0bdc293e92d2b8db/LICENSE',
        sources: [
            { repo: 'deepseek-ai/DeepSeek-V3.1', revision: 'c0781d039fb7a1ba2abc4add0bdc293e92d2b8db', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'deepseek-v3.2',
        family: 'DeepSeek-V3.2',
        format: 'hf-json',
        sha256: 'cd050be35cae877f8f0aa847f45aa87e23835a56ca32b29b28545597852784e5',
        bytes: 7847502,
        license: 'MIT',
        licenseUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-V3.2/blob/a7e62ac04ecb2c0a54d736dc46601c5606cf10a6/LICENSE',
        sources: [
            { repo: 'deepseek-ai/DeepSeek-V3.2', revision: 'a7e62ac04ecb2c0a54d736dc46601c5606cf10a6', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'deepseek-v4',
        family: 'DeepSeek-V4',
        format: 'hf-json',
        sha256: '8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf',
        bytes: 6367146,
        license: 'MIT',
        licenseUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/blob/b5968e9190ef611bbf34a7229255be88a0e937c1/LICENSE',
        sources: [
            { repo: 'deepseek-ai/DeepSeek-V4-Pro', revision: 'b5968e9190ef611bbf34a7229255be88a0e937c1', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'deepseek-v4.1',
        family: 'DeepSeek-V4.1',
        format: 'hf-json',
        sha256: 'c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b',
        bytes: 6367257,
        license: 'MIT',
        licenseUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/dba1be0a40aa45a94ad051997016db3960a90277/LICENSE',
        sources: [
            { repo: 'deepseek-ai/DeepSeek-V4.1-Flash', revision: 'dba1be0a40aa45a94ad051997016db3960a90277', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'deepseek-r1-distill-qwen',
        family: 'DeepSeek-R1-Distill-Qwen',
        format: 'hf-json',
        sha256: '88145e3c3249adc2546ede277e9819d6e405e19072456e4b521cbc724bd60773',
        bytes: 7031660,
        license: 'MIT',
        licenseUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B/blob/916b56a44061fd5cd7d6a8fb632557ed4f724f60/LICENSE',
        sources: [
            { repo: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', revision: '916b56a44061fd5cd7d6a8fb632557ed4f724f60', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'deepseek-r1-distill-llama',
        family: 'DeepSeek-R1-Distill-Llama',
        format: 'hf-json',
        sha256: 'b9c9eb63a8e03059914880f918cd28a880dec8b6e15e4461e1ff677e3743dbb8',
        bytes: 9084480,
        license: 'MIT',
        licenseUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Llama-8B/blob/6a6f4aa4197940add57724a7707d069478df56b1/LICENSE',
        sources: [
            { repo: 'deepseek-ai/DeepSeek-R1-Distill-Llama-8B', revision: '6a6f4aa4197940add57724a7707d069478df56b1', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'deepseek-r1-0528-qwen3',
        family: 'DeepSeek-R1-0528-Qwen3',
        format: 'hf-json',
        sha256: '47d3a3ffb1ff38eb6a22f8a2d207306bfa3ea2499ff70df4baeaa559bf7453c7',
        bytes: 7032822,
        license: 'MIT',
        licenseUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-R1-0528-Qwen3-8B/blob/6e8885a6ff5c1dc5201574c8fd700323f23c25fa/LICENSE',
        sources: [
            { repo: 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B', revision: '6e8885a6ff5c1dc5201574c8fd700323f23c25fa', path: 'tokenizer.json', gated: false },
        ],
    },
    // No Gemma repo has a LICENSE file; each license is its model card's.
    {
        id: 'gemma-4',
        family: 'Gemma 4',
        format: 'hf-json',
        sha256: 'cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f',
        bytes: 32169626,
        license: 'Apache-2.0',
        licenseUrl: 'https://ai.google.dev/gemma/docs/gemma_4_license',
        sources: [
            { repo: 'google/gemma-4-31B-it', revision: '842da3794eaa0b77d5f08bae87a17459d91ff475', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'gemma-4-assistant',
        family: 'Gemma 4 assistant',
        format: 'hf-json',
        sha256: '75a6583c1a418e2bbd79c60d95d28e0f5bf549ad3f2990b5bdb5238c6c2bf70c',
        bytes: 32169440,
        license: 'Apache-2.0',
        licenseUrl: 'https://ai.google.dev/gemma/docs/gemma_4_license',
        sources: [
            { repo: 'google/gemma-4-31B-it-assistant', revision: '627c5ec1458b9086b841a91e0512fd31fd2fbbf1', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'gemma-3-it',
        family: 'Gemma 3 it',
        format: 'hf-json',
        sha256: '4667f2089529e8e7657cfb6d1c19910ae71ff5f28aa7ab2ff2763330affad795',
        bytes: 33384568,
        license: 'Gemma Terms of Use',
        licenseUrl: 'https://ai.google.dev/gemma/terms',
        sources: [
            { repo: 'google/gemma-3-27b-it', revision: '005ad3404e59d6023443cb575daa05336842228a', path: 'tokenizer.json', gated: true },
            { repo: 'unsloth/gemma-3-27b-it', revision: '7a5a3053dbd5d1d58e48159e87b9df2fc545a49a', path: 'tokenizer.json', gated: false },
            { repo: 'unsloth/gemma-3-12b-it', revision: '9478e665381f42974aa06177b019352fb6291876', path: 'tokenizer.json', gated: false },
            { repo: 'unsloth/gemma-3-4b-it', revision: 'bf46152c47f5dd20b896357cb51abc4c03b8ee8c', path: 'tokenizer.json', gated: false },
            { repo: 'unsloth/gemma-3-1b-it', revision: '5b11413a10db4e486ef16a20101fd028f8f2499c', path: 'tokenizer.json', gated: false },
            { repo: 'mlx-community/gemma-3-12b-it-bf16', revision: 'b8b9b412cb795bd6115fdce8c9a0ef0d1664db3a', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'gemma-3-pt',
        family: 'Gemma 3 pt',
        format: 'hf-json',
        sha256: '7d4046bf0505a327dd5a0abbb427ecd4fc82f99c2ceaa170bc61ecde12809b0c',
        bytes: 33384570,
        license: 'Gemma Terms of Use',
        licenseUrl: 'https://ai.google.dev/gemma/terms',
        sources: [
            { repo: 'google/gemma-3-27b-pt', revision: '9fe3c4ebc93fbadb14913801536d022054ef11cc', path: 'tokenizer.json', gated: true },
            { repo: 'axolotl-mirrors/gemma-3-4b-pt', revision: '8b15dff57cf732924410f7ba4121a34d2ff1b787', path: 'tokenizer.json', gated: false },
            { repo: 'unsloth/gemma-3-12b-it-qat-int4', revision: '3f8614ebde450ed4951e32a5d2ec4046d29e8a82', path: 'tokenizer.json', gated: false },
            { repo: 'Lightricks/gemma-3-12b-it-qat-q4_0-unquantized', revision: 'd62fe4f1995ade703b49a0f3c0d0f161237ef437', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'gemma-3n',
        family: 'Gemma 3n',
        format: 'hf-json',
        sha256: 'c4c19736bf24d1c6805cf49340e31bd02c70fb7857a2cb31065c90c2b5719c4e',
        bytes: 33442559,
        license: 'Gemma Terms of Use',
        licenseUrl: 'https://ai.google.dev/gemma/terms',
        sources: [
            { repo: 'google/gemma-3n-E4B-it', revision: 'c1221e9c62e34a43ab7ffacd1be0ea71f126ef10', path: 'tokenizer.json', gated: true },
            { repo: 'huihui-ai/Huihui-gemma-3n-E4B-it-abliterated', revision: '41baa2bf7d97a5a7e18a4943a5a896e9f4cea529', path: 'tokenizer.json', gated: false },
            { repo: 'h4shy/gemma-3n-E2B-prototype-pytorch', revision: '58fabd53c32f19f8a6692185f58b00147b23d255', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'codegemma',
        family: 'CodeGemma',
        format: 'hf-json',
        sha256: '3f8311e1140366e2d063d2f47f5af652e2cce5fdda518a7e5cb7d74524744f7f',
        bytes: 17525399,
        license: 'Gemma Terms of Use',
        licenseUrl: 'https://ai.google.dev/gemma/terms',
        sources: [
            { repo: 'google/codegemma-7b-it', revision: '078cdc51070553d1636d645c9a238f3b0914459a', path: 'tokenizer.json', gated: true },
            { repo: 'unsloth/codegemma-7b-it', revision: 'f1f500be8b896ae964017b4a3016ea6e47ea09bd', path: 'tokenizer.json', gated: false },
            { repo: 'unsloth/codegemma-7b', revision: '93a0a77812489f06719a5d4b592ffa838ed32cc9', path: 'tokenizer.json', gated: false },
            { repo: 'unsloth/codegemma-2b', revision: '5903569be58fd5a967ef10e9b8ffacbf2f7690dd', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'gemma-2-jpn',
        family: 'Gemma 2 JPN',
        format: 'hf-json',
        sha256: '7fa178a85ecd933ead78169c82e42ff18f5d1e3e5b4432bfaff18342e0bb9993',
        bytes: 17525369,
        license: 'Gemma Terms of Use',
        licenseUrl: 'https://ai.google.dev/gemma/terms',
        sources: [
            { repo: 'google/gemma-2-2b-jpn-it', revision: '6b046bbc091084a1ec89fe03e58871fde10868eb', path: 'tokenizer.json', gated: true },
            { repo: 'mlx-community/gemma-2-2b-jpn-it', revision: 'e285d1d456c728b18f74e4896ad99b3c0b5ef9f0', path: 'tokenizer.json', gated: false },
            { repo: 'onnx-community/gemma-2-2b-jpn-it', revision: '4f59e472cb40c9ea2a01900695a60b8104332fc8', path: 'tokenizer.json', gated: false },
        ],
    },
    // A copy is listed under the file it carries, whatever its repo is called.
    {
        id: 'llama3.1-base',
        family: 'Llama 3.1 base',
        format: 'hf-json',
        sha256: '76e48799b099d43365bd24ccd8ecc5aedac831718da780552f03b0a6eb4412aa',
        bytes: 9085658,
        license: 'LLAMA 3.1 COMMUNITY LICENSE AGREEMENT',
        licenseUrl: 'https://huggingface.co/meta-llama/Llama-3.1-8B/blob/d04e592bb4f6aa9cfee91e2e20afa771667e1d4b/LICENSE',
        sources: [
            { repo: 'meta-llama/Llama-3.1-8B', revision: 'd04e592bb4f6aa9cfee91e2e20afa771667e1d4b', path: 'tokenizer.json', gated: true },
            { repo: 'NousResearch/Meta-Llama-3.1-8B', revision: '1f47e50cdbe801ad8a5174156ec3a0655108fb9f', path: 'tokenizer.json', gated: false },
            { repo: 'NousResearch/Meta-Llama-3.1-70B', revision: 'beb678ba5bd7eb1aafeffa01e2a2b3b5e93d1dd3', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'llama3.3',
        family: 'Llama 3.3',
        format: 'hf-json',
        sha256: '6b9e4e7fb171f92fd137b777cc2714bf87d11576700a1dcd7a399e7bbe39537b',
        bytes: 17209920,
        license: 'LLAMA 3.3 COMMUNITY LICENSE AGREEMENT',
        licenseUrl: 'https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct/blob/6f6073b423013f6a7d4d9f39144961bfbfbc386b/LICENSE',
        sources: [
            { repo: 'meta-llama/Llama-3.3-70B-Instruct', revision: '6f6073b423013f6a7d4d9f39144961bfbfbc386b', path: 'tokenizer.json', gated: true },
            { repo: 'NousResearch/DeepHermes-3-Llama-3-8B-Preview', revision: '53d902c7dcfa4c749a3b455149064f82af2e2549', path: 'tokenizer.json', gated: false },
            { repo: 'unsloth/Llama-3.1-70B', revision: '99f146c778e0de3b687d83191faf41e49198f2ca', path: 'tokenizer.json', gated: false },
            // NVIDIA's repos of Llama-based models that ship this file. They have no LICENSE file; their model cards name this license.
            { repo: 'nvidia/Llama-3.1-Nemotron-Nano-4B-v1.1', revision: 'd552708a9d575fa8d4a690b988fd870d65279f98', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/Llama-3.1-Nemotron-Nano-8B-v1', revision: '54641c1611fcff44fa4865626462445e0a153fc7', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/Llama-3.1-Nemotron-Safety-Guard-8B-v3', revision: '8fdc246ba3d56db9c469d534233b9f582d3afafa', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/Llama-3_1-Nemotron-Ultra-253B-CPT-v1', revision: '00e37b5d4ed5e05618ed7ad1e445dfa446a47941', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/Llama-3_1-Nemotron-Ultra-253B-v1', revision: '5b47def5b8957142d82faeb44bfad9349d02840d', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/Llama-3_3-Nemotron-Super-49B-GenRM', revision: '3160979309e0ed1e2c57d570c4bf0d4052014a5d', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/Llama-3_3-Nemotron-Super-49B-GenRM-Multilingual', revision: '334fda42b57f89f4e3299ee044070b5a27817f0d', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/Llama-3_3-Nemotron-Super-49B-v1', revision: '387156d8d6868c19f3472fa607aa9bfc4f662333', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/Llama-3_3-Nemotron-Super-49B-v1_5', revision: '420ba7d28211abf116b8b103ab700d92619daf98', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/Llama-3_3-Nemotron-Super-49B-v1_5-FP8', revision: '04822723e77e036ddf2d24e83c6d469d3b009252', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/Llama-3_3-Nemotron-Super-49B-v1_5-NVFP4', revision: 'f0caaafd5152e07527c7a14e04aa67823107529f', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
        ],
    },
    {
        id: 'llama4',
        family: 'Llama 4',
        format: 'hf-json',
        sha256: '172c9eb4beafc72601690da3ccfcede5c2e6806a8d5ec1fca33e22acea8023a4',
        bytes: 27948578,
        license: 'LLAMA 4 COMMUNITY LICENSE AGREEMENT (model card: other)',
        licenseUrl: 'https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct/blob/92f3b1597a195b523d8d9e5700e57e4fbb8f20d3/LICENSE',
        sources: [
            { repo: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', revision: '92f3b1597a195b523d8d9e5700e57e4fbb8f20d3', path: 'tokenizer.json', gated: true },
            { repo: 'unsloth/Llama-4-Maverick-17B-128E-Instruct', revision: '86c5ecb6f2fbddf604c60120125fb202e09f2556', path: 'tokenizer.json', gated: false },
            { repo: 'mlx-community/Llama-4-Scout-17B-16E-4bit', revision: '3ab5fc990be55246c320529fcfb966ebc7bf69ae', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'llama-guard-3-8b',
        family: 'Llama Guard 3 8B',
        format: 'hf-json',
        sha256: 'bbc1904d35169c542dffbe1f7589a5994ec7426d9e5b609d07bab876f32e97ab',
        bytes: 9084449,
        license: 'LLAMA 3.1 COMMUNITY LICENSE AGREEMENT',
        licenseUrl: 'https://huggingface.co/meta-llama/Llama-Guard-3-8B/blob/7327bd9f6efbbe6101dc6cc4736302b3cbb6e425/LICENSE',
        sources: [
            { repo: 'meta-llama/Llama-Guard-3-8B', revision: '7327bd9f6efbbe6101dc6cc4736302b3cbb6e425', path: 'tokenizer.json', gated: true },
            { repo: 'mlx-community/Meta-Llama-3.1-70B-Instruct-8bit', revision: '4cc2a3b52165141ca9e586baa2a7e67e2a1293bd', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'llama-guard-3-11b-vision',
        family: 'Llama Guard 3 11B Vision',
        format: 'hf-json',
        sha256: '812cb1fb0f00590a387d5b6a281fc26bc4971136b1d7391a1d19576939f01d45',
        bytes: 9084616,
        license: 'LLAMA 3.2 COMMUNITY LICENSE AGREEMENT',
        licenseUrl: 'https://huggingface.co/meta-llama/Llama-Guard-3-11B-Vision/blob/62d4275543ec7503de66c486de1c0c2103e365ac/LICENSE.txt',
        sources: [
            { repo: 'meta-llama/Llama-Guard-3-11B-Vision', revision: '62d4275543ec7503de66c486de1c0c2103e365ac', path: 'tokenizer.json', gated: true },
            { repo: 'SinclairSchneider/Llama-Guard-3-11B-Vision', revision: '946557f26166ca4b3599435c10afab3d40e69525', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'llama-guard-2',
        family: 'Llama Guard 2',
        format: 'hf-json',
        sha256: 'c05a3c2174e9edd5be19dc5a0748c42a9037bec2811ce062728bfd71f8702d78',
        bytes: 9084490,
        license: 'META LLAMA 3 COMMUNITY LICENSE AGREEMENT',
        licenseUrl: 'https://huggingface.co/meta-llama/Meta-Llama-Guard-2-8B/blob/7d257f3c1a0ec6ed99b2cb715027149dfb9784ef/LICENSE',
        sources: [
            { repo: 'meta-llama/Meta-Llama-Guard-2-8B', revision: '7d257f3c1a0ec6ed99b2cb715027149dfb9784ef', path: 'tokenizer.json', gated: true },
            { repo: 'nvidia/Llama3-ChatQA-1.5-8B', revision: '3b98162e3f97550d62aeeb19ea50208f968c678a', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'llama-guard-4',
        family: 'Llama Guard 4',
        format: 'hf-json',
        sha256: '22e009b4fcb58eddbabf347e71b9881ea1e6eb72d44e5ea9477c7587df68fd8d',
        bytes: 27948580,
        license: 'LLAMA 4 COMMUNITY LICENSE AGREEMENT (model card: other)',
        licenseUrl: 'https://huggingface.co/meta-llama/Llama-Guard-4-12B/blob/87acb4b94e930c3d679e6e7ee9d57e2feab9ea71/LICENSE',
        sources: [
            { repo: 'meta-llama/Llama-Guard-4-12B', revision: '87acb4b94e930c3d679e6e7ee9d57e2feab9ea71', path: 'tokenizer.json', gated: true },
            { repo: 'unsloth/Llama-Guard-4-12B', revision: '07ebbb7bdc44fb45bf710a9a69a82c088085f0c8', path: 'tokenizer.json', gated: false },
        ],
    },
    // Mistral's native files (tokenizer.model.v*) and its repos' HF tokenizer.json files, which give other
    // ids. Only the Modified MIT repos have a LICENSE file; the others' licenses
    // are their model cards'.
    {
        id: 'mistral-7b-v0.3',
        family: 'Mistral 7B v0.3',
        format: 'sentencepiece',
        sha256: '37f00374dea48658ee8f5d0f21895b9bc55cb0103939607c8185bfd1c6ca1f89',
        bytes: 587404,
        license: 'Apache-2.0',
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'mistralai/Mistral-7B-Instruct-v0.3', revision: 'c170c708c41dac9275d15a8fff4eca08d52bab71', path: 'tokenizer.model.v3', gated: false },
            { repo: 'mistralai/Mistral-7B-v0.3', revision: 'caa1feb0e54d415e2df31207e5f4e273e33509b1', path: 'tokenizer.model.v3', gated: false },
            { repo: 'mistralai/Mixtral-8x22B-Instruct-v0.1', revision: 'cc88a6cc19fbd17d9f1c0ee0b0d70a748dce698d', path: 'tokenizer.model.v3', gated: false },
        ],
    },
    {
        id: 'mathstral',
        family: 'Mathstral',
        format: 'sentencepiece',
        sha256: '59f95e28944c062244741268596badc900df86c7f5ded05088d2da22a7379e06',
        bytes: 587583,
        license: 'Apache-2.0',
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'mistralai/Mathstral-7B-v0.1', revision: 'ec3a48484ef241dfe03282edcb0f25e564923823', path: 'tokenizer.model.v3', gated: false },
            { repo: 'mistralai/Mamba-Codestral-7B-v0.1', revision: '4f086c08c1e0f07bdc50ca25125dbbf7475d21da', path: 'tokenizer.model.v3', gated: false },
            { repo: 'mistralai/Mistral-Small-Instruct-2409', revision: '4600506f6b13c7ef89e61a54263f4c9bf483de30', path: 'tokenizer.model.v3', gated: false, license: 'Mistral AI Research License', licenseUrl: 'https://mistral.ai/licenses/MRL-0.1.md' },
            { repo: 'mistralai/Mistral-Large-Instruct-2407', revision: 'a286006d554cb37a61d13c7ae61bc90cc1d372fc', path: 'tokenizer.model.v3', gated: true, license: 'Mistral AI Research License', licenseUrl: 'https://mistral.ai/licenses/MRL-0.1.md' },
        ],
    },
    {
        id: 'mistral-large-2411',
        family: 'Mistral Large 2411',
        format: 'sentencepiece',
        sha256: '1b968b8dc352f42192367337c78ccc61e1eaddc6d641a579372d4f20694beb7a',
        bytes: 587562,
        license: 'Mistral AI Research License',
        licenseUrl: 'https://mistral.ai/licenses/MRL-0.1.md',
        sources: [
            { repo: 'mistralai/Mistral-Large-Instruct-2411', revision: 'ba78820945ae22361b0274cf0ae6d696c967c1a4', path: 'tokenizer.model.v7', gated: false },
            { repo: 'mistralai/Pixtral-Large-Instruct-2411', revision: 'c1e51f6f11974a1199685d35c62f5a425c2d001e', path: 'tokenizer.model.v7m1', gated: false },
        ],
    },
    {
        id: 'mistral-7b-v0.3-hf',
        family: 'Mistral 7B v0.3',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: 'e553af6fff7d7ad76e830608b218c5c0b0822998d5a1a96099a74cd3c1cb1a49',
        bytes: 1961548,
        license: 'Apache-2.0',
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'mistralai/Mistral-7B-Instruct-v0.3', revision: 'c170c708c41dac9275d15a8fff4eca08d52bab71', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Mistral-7B-v0.3', revision: 'caa1feb0e54d415e2df31207e5f4e273e33509b1', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Mixtral-8x22B-Instruct-v0.1', revision: 'cc88a6cc19fbd17d9f1c0ee0b0d70a748dce698d', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'codestral-22b-hf',
        family: 'Codestral 22B',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: '5bbd20ebc1349f5e40b5e585330c6eb100810586de46ea22c830f7861eaa1fcc',
        bytes: 1962462,
        license: 'Mistral AI Non-Production License',
        licenseUrl: 'https://mistral.ai/licences/MNPL-0.1.md',
        sources: [
            { repo: 'mistralai/Codestral-22B-v0.1', revision: '28b1c1a51dabe9d86ca8c41420ada1984632498f', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'codestral-mamba-hf',
        family: 'Codestral Mamba',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: 'f9fb70f3b36291190d91add421a062b42ef517d43cdd2e1f32ca19e84096b4ca',
        bytes: 1961706,
        license: 'Apache-2.0',
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'mistralai/Mamba-Codestral-7B-v0.1', revision: '4f086c08c1e0f07bdc50ca25125dbbf7475d21da', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'mathstral-hf',
        family: 'Mathstral',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: '9af882e8e5c737c2062f6ae3dfdf113622400951677c9514a3219b25de42d0a7',
        bytes: 1961676,
        license: 'Apache-2.0',
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'mistralai/Mathstral-7B-v0.1', revision: 'ec3a48484ef241dfe03282edcb0f25e564923823', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'mistral-large-2411-hf',
        family: 'Mistral Large 2411',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: '2482d54bc351bc5f9ccc899ffd51b8d6cbe0fc1987e8a81a2d7c3670c0b666fc',
        bytes: 3672086,
        license: 'Mistral AI Research License',
        licenseUrl: 'https://mistral.ai/licenses/MRL-0.1.md',
        sources: [
            { repo: 'mistralai/Mistral-Large-Instruct-2411', revision: 'ba78820945ae22361b0274cf0ae6d696c967c1a4', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'ministral-8b-2410-hf',
        family: 'Ministral 8B 2410',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: 'd7edbeaf20dd7f571b5dd1c54d9ace4f9b6299127cc7ba2afb14a6d51a4a79a4',
        bytes: 17078136,
        license: 'Mistral AI Research License',
        licenseUrl: 'https://mistral.ai/licenses/MRL-0.1.md',
        sources: [
            { repo: 'mistralai/Ministral-8B-Instruct-2410', revision: '2f494a194c5b980dfb9772cb92d26cbb671fce5a', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'ministral-3-instruct-hf',
        family: 'Ministral 3 Instruct',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: '99cf274236c60277fcfad861a5a1007518687ad06ba8938760f50b55ffa0b1ef',
        bytes: 17077420,
        license: 'Apache-2.0',
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'mistralai/Ministral-3-14B-Instruct-2512', revision: '29439f81c2be264d8d393273f99e7db9c0961120', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Ministral-3-3B-Instruct-2512', revision: 'b35d4dfe56c142746f54dbd64f579faab2744308', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Ministral-3-8B-Instruct-2512', revision: '5b26027e7b19eeb4b7352e1fed3926375dd2cb4d', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Devstral-Small-2-24B-Instruct-2512', revision: '55c5b41e98c2dbd21b0c8afffc540dcfc9eb5128', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Devstral-2-123B-Instruct-2512', revision: '1613bf01adb5e1c6fdc196b46e6b173eae75eb4a', path: 'tokenizer.json', gated: false, license: 'Modified MIT License (model card: other)', licenseUrl: 'https://huggingface.co/mistralai/Devstral-2-123B-Instruct-2512/blob/1613bf01adb5e1c6fdc196b46e6b173eae75eb4a/LICENSE' },
        ],
    },
    {
        id: 'ministral-3-base-hf',
        family: 'Ministral 3 Base',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: '577575622324b2e099e2648be26bdeb5e5815ffe66d7004e9e3ddbf421db6bf1',
        bytes: 17078110,
        license: 'Apache-2.0',
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'mistralai/Ministral-3-14B-Base-2512', revision: '5b0ceedbb42dff466ae60b258ba296f32da51384', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Ministral-3-14B-Reasoning-2512', revision: '51f9210f3cd20f3452a80d5819d15dc61cc50630', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Ministral-3-3B-Base-2512', revision: '6f9c4b12a95b139af68670a6713616b757923735', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Ministral-3-3B-Reasoning-2512', revision: '4a36357c811bf511a7b625d132e12f22408aac91', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Ministral-3-8B-Base-2512', revision: 'd4883f9b36aa2e5d775730d3fdba3d30de51a8ef', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Ministral-3-8B-Reasoning-2512', revision: '81eaece1948f3875421d9a45bc55487d10e2d894', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Mistral-Large-3-675B-Base-2512', revision: '3123f82420d99a7fc9313b2d69f9a0ab6cb6ab4d', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Mistral-Large-3-675B-Instruct-2512', revision: '383ffea2c7d60dfd44ca960e8e691709d4fdb9cd', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Mistral-Large-3-675B-Instruct-2512-Eagle', revision: 'a2eec8837f6b4b2a434a5bbc27c534c9640aef89', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Mistral-Large-3-675B-Instruct-2512-NVFP4', revision: '6f01426c721bd365f29a108f2389782e9671aab2', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'mistral-small-4-hf',
        family: 'Mistral Small 4',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: '2ba5b3330fd84d5376fcca797cfb3b42eee6241ce23e3271e6fb2a115a8751bd',
        bytes: 17077420,
        license: 'Apache-2.0',
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'mistralai/Mistral-Small-4-119B-2603', revision: 'a11f36bebf709121056b1dbcc943d1c6afbe494d', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Mistral-Small-4-119B-2603-NVFP4', revision: '45331841b631f4e281df8e959ea3cc9beb84298a', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Mistral-Medium-3.5-128B', revision: '22b2b868a15677cfa6061277ed2f653d1349a9ab', path: 'tokenizer.json', gated: false, license: 'Modified MIT License (model card: other)', licenseUrl: 'https://huggingface.co/mistralai/Mistral-Medium-3.5-128B/blob/22b2b868a15677cfa6061277ed2f653d1349a9ab/LICENSE' },
        ],
    },
    {
        id: 'shieldstral-hf',
        family: 'Shieldstral',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: '9172cf28b79a17502736f971b560faeced38ee527540cea6882a1f40cce320c0',
        bytes: 17077322,
        license: 'Apache-2.0',
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'mistralai/Shieldstral-1.0-3B', revision: '003ec7e2b0bab5f0e6307edbaf186fa5822b76f5', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'mistral-small-3-hf',
        family: 'Mistral Small 3',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: 'b76085f9923309d873994d444989f7eb6ec074b06f25b58f1e8d7b7741070949',
        bytes: 17078037,
        license: 'Apache-2.0',
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'mistralai/Mistral-Small-24B-Base-2501', revision: 'b0a2e4ed093c26997495ae625528f81ea04b749f', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Mistral-Small-24B-Instruct-2501', revision: '9527884be6e5616bdd54de542f9ae13384489724', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Mistral-Small-3.1-24B-Base-2503', revision: 'ba6496e3dce1d0bdc93848804b1d4b9d5f3c57bc', path: 'tokenizer.json', gated: false },
            { repo: 'mistralai/Mistral-Small-3.1-24B-Instruct-2503', revision: '68faf511d618ef198fef186659617cfd2eb8e33a', path: 'tokenizer.json', gated: false },
        ],
    },
    // Cohere. No Cohere repo has a LICENSE file; each license is its model card's.
    {
        id: 'command-a-vision',
        family: 'Command A Vision',
        format: 'hf-json',
        sha256: 'e22a9a0f4ebeea673bc56f836c0ccb462a4daf1441316a93b3197ef615a46ec8',
        bytes: 20125691,
        license: 'CC-BY-NC-4.0',
        licenseUrl: 'https://cohere.com/c4ai-cc-by-nc-license',
        sources: [
            { repo: 'CohereLabs/command-a-vision-07-2025', revision: 'e1016a8105950a626e7dd91b0a3030f7ae522411', path: 'tokenizer.json', gated: true },
            { repo: 'mlx-community/command-a-vision-07-2025-4bit', revision: '8864bb543540a9db3433293a3bf91baa8140d310', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'command-a-plus',
        family: 'Command A+',
        format: 'hf-json',
        sha256: '14bd1c49d7d11874921d324986713df4be21cd06060530c497dacef99919b7a5',
        bytes: 28217141,
        license: 'Apache-2.0',
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'CohereLabs/command-a-plus-05-2026-bf16', revision: '5fb6fde5fd12ff89356aae552e11883bc49f069b', path: 'tokenizer.json', gated: false },
            { repo: 'CohereLabs/command-a-plus-05-2026-fp8', revision: 'b2773839a95560b2bf0443865b118d6debe2d1b5', path: 'tokenizer.json', gated: false },
            { repo: 'CohereLabs/command-a-plus-05-2026-w4a4', revision: 'ebd2d72c0f9a84389c6b057136d38c435aea2700', path: 'tokenizer.json', gated: false },
            { repo: 'CohereLabs/North-Mini-Code-1.0', revision: 'd11e61a842617a22dc328552fa5bb86231ee4f37', path: 'tokenizer.json', gated: false },
            { repo: 'CohereLabs/North-Mini-Code-1.0-eagle', revision: '8c7fcb575f107e9968b61cc93a756e6fc2c86713', path: 'tokenizer.json', gated: false },
            { repo: 'CohereLabs/North-Mini-Code-1.0-fp8', revision: '736dde3c255d7726551e6e12af59967f08a20eb6', path: 'tokenizer.json', gated: false },
            { repo: 'CohereLabs/North-Mini-Code-1.0-w4a16', revision: '1e55f4aa327aba4c0b7a1da0d0f24626d3af5c90', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        // The file Cohere's API names for c4ai-aya-vision-32b. No Hugging Face repo ships its content.
        id: 'aya-vision-32b',
        family: 'Aya Vision 32B',
        format: 'hf-json',
        sha256: '90e3d2e4d903f3c2b9485c54bc3501c62a011f7289226f7ecdbdeb2d99e3c7dd',
        bytes: 12777712,
        license: 'Not stated (Cohere public tokenizer file)',
        licenseUrl: 'https://storage.googleapis.com/cohere-public/tokenizers/c4ai-aya-vision-32b.json',
        sources: [
            { url: 'https://storage.googleapis.com/cohere-public/tokenizers/c4ai-aya-vision-32b.json' },
        ],
    },
    {
        id: 'tiny-aya',
        family: 'Tiny Aya',
        format: 'hf-json',
        sha256: '2227ea9c52e8afb3f98bfed2679008b275f2664de69dfde174b374389eb0225d',
        bytes: 21376527,
        license: 'CC-BY-NC-4.0',
        licenseUrl: 'https://cohere.com/c4ai-cc-by-nc-license',
        sources: [
            { repo: 'CohereLabs/tiny-aya-global', revision: '00590ff258ccd84a805f13efcd1c34c2a542654f', path: 'tokenizer.json', gated: true },
            { repo: '1-800-LLMs/tiny-aya-global', revision: '6ca951521be5148dec4e679f7cab4aca5362c523', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'tiny-aya-base',
        family: 'Tiny Aya Base',
        format: 'hf-json',
        sha256: '8f21f6c4f761c192f486ea2c5b06b62b3ef30819b33dc105bdf8b26c8e7974f6',
        bytes: 21374973,
        license: 'CC-BY-NC-4.0',
        licenseUrl: 'https://cohere.com/c4ai-cc-by-nc-license',
        sources: [
            { repo: 'CohereLabs/tiny-aya-base', revision: '1c1166cbc8bbd17760e85d9e1c40d61725f60ae8', path: 'tokenizer.json', gated: true },
            { repo: 'optimum-intel-internal-testing/tiny-random-aya-base', revision: 'e85478d37f912454b23ff2a9c7af16a960837644', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'command-r-08-2024-hf',
        family: 'Command R 08-2024',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: 'f7e773a231706a3ee5d05050ff27aa122a19df09ee7dd59eafa906b7487035b9',
        bytes: 12778456,
        license: 'CC-BY-NC-4.0',
        licenseUrl: 'https://cohere.com/c4ai-cc-by-nc-license',
        sources: [
            { repo: 'CohereLabs/c4ai-command-r-08-2024', revision: 'dc835b893cd3fb8f14b24970dbc2a0a6d3c22ee3', path: 'tokenizer.json', gated: true },
            { repo: 'mlx-community/c4ai-command-r-08-2024-8bit', revision: '7b61a579ab276ff708a5316fca91d5e69748fdfe', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'aya-vision-32b-hf',
        family: 'Aya Vision 32B',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: 'dbb2974c7ff2633f0dce4490be28531dca552e3ecfafad7a2dfd0e8b212534fc',
        bytes: 20124863,
        license: 'CC-BY-NC-4.0',
        licenseUrl: 'https://cohere.com/cohere-labs-cc-by-nc-license',
        sources: [
            { repo: 'CohereLabs/aya-vision-32b', revision: '0554d66834922fc0f2e5f47a12f78464f4a98533', path: 'tokenizer.json', gated: true },
            { repo: 'mlx-community/aya-vision-32b-bf16', revision: '349313b5e6427b52c5f2744835c37c66c840db3e', path: 'tokenizer.json', gated: false },
            { repo: 'unsloth/aya-vision-32b', revision: '5b4c653757c1876eb98709ab0f2c05df446826a7', path: 'tokenizer.json', gated: false },
        ],
    },
    // Z.ai's GLM. The GLM-4-9B repos (2024) ship GLM-4-0414's content: their tokenizer.json differs
    // only in its post-processor, and their tokenizer.model, read by their tokenization_chatglm.py,
    // gives the same ids.
    {
        id: 'glm-4-0414',
        family: 'GLM-4-0414',
        format: 'hf-json',
        sha256: '76ebeac0d8bd7879ead7b43c16b44981f277e47225de2bd7de9ae1a6cc664a8c',
        bytes: 19966496,
        license: 'MIT License',
        licenseUrl: 'https://huggingface.co/zai-org/GLM-4-32B-0414/blob/077b5c2f5c43bd3239fd605a0600229e8facbd4a/LICENSE',
        sources: [
            { repo: 'zai-org/GLM-4-32B-0414', revision: '077b5c2f5c43bd3239fd605a0600229e8facbd4a', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4-32B-Base-0414', revision: '7675abea82951aaaedeb19014bab4e8f88c2d7a5', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4-9B-0414', revision: '645b8482494e31b6b752272bf7f7f273ef0f3caf', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.1V-9B-Base', revision: '5e8d1942554a9277eabcf9e83211bbf9c86136ee', path: 'tokenizer.json', gated: false, license: 'MIT', licenseUrl: 'https://opensource.org/license/mit' },
            { repo: 'zai-org/GLM-4.1V-9B-Thinking', revision: '3c1471e51dc811b589d4d12b1c1c7c1c941267c2', path: 'tokenizer.json', gated: false, license: 'MIT', licenseUrl: 'https://opensource.org/license/mit' },
            { repo: 'zai-org/GLM-Z1-32B-0414', revision: '8eb2858992c1f749e2a6d4075455decc2484722d', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-Z1-9B-0414', revision: 'b221b06fefb23ca320922cf6e68ab5f2fb82de81', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-Z1-Rumination-32B-0414', revision: '6ae9ac6152a7d85761409d6d6ef201d9e8e8aeb1', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'glm-4.5',
        family: 'GLM-4.5',
        format: 'hf-json',
        sha256: '9340665016419c825c4bdabbcc9acc43b7ca2c68ce142724afa829abb1be5efd',
        bytes: 19970699,
        license: 'MIT',
        licenseUrl: 'https://opensource.org/license/mit',
        sources: [
            { repo: 'zai-org/GLM-4.5', revision: 'cbb2c7cfb52fa128a9660cb1a7a78e017899e115', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.5-Air', revision: 'a24ceef6ce4f3536971efe9b778bdaa1bab18daa', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.5-Air-Base', revision: '888c873d4eca81f28d0ef420aa2d96457c28b959', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.5-Air-FP8', revision: 'f9a9c5acf5e543cd24d659a056c5dbcda78ffcfc', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.5-Base', revision: '922a0cee7f137cf3b64c186f0bee77882e4a4e80', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.5-FP8', revision: '8cc290ee4c7cbfa38d3a2db9bd0b7371773ece81', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.5V', revision: 'ed47433b37111465ec527affaaddceff371bca04', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.5V-FP8', revision: '3ca028eac7af91c53109dcfa865e5c8da7b1faf3', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.6', revision: 'be72194883d968d7923a07e2f61681ea9a2826d1', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.6-FP8', revision: 'c064d336a8d0b0f59071f77eafdcdfca40f4b54c', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.6V', revision: '4e2d47eb0b41c5280d8294b17cef9e94fdcfff46', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.6V-FP8', revision: '33172e26eb88482cf3d0a36fced01d05454734ec', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.6V-Flash', revision: '411bb4d77144a3f03accbf4b780f5acb8b7cde4e', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.7', revision: '602d01efcdd332c5238ca4bcede555defbe83eb7', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-4.7-FP8', revision: '7b3b5f81eee81be12a6f8da2710eac4bafb0166a', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'glm-5',
        family: 'GLM-5',
        format: 'hf-json',
        sha256: '19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d',
        bytes: 20217442,
        license: 'MIT',
        licenseUrl: 'https://opensource.org/license/mit',
        sources: [
            { repo: 'zai-org/GLM-4.7-Flash', revision: '7dd20894a642a0aa287e9827cb1a1f7f91386b67', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-5', revision: 'c183ef8c61faee82855eca1ed9bb3a9a7ce3b0b2', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-5-FP8', revision: '4f96cc5eec29dcee5d6ded54f7ffe889438f9516', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/GLM-5.1', revision: '26e1bd6e011feb778d25ae34b09b07074139d92d', path: 'tokenizer.json', gated: false, license: 'MIT License', licenseUrl: 'https://huggingface.co/zai-org/GLM-5.1/blob/26e1bd6e011feb778d25ae34b09b07074139d92d/LICENSE' },
            { repo: 'zai-org/GLM-5.1-FP8', revision: 'f396cf805182f4ca10fa675e1a99815b3ca384db', path: 'tokenizer.json', gated: false, license: 'MIT License', licenseUrl: 'https://huggingface.co/zai-org/GLM-5.1-FP8/blob/f396cf805182f4ca10fa675e1a99815b3ca384db/LICENSE' },
            { repo: 'zai-org/GLM-5.2', revision: 'cf457fa734ab149ffef225f80893eb38c6ff5cdc', path: 'tokenizer.json', gated: false, license: 'MIT License', licenseUrl: 'https://huggingface.co/zai-org/GLM-5.2/blob/cf457fa734ab149ffef225f80893eb38c6ff5cdc/LICENSE' },
            { repo: 'zai-org/GLM-5.2-FP8', revision: 'f33c6dc501ee5a2c7e35155653b1b1abbc320951', path: 'tokenizer.json', gated: false, license: 'MIT License', licenseUrl: 'https://huggingface.co/zai-org/GLM-5.2-FP8/blob/f33c6dc501ee5a2c7e35155653b1b1abbc320951/LICENSE' },
            { repo: 'zai-org/GLM-5.3-Flash', revision: 'eb9eb208eb0d988989d07a6a12d0fdeb5f52574a', path: 'tokenizer.json', gated: false, license: 'MIT License', licenseUrl: 'https://huggingface.co/zai-org/GLM-5.3-Flash/blob/eb9eb208eb0d988989d07a6a12d0fdeb5f52574a/LICENSE' },
            { repo: 'zai-org/GLM-5.3-Flash-BF16', revision: 'a5b45eb41df6402735dedc900be14a42e8d5e538', path: 'tokenizer.json', gated: false, license: 'MIT License', licenseUrl: 'https://huggingface.co/zai-org/GLM-5.3-Flash-BF16/blob/a5b45eb41df6402735dedc900be14a42e8d5e538/LICENSE' },
            { repo: 'zai-org/GLM-5.3', revision: 'aca966e4e02791568aa6a4ced368624b3d897f42', path: 'tokenizer.json', gated: false, license: 'GLM-5.3 License (model card: other)', licenseUrl: 'https://huggingface.co/zai-org/GLM-5.3/blob/aca966e4e02791568aa6a4ced368624b3d897f42/LICENSE' },
            { repo: 'zai-org/GLM-5.3-BF16', revision: '9d2398f478cab2de883137db3a36ad2c96205e24', path: 'tokenizer.json', gated: false, license: 'GLM-5.3 License (model card: other)', licenseUrl: 'https://huggingface.co/zai-org/GLM-5.3-BF16/blob/9d2398f478cab2de883137db3a36ad2c96205e24/LICENSE' },
        ],
    },
    {
        id: 'glm-edge',
        family: 'GLM-Edge',
        format: 'hf-json',
        sha256: 'f78a0fcf4b6ef0e462557283a53ebf71cd91a41f41dc581fb870b724e6edb9bf',
        bytes: 6834426,
        license: 'The GLM-Edge License (model card: other)',
        licenseUrl: 'https://huggingface.co/zai-org/glm-edge-1.5b-chat/blob/7b201d3c160c25beda4cf0d107617ad975cd1ca8/LICENSE',
        sources: [
            { repo: 'zai-org/glm-edge-1.5b-chat', revision: '7b201d3c160c25beda4cf0d107617ad975cd1ca8', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/glm-edge-4b-chat', revision: 'a1817f2ab339ecdd8497c4d752ea71a65299f29a', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/glm-edge-v-2b', revision: '2053707733f99ab52e943904f43c2359a94301ef', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/glm-edge-v-5b', revision: '595da783cdf468bf0616b9c05757e911676b2f39', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'autoglm-phone',
        family: 'AutoGLM-Phone',
        format: 'hf-json',
        sha256: 'c2f7919ffc6c6628cbde5f0b1a204a78bc23319be4e85b7331c71a9a48a8d06d',
        bytes: 19968176,
        license: 'MIT',
        licenseUrl: 'https://opensource.org/license/mit',
        sources: [
            { repo: 'zai-org/AutoGLM-Phone-9B', revision: '66a46ea238158e5f71efc91928668e9c35b42247', path: 'tokenizer.json', gated: false },
            { repo: 'zai-org/AutoGLM-Phone-9B-Multilingual', revision: '832ab5e014b965268dafd944e64cbc8e4bade892', path: 'tokenizer.json', gated: false },
        ],
    },
    // Kimi: every repo ships the same tiktoken.model; its code and tokenizer_config.json decide the tokenizer.
    {
        id: 'kimi-k2-base',
        family: 'Kimi K2 Base',
        format: 'tiktoken',
        sha256: 'b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103',
        bytes: 2795286,
        license: 'Modified MIT License (model card: other)',
        licenseUrl: 'https://huggingface.co/moonshotai/Kimi-K2-Base/blob/ce72df012259dcc55d945e890f815fe7ef69159c/LICENSE',
        sources: [
            { repo: 'moonshotai/Kimi-K2-Base', revision: 'ce72df012259dcc55d945e890f815fe7ef69159c', path: 'tiktoken.model', gated: false },
        ],
        tiktoken: kimiTiktoken(KIMI_K2_SPECIAL_TOKENS, { allowedSpecial: 'none' }),
    },
    {
        id: 'kimi-k2-thinking',
        family: 'Kimi K2 Thinking',
        format: 'tiktoken',
        sha256: 'b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103',
        bytes: 2795286,
        license: 'Modified MIT License (model card: other)',
        licenseUrl: 'https://huggingface.co/moonshotai/Kimi-K2-Thinking/blob/a51ccc050d73dab088bf7b0e2dd9b30ae85a4e55/LICENSE',
        sources: [
            { repo: 'moonshotai/Kimi-K2-Thinking', revision: 'a51ccc050d73dab088bf7b0e2dd9b30ae85a4e55', path: 'tiktoken.model', gated: false },
        ],
        tiktoken: kimiTiktoken({ ...KIMI_K2_SPECIAL_TOKENS, ...KIMI_THINK_TOKENS }),
    },
    {
        id: 'kimi-k2.5',
        family: 'Kimi K2.5',
        format: 'tiktoken',
        sha256: 'b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103',
        bytes: 2795286,
        license: 'Modified MIT License (model card: other)',
        licenseUrl: 'https://huggingface.co/moonshotai/Kimi-K2.5/blob/4d01dfe0332d63057c186e0b262165819efb6611/LICENSE',
        sources: [
            { repo: 'moonshotai/Kimi-K2.5', revision: '4d01dfe0332d63057c186e0b262165819efb6611', path: 'tiktoken.model', gated: false },
            { repo: 'moonshotai/Kimi-K2.6', revision: '7eb5002f6aadc958aed6a9177b7ed26bb94011bb', path: 'tiktoken.model', gated: false },
            { repo: 'moonshotai/Kimi-K2.7-Code', revision: '74797c9c62378b951a1f6fcf5c4631024e9b8bef', path: 'tiktoken.model', gated: false },
        ],
        tiktoken: kimiTiktoken({ ...KIMI_K2_SPECIAL_TOKENS, '<|media_begin|>': 163602, ...KIMI_MEDIA_TOKENS, ...KIMI_THINK_TOKENS }),
    },
    {
        id: 'kimi-k3',
        family: 'Kimi K3',
        format: 'tiktoken',
        sha256: 'b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103',
        bytes: 2795286,
        license: 'Kimi K3 License (model card: other)',
        licenseUrl: 'https://huggingface.co/moonshotai/Kimi-K3/blob/f831ab66814297da540d832a5235f8e904f29d06/LICENSE',
        sources: [
            { repo: 'moonshotai/Kimi-K3', revision: 'f831ab66814297da540d832a5235f8e904f29d06', path: 'tiktoken.model', gated: false },
        ],
        tiktoken: kimiTiktoken({
            '[BOS]': 163584,
            '[EOS]': 163585,
            '<|end_of_msg|>': 163586,
            '<|open|>': 163587,
            '<|close|>': 163588,
            '<|sep|>': 163589,
            '[start_header_id]': 163590,
            '[end_header_id]': 163591,
            '[EOT]': 163593,
            '<|media_begin|>': 163602,
            ...KIMI_MEDIA_TOKENS,
            '<osagent_mode>': 163649,
            '[UNK]': 163838,
            '[PAD]': 163839,
        }),
    },
    {
        id: 'kimi-vl',
        family: 'Kimi-VL',
        format: 'tiktoken',
        sha256: 'b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103',
        bytes: 2795286,
        license: 'MIT',
        licenseUrl: 'https://opensource.org/license/mit',
        sources: [
            { repo: 'moonshotai/Kimi-VL-A3B-Instruct', revision: '398eede0903cd983a2bfa0cc634e9ac1d843f375', path: 'tiktoken.model', gated: false },
            { repo: 'moonshotai/Kimi-VL-A3B-Thinking', revision: '7d99e220af610d8624fcba22b2c076c7ed528f14', path: 'tiktoken.model', gated: false },
            { repo: 'moonshotai/Kimi-VL-A3B-Thinking-2506', revision: 'aa1730989e7558695b44ee493623e03bd325a994', path: 'tiktoken.model', gated: false },
        ],
        tiktoken: kimiTiktoken({
            '[BOS]': 163584,
            '[EOS]': 163585,
            '<|im_end|>': 163586,
            '<|im_user|>': 163587,
            '<|im_assistant|>': 163588,
            '<|im_system|>': 163594,
            '<|im_middle|>': 163601,
            '<|media_start|>': 163602,
            ...KIMI_MEDIA_TOKENS,
            '[PAD]': 163838,
            '[UNK]': 163839,
        }, { reservedCount: 258 }),
    },
    {
        id: 'moonlight',
        family: 'Moonlight',
        format: 'tiktoken',
        sha256: 'b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103',
        bytes: 2795286,
        license: 'MIT',
        licenseUrl: 'https://opensource.org/license/mit',
        sources: [
            { repo: 'moonshotai/Moonlight-16B-A3B', revision: '476b36a473d4467f94469414bef6cee75c9c8172', path: 'tiktoken.model', gated: false },
            { repo: 'moonshotai/Moonlight-16B-A3B-Instruct', revision: '4e735b07a89f73647dfab71ab91b840f362ede5b', path: 'tiktoken.model', gated: false },
        ],
        tiktoken: kimiTiktoken({
            '[BOS]': 163584,
            '[EOS]': 163585,
            '<|im_end|>': 163586,
            '<|im_user|>': 163587,
            '<|im_assistant|>': 163588,
            '<|im_system|>': 163594,
            '<|im_middle|>': 163601,
            '[PAD]': 163838,
            '[UNK]': 163839,
        }, { reservedCount: 258 }),
    },
    // MiniMax.
    {
        id: 'minimax-text-01',
        family: 'MiniMax-Text-01',
        format: 'hf-json',
        sha256: 'ece04384257543dd1c1312991b6042efdc5be09103729a62cc84d718bcc3b1a6',
        bytes: 9724836,
        license: 'Not stated (Hugging Face model card)',
        licenseUrl: 'https://huggingface.co/MiniMaxAI/MiniMax-Text-01/blob/a7351bf2bee0e1253919d349f1ad304e6dac13e9/tokenizer.json',
        sources: [
            { repo: 'MiniMaxAI/MiniMax-Text-01', revision: 'a7351bf2bee0e1253919d349f1ad304e6dac13e9', path: 'tokenizer.json', gated: false },
            { repo: 'MiniMaxAI/MiniMax-Text-01-hf', revision: 'f7ce01366e8585a8948f19aedc8e20628c6965e5', path: 'tokenizer.json', gated: false, license: 'minimax (model card: other)', licenseUrl: 'https://huggingface.co/MiniMaxAI/MiniMax-Text-01-hf/blob/f7ce01366e8585a8948f19aedc8e20628c6965e5/README.md' },
            { repo: 'MiniMaxAI/MiniMax-VL-01', revision: '308b79934be140a43a0fb80f82b4e20d0ebe3cb8', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'minimax-m1',
        family: 'MiniMax-M1',
        format: 'hf-json',
        sha256: '369f547b736fad84af7c5bd8523ab1414b7116b5d167d84a10cf37c45dc79348',
        bytes: 9726751,
        license: 'Apache License, Version 2.0',
        licenseUrl: 'https://huggingface.co/MiniMaxAI/MiniMax-M1-40k/blob/2d1d1c2f00c97fc1245bfce7648649b76e0a8e6e/LICENSE',
        sources: [
            { repo: 'MiniMaxAI/MiniMax-M1-40k', revision: '2d1d1c2f00c97fc1245bfce7648649b76e0a8e6e', path: 'tokenizer.json', gated: false },
            { repo: 'MiniMaxAI/MiniMax-M1-40k-hf', revision: '5a6c3d0d6dfaf1c5312583b395637cd27498d801', path: 'tokenizer.json', gated: false },
            { repo: 'MiniMaxAI/MiniMax-M1-80k', revision: '8d1494b1a260e22040d5b9b2eb332eb44500b34d', path: 'tokenizer.json', gated: false },
            { repo: 'MiniMaxAI/MiniMax-M1-80k-hf', revision: '3dbbd8d1e47e262a91086451a1dba347722fa8db', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'minimax-m2',
        family: 'MiniMax-M2',
        format: 'hf-json',
        sha256: '757622126525aeeb131756849d93298070ff3f0319c455ec8c5bb0f6b1cebbe8',
        bytes: 9730160,
        license: 'modified-mit (model card: other)',
        licenseUrl: 'https://github.com/MiniMax-AI/MiniMax-M2/blob/main/LICENSE',
        sources: [
            { repo: 'MiniMaxAI/MiniMax-M2', revision: '757303d492a50514c312788b5247a4f696a4c6a3', path: 'tokenizer.json', gated: false },
            { repo: 'MiniMaxAI/MiniMax-M2.1', revision: 'cd97f59135f37b2a6bf09356e485d5e4aeb7dc9c', path: 'tokenizer.json', gated: false },
            { repo: 'MiniMaxAI/MiniMax-M2.5', revision: 'f710177d938eff80b684d42c5aa84b382612f21f', path: 'tokenizer.json', gated: false },
            { repo: 'MiniMaxAI/MiniMax-M2.7', revision: 'd494266a4affc0d2995ba1fa35c8481cbd84294b', path: 'tokenizer.json', gated: false, license: 'NON-COMMERCIAL LICENSE (model card: other)', licenseUrl: 'https://huggingface.co/MiniMaxAI/MiniMax-M2.7/blob/d494266a4affc0d2995ba1fa35c8481cbd84294b/LICENSE' },
        ],
    },
    {
        id: 'minimax-m3',
        family: 'MiniMax-M3',
        format: 'hf-json',
        sha256: 'bb1f1626cf01448f1e3b6036d0a061ffc66c91d9046aada14ea23a5441b5ad6e',
        bytes: 9731500,
        license: 'MINIMAX COMMUNITY LICENSE (model card: other)',
        licenseUrl: 'https://huggingface.co/MiniMaxAI/MiniMax-M3/blob/f0e1c1e04d40177e4673a22097036854f536e9c0/LICENSE',
        sources: [
            { repo: 'MiniMaxAI/MiniMax-M3', revision: 'f0e1c1e04d40177e4673a22097036854f536e9c0', path: 'tokenizer.json', gated: false },
            { repo: 'MiniMaxAI/MiniMax-M3-MXFP8', revision: 'c5454eb03678d8710e54a4e0fc681b9f3b4a3dba', path: 'tokenizer.json', gated: false },
        ],
    },
    // OpenAI.
    {
        id: 'gpt-oss',
        family: 'gpt-oss',
        format: 'hf-json',
        sha256: '0614fe83cadab421296e664e1f48f4261fa8fef6e03e63bb75c20f38e37d07d3',
        bytes: 27868174,
        license: 'Apache License, Version 2.0',
        licenseUrl: 'https://huggingface.co/openai/gpt-oss-120b/blob/b5c939de8f754692c1647ca79fbf85e8c1e70f8a/LICENSE',
        sources: [
            { repo: 'openai/gpt-oss-120b', revision: 'b5c939de8f754692c1647ca79fbf85e8c1e70f8a', path: 'tokenizer.json', gated: false },
            { repo: 'openai/gpt-oss-20b', revision: '6cee5e81ee83917806bbde320786a8fb61efebee', path: 'tokenizer.json', gated: false },
            { repo: 'openai/gpt-oss-safeguard-120b', revision: '3c7391182603991a904031244e7822488c67796d', path: 'tokenizer.json', gated: false },
            { repo: 'openai/gpt-oss-safeguard-20b', revision: '8a11e17b25c973a24099d4016bf2e17dd7ec1574', path: 'tokenizer.json', gated: false },
        ],
    },
    // Microsoft's Phi. Phi-3 and Phi-3.5 mini, medium and MoE read the bundled llama.model.
    {
        id: 'phi-1',
        family: 'Phi-1/1.5/2',
        format: 'hf-json',
        sha256: '337da36be7a71a6e88aa9148967a7bc8736f4b47c7de8e19ba92b89e80734cfc',
        bytes: 2114924,
        license: 'MIT License',
        licenseUrl: 'https://huggingface.co/microsoft/phi-1/blob/d4c0adcb065e84e00ca814e35cba3012ea9841ab/LICENSE',
        sources: [
            { repo: 'microsoft/phi-1', revision: 'd4c0adcb065e84e00ca814e35cba3012ea9841ab', path: 'tokenizer.json', gated: false },
            { repo: 'microsoft/phi-1_5', revision: '77aa61eeac94fbf33d492b9f2744c98b42d5b5eb', path: 'tokenizer.json', gated: false },
            { repo: 'microsoft/phi-2', revision: '810d367871c1d460086d9f82db8696f2e0a0fcd0', path: 'tokenizer.json', gated: false },
            { repo: 'microsoft/phi-2-pytdml', revision: '87836f04b732c91f2aeac0d94c6a6ad8ecd5f994', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'phi-3-hf',
        family: 'Phi-3',
        nameNote: 'official, HF tokenizer.json',
        format: 'hf-json',
        sha256: 'd0f067e1e15cd0a36ebef3668024882cb67a80b86fb4b7b4b128481f0d474db7',
        bytes: 1844436,
        license: 'MIT License',
        licenseUrl: 'https://huggingface.co/microsoft/Phi-3.5-mini-instruct-onnx/blob/7230dcd6c1dd28aab70f263ecc8734ec9d9bcb70/LICENSE',
        sources: [
            { repo: 'microsoft/Phi-3.5-mini-instruct-onnx', revision: '7230dcd6c1dd28aab70f263ecc8734ec9d9bcb70', path: 'cpu_and_mobile/cpu-int4-awq-block-128-acc-level-4/tokenizer.json', gated: false },
            { repo: 'microsoft/Phi-mini-MoE-instruct', revision: 'f620b32c0d3e8f7e76f57ccdaa88e0df8bc8bfcd', path: 'tokenizer.json', gated: false },
            { repo: 'microsoft/Phi-tiny-MoE-instruct', revision: '2fe50e88d0e2a5a132563815686ea0dcc8e252b5', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'phi-3-small',
        family: 'Phi-3-small',
        format: 'tiktoken',
        sha256: '223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7',
        bytes: 1681126,
        license: 'MIT License',
        licenseUrl: 'https://huggingface.co/microsoft/Phi-3-small-128k-instruct/blob/e95b185a59a58450c9b1dd7347a9dee78f18113e/LICENSE',
        sources: [
            { repo: 'microsoft/Phi-3-small-128k-instruct', revision: 'e95b185a59a58450c9b1dd7347a9dee78f18113e', path: 'cl100k_base.tiktoken', gated: false },
            { repo: 'microsoft/Phi-3-small-8k-instruct', revision: '188b876e997ee4055df01afe46274c14c400fe40', path: 'cl100k_base.tiktoken', gated: false },
            { repo: 'microsoft/Phi-3-small-8k-instruct-onnx-cuda', revision: 'bc8649337c1456142aed0623c789343c0a4e91ea', path: 'cuda-fp16/cl100k_base.tiktoken', gated: false },
        ],
        tiktoken: {
            patStr: CL100K_PAT_STR,
            specialTokens: PHI_3_SMALL_SPECIAL_TOKENS,
            reservedSpecialTokens: { start: 100256, count: 96 },
            allowedSpecial: 'all',
            split: null,
        },
    },
    {
        id: 'phi-3-vision',
        family: 'Phi-3-vision',
        format: 'hf-json',
        sha256: '005df01af5e16e758ff74c1a31e7b8910eb75c7d5626689d6bdee40a779d44fe',
        bytes: 1851389,
        license: 'MIT License',
        licenseUrl: 'https://huggingface.co/microsoft/Phi-3-vision-128k-instruct/blob/ed2772fabe9dc9acd0caad54b62761d92520cc44/LICENSE',
        sources: [
            { repo: 'microsoft/Phi-3-vision-128k-instruct', revision: 'ed2772fabe9dc9acd0caad54b62761d92520cc44', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'phi-4',
        family: 'Phi-4',
        format: 'hf-json',
        sha256: '9f38d05d9d25756bb2f181ab5a0cebcd59e638df10336fc7ed1010f7296d0298',
        bytes: 4253055,
        license: 'MIT License',
        licenseUrl: 'https://huggingface.co/microsoft/phi-4/blob/2db69c1c3e91a05d2c64a3185acfbaf36f744e25/LICENSE',
        sources: [
            { repo: 'microsoft/phi-4', revision: '2db69c1c3e91a05d2c64a3185acfbaf36f744e25', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'phi-4-mini',
        family: 'Phi-4-mini',
        format: 'hf-json',
        sha256: '382cc235b56c725945e149cc25f191da667c836655efd0857b004320e90e91ea',
        bytes: 15524095,
        license: 'MIT License',
        licenseUrl: 'https://huggingface.co/microsoft/Phi-4-mini-instruct/blob/cfbefacb99257ffa30c83adab238a50856ac3083/LICENSE',
        sources: [
            { repo: 'microsoft/Phi-4-mini-instruct', revision: 'cfbefacb99257ffa30c83adab238a50856ac3083', path: 'tokenizer.json', gated: false },
            { repo: 'microsoft/Phi-4-mini-instruct-onnx', revision: 'fc04c8f93df696602fd9f300a30d1bf2e3081347', path: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/tokenizer.json', gated: false },
        ],
    },
    {
        id: 'phi-4-multimodal',
        family: 'Phi-4-multimodal',
        format: 'hf-json',
        sha256: '4c1b9f641d4f8b7247b8d5007dd3b6a9f6a87cb5123134fe0d326f14d10c0585',
        bytes: 15524479,
        license: 'MIT License',
        licenseUrl: 'https://huggingface.co/microsoft/Phi-4-multimodal-instruct/blob/93f923e1a7727d1c4f446756212d9d3e8fcc5d81/LICENSE',
        sources: [
            { repo: 'microsoft/Phi-4-multimodal-instruct', revision: '93f923e1a7727d1c4f446756212d9d3e8fcc5d81', path: 'tokenizer.json', gated: false },
            { repo: 'microsoft/Phi-4-multimodal-instruct-onnx', revision: '295df4cddf8c3740df7cd66e5d05f06a872fcaf5', path: 'gpu/gpu-int4-rtn-block-32/tokenizer.json', gated: false },
            // Its revision has no LICENSE file; its model card declares mit.
            { repo: 'microsoft/paza-Phi-4-multimodal-instruct', revision: '1e78f4f84fd8a92f132295a32e5cb71b5321dcab', path: 'tokenizer.json', gated: false, license: 'MIT', licenseUrl: 'https://opensource.org/license/mit' },
        ],
    },
    {
        id: 'phi-4-reasoning',
        family: 'Phi-4-reasoning',
        format: 'hf-json',
        sha256: 'b28a32dcbbb2779573aa8e345457e7b10f470ccfd262d01672c2469698cbd4f7',
        bytes: 7153070,
        license: 'MIT License',
        licenseUrl: 'https://huggingface.co/microsoft/Phi-4-reasoning/blob/1de18ec97600877ce63dbf60c73b998da99f0195/LICENSE',
        sources: [
            { repo: 'microsoft/Phi-4-reasoning', revision: '1de18ec97600877ce63dbf60c73b998da99f0195', path: 'tokenizer.json', gated: false },
            { repo: 'microsoft/Phi-4-reasoning-onnx', revision: 'f5d8c9c1f0dad99f7d6212eee2c8ea4ebee7b935', path: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/tokenizer.json', gated: false },
            { repo: 'microsoft/Phi-4-reasoning-plus', revision: '69baf8528e1bcf05f475034d9e5dd32875ed125f', path: 'tokenizer.json', gated: false },
            { repo: 'microsoft/Phi-4-reasoning-plus-onnx', revision: '8646193e05fb4051c858f07375ef28de975b37d0', path: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/tokenizer.json', gated: false },
        ],
    },
    {
        id: 'phi-4-reasoning-vision',
        family: 'Phi-4-reasoning-vision',
        format: 'hf-json',
        sha256: '3c7e8a15e8e0933538e1f384331d0163f6329c3655a132ce2edb1b0e5a7c024b',
        bytes: 7153065,
        license: 'MIT',
        // The pinned revision has no LICENSE file; its model card declares mit.
        licenseUrl: 'https://opensource.org/license/mit',
        sources: [
            { repo: 'microsoft/Phi-4-reasoning-vision-15B', revision: 'c3e4fac79ddace21976ced56fbf1564b8bd8c89f', path: 'tokenizer.json', gated: false },
        ],
    },
    // NVIDIA's Nemotron. None of these repos has a LICENSE file with a title; their model cards name their licenses.
    {
        id: 'nemotron-4',
        family: 'Nemotron-4',
        format: 'sentencepiece',
        sha256: '6dfd8b970f437002fc445214304969fe59e64d4f48500bd0b77ba55340f2d811',
        bytes: 4545602,
        license: 'nvidia-open-model-license (model card: other)',
        licenseUrl: 'https://developer.download.nvidia.com/licenses/nvidia-open-model-license-agreement-june-2024.pdf',
        sources: [
            { repo: 'nvidia/Nemotron-4-340B-Base', revision: '5d954800b3e45c8234a9c40f4a1479240149eda8', path: '29e0db5f7dd14bcf9f32727ff482502b_nemotron_2_256k.model', gated: false },
            { repo: 'nvidia/Nemotron-4-340B-Instruct', revision: 'ac75bfbc2fb10d07fa90813707c18aebecdb9024', path: '8223bf8eaa194eb8920af568bb52e2d0_megatron_2.model', gated: false },
            { repo: 'nvidia/Nemotron-4-340B-Reward', revision: '69049799d066ffcf1734afa61f458c74f944d216', path: '29e0db5f7dd14bcf9f32727ff482502b_nemotron_2_256k.model', gated: false },
        ],
    },
    {
        id: 'llama-3.1-nemotron-51b',
        family: 'Llama-3.1-Nemotron-51B',
        format: 'hf-json',
        sha256: 'e0abebe9c007cb6a7ceb6270a493b3378f23a6a9a69777913e32884d8d8873a9',
        bytes: 9085630,
        license: 'nvidia-open-model-license (model card: other)',
        licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/',
        sources: [
            { repo: 'nvidia/Llama-3_1-Nemotron-51B-Instruct', revision: 'f4d9431910e03eaffbe351ede20cdbb25d9765c2', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'nemotron-h',
        family: 'Nemotron-H',
        format: 'hf-json',
        sha256: '3277c00fe5fb3963b3cb7c07b7f183722d2af4d775a4aea7cfb3684d7cccbc2f',
        bytes: 17078330,
        license: 'nvidia-nemotron-open-model-license (model card: other)',
        licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/',
        sources: [
            { repo: 'nvidia/NVIDIA-Nemotron-Nano-9B-v2-Japanese', revision: '3979dd16634988c34cc3bd911583c51e6a731d10', path: 'tokenizer.json', gated: false },
            { repo: 'nvidia/NVIDIA-Nemotron-Nano-12B-v2', revision: 'f428df0ec725fed457b89cfca54dc26500fb88c1', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/NVIDIA-Nemotron-Nano-12B-v2-Base', revision: '78dc93a79e2533922ac8ad2c16f79b7fb747970d', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/NVIDIA-Nemotron-Nano-9B-v2', revision: '6533e8de2c68e4536bf7c411d7a3ce5734111476', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/NVIDIA-Nemotron-Nano-9B-v2-Base', revision: 'dc0661c829b14e5b9246c05cfa89094a0875e052', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/NVIDIA-Nemotron-Nano-9B-v2-FP8', revision: '8bc5eece2eb5514c4bca7f2ec655b91eb554f4c0', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/NVIDIA-Nemotron-Nano-9B-v2-NVFP4', revision: '8556c9164ddb43fe1f4f4ad730593b3c5e3f7328', path: 'tokenizer.json', gated: false, license: 'nvidia-open-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
            { repo: 'nvidia/Nemotron-H-47B-Base-8K', revision: '81a3fb4fd39b749212e32cdafb02a865b0705d12', path: 'tokenizer.json', gated: false, license: 'nvidia-internal-scientific-research-and-development-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/' },
            { repo: 'nvidia/Nemotron-H-47B-Reasoning-128K', revision: '18c2a0e52e2d028dd96c3b4252af2a4f8fa54a43', path: 'tokenizer.json', gated: false, license: 'nvidia-internal-scientific-research-and-development-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/' },
            { repo: 'nvidia/Nemotron-H-47B-Reasoning-128K-FP8', revision: '6d72ac6b3a4fa7f6c61d5366dec2a59f35395d83', path: 'tokenizer.json', gated: false, license: 'nvidia-internal-scientific-research-and-development-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/' },
            { repo: 'nvidia/Nemotron-H-4B-Base-8K', revision: 'faba3b731ad7ea5781b9518ae75fb610a94affcf', path: 'tokenizer.json', gated: false, license: 'nvidia-internal-scientific-research-and-development-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/' },
            { repo: 'nvidia/Nemotron-H-4B-Instruct-128K', revision: 'f3c0b6c3b7fcb39e132b6007386e33a586d6e6cb', path: 'tokenizer.json', gated: false, license: 'nvidia-internal-scientific-research-and-development-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/' },
            { repo: 'nvidia/Nemotron-H-56B-Base-8K', revision: '1fb09491e3aa62f5d9204fb63668ec600433c434', path: 'tokenizer.json', gated: false, license: 'nvidia-internal-scientific-research-and-development-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/' },
            { repo: 'nvidia/Nemotron-H-8B-Base-8K', revision: '94ea861e008c2dfced3e8e1302094024077aa04e', path: 'tokenizer.json', gated: false, license: 'nvidia-internal-scientific-research-and-development-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/' },
            { repo: 'nvidia/Nemotron-H-8B-Reasoning-128K', revision: '2dcbcfd95b103843b6ad8e79690f34480ce5a5ae', path: 'tokenizer.json', gated: false, license: 'nvidia-internal-scientific-research-and-development-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/' },
            { repo: 'nvidia/Nemotron-H-8B-Reasoning-128K-FP8', revision: 'a100ba4191a9563be3bb614fcda87925a20fd125', path: 'tokenizer.json', gated: false, license: 'nvidia-internal-scientific-research-and-development-model-license (model card: other)', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/' },
        ],
    },
    {
        id: 'llama-3.1-nemotron-nano-vl',
        family: 'Llama-3.1-Nemotron-Nano-VL',
        format: 'hf-json',
        sha256: 'f5725802f93aea2c6126c605128904b2feaad45cdc0b16240fb153481a229948',
        bytes: 17211566,
        license: 'nvidia-open-model-license (model card: other)',
        licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/',
        sources: [
            { repo: 'nvidia/Llama-3.1-Nemotron-Nano-VL-8B-V1', revision: '437f4e28b989cc2d9a16b6767cc930cdf48797ff', path: 'tokenizer.json', gated: false },
            { repo: 'nvidia/Llama-3.1-Nemotron-Nano-VL-8B-V1-FP4-QAD', revision: 'aefd101dc9cd08925f82a623562630ce86b24dcb', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'acereason-nemotron-1.1',
        family: 'AceReason-Nemotron-1.1',
        format: 'hf-json',
        sha256: '296e081e2f5ecf9d87814aa9b0f4b12d670ed2b2e2be6c84e01a9466c953afb7',
        bytes: 11422267,
        license: 'nvidia-open-model-license (model card: other)',
        licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/',
        sources: [
            { repo: 'nvidia/AceReason-Nemotron-1.1-7B', revision: '2be9ed2fe532f39332ee47fd21899cab5fd6ec15', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'nemotron-nano-12b-v2-vl',
        family: 'Nemotron-Nano-12B-v2-VL',
        format: 'hf-json',
        sha256: 'db8e35444fca3a2b98e2c8e927a8f1d8b1ba9d4b349e13ce5aafdb11b6404205',
        bytes: 17079976,
        license: 'nvidia-open-model-license (model card: other)',
        licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/',
        sources: [
            { repo: 'nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-BF16', revision: 'ca9543b126e8bf3176916d3d305ccc415f89fd4d', path: 'tokenizer.json', gated: false },
            { repo: 'nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-FP8', revision: 'e9550fdec09682d12e8c3e41548b2e05b16db7c1', path: 'tokenizer.json', gated: false },
            { repo: 'nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-NVFP4-QAD', revision: '16853d6c682223e967d5622c99d0082cb994b771', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'nemotron-3',
        family: 'Nemotron 3',
        format: 'hf-json',
        sha256: 'c6021eb6847e682f89aa52d5eb6e8c7d902a23acfc8137e25211cf84828f1592',
        bytes: 17077485,
        license: 'nvidia-nemotron-open-model-license (model card: other)',
        licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/',
        sources: [
            { repo: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16', revision: 'bf77c3174f68ad409e1c2aa60daeb46e32d1c606', path: 'tokenizer.json', gated: false },
            { repo: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8', revision: '9bee19446c0dfd01f356e10979d225b2a6621944', path: 'tokenizer.json', gated: false },
            { repo: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4', revision: '6efb4a2a1c1fa277ce7b3df7a1416255011b1c99', path: 'tokenizer.json', gated: false },
        ],
    },
]);

/**
 * @param {string} id
 * @param {readonly TokenizerSourceEntry[]} [registry]
 * @returns {TokenizerSourceEntry|undefined}
 */
export function findTokenizerSource(id, registry = TOKENIZER_SOURCES) {
    return registry.find(entry => entry.id === id);
}

/**
 * JSON with every object's keys sorted, so equal values give equal text.
 * @param {any} value
 * @returns {string}
 */
function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * The sha256 of an entry's tokenizer config (its `tiktoken` field) as canonical JSON; null for an
 * entry whose file alone is its tokenizer.
 * @param {TokenizerSourceEntry} entry
 * @returns {string|null}
 */
export function getTokenizerConfigHash(entry) {
    return entry.tiktoken ? crypto.createHash('sha256').update(canonicalJson(entry.tiktoken)).digest('hex') : null;
}

/**
 * What identifies an entry's tokenizer, and names its reference fixture: its file's sha256, then
 * `.<config hash>` when it has a config, because entries can share one file and read it differently.
 * @param {TokenizerSourceEntry} entry
 * @returns {string}
 */
export function getTokenizerIdentity(entry) {
    const configHash = getTokenizerConfigHash(entry);
    return configHash ? `${entry.sha256}.${configHash}` : entry.sha256;
}

/**
 * The name an entry's tokenizer is shown under, also its Advanced Formatting → Tokenizer option.
 * @param {TokenizerSourceEntry} entry
 * @returns {string}
 */
export function getTokenizerDisplayName(entry) {
    return `${entry.family} (${entry.nameNote ?? 'official'})`;
}

/**
 * The license of the file as downloaded from this source.
 * @param {TokenizerSourceEntry} entry
 * @param {TokenizerSource} source
 * @returns {{ license: string, licenseUrl: string }}
 */
export function getSourceLicense(entry, source) {
    return source.license
        ? { license: source.license, licenseUrl: String(source.licenseUrl) }
        : { license: entry.license, licenseUrl: entry.licenseUrl };
}

/**
 * Cache file extension per format. The sha256 is the file's identity and the format decides its
 * loader, so one sha256 always gets one name, whatever path it came from.
 * @type {Readonly<Record<TokenizerFileFormat, string>>}
 */
export const CACHE_EXTENSIONS = Object.freeze({
    'hf-json': '.json',
    'tekken': '.json',
    'sentencepiece': '.model',
    'tiktoken': '.tiktoken',
});

export const DOWNLOAD_RETRY_MS = 60_000;

const IS_DOWNLOAD_ALLOWED = getConfigValue('enableDownloadableTokenizers', true, 'boolean');

/**
 * URL -> `performance.now()` of its last failed download. Monotonic, so a wall-clock change
 * can't stretch or skip the wait. Shared by every tokenizer download.
 * @type {Map<string, number>}
 */
const failedDownloads = new Map();

/**
 * Whether a download from this URL failed less than {@link DOWNLOAD_RETRY_MS} ago.
 * @param {string} url
 * @returns {boolean}
 */
export function isDownloadBackedOff(url) {
    const failedAt = failedDownloads.get(url);
    return failedAt !== undefined && performance.now() - failedAt < DOWNLOAD_RETRY_MS;
}

/**
 * Records a failed download from this URL.
 * @param {string} url
 */
export function recordDownloadFailure(url) {
    failedDownloads.set(url, performance.now());
}

/**
 * Forgets a failed download from this URL after a successful one.
 * @param {string} url
 */
export function clearDownloadFailure(url) {
    failedDownloads.delete(url);
}

/**
 * @param {TokenizerSource} source
 * @returns {string}
 */
export function getSourceUrl(source) {
    return source.url ?? `https://huggingface.co/${source.repo}/resolve/${source.revision}/${source.path}`;
}

/**
 * @param {TokenizerSourceEntry} entry
 * @returns {string} The entry's cache file name, `<sha256>.<ext>`
 */
export function getCacheFileName(entry) {
    const extension = CACHE_EXTENSIONS[entry.format];
    if (!extension) {
        throw new Error(`Unknown tokenizer file format: ${entry.format}`);
    }
    return `${entry.sha256.toLowerCase()}${extension}`;
}

/**
 * sha256 -> the download in flight for it, so parallel calls share one fetch.
 * @type {Map<string, Promise<{ path: string, license: string }>>}
 */
const inFlight = new Map();

/**
 * Reads a response body, failing once it grows past `maxBytes`.
 * @param {any} body
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readCappedBody(body, maxBytes) {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
            throw new Error(`The body is larger than the expected ${maxBytes} bytes`);
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
}

/**
 * Downloads one source and checks it against the entry's size and sha256.
 * @param {TokenizerSourceEntry} entry
 * @param {TokenizerSource} source
 * @param {string} hfToken The user's saved Hugging Face token, or ''
 * @returns {Promise<Buffer>}
 */
async function downloadSource(entry, source, hfToken) {
    /** @type {Record<string, string>} */
    const headers = {};
    if (source.gated) {
        headers.Authorization = `Bearer ${hfToken}`;
    }
    const response = await fetch(getSourceUrl(source), { headers });
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    const body = await readCappedBody(response.body, entry.bytes);
    if (body.length !== entry.bytes) {
        throw new Error(`Expected ${entry.bytes} bytes, got ${body.length}`);
    }
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    if (sha256 !== entry.sha256.toLowerCase()) {
        throw new Error(`Expected sha256 ${entry.sha256}, got ${sha256}`);
    }
    return body;
}

/**
 * Tries the entry's sources in order and writes the first verified body to the cache.
 * @param {TokenizerSourceEntry} entry
 * @param {string} cachedFile
 * @param {string} hfToken
 * @returns {Promise<{ path: string, license: string }>} The cached file's path, and the license of the source it came from
 */
async function downloadEntry(entry, cachedFile, hfToken) {
    /** @type {string[]} */
    const reasons = [];
    for (const source of entry.sources) {
        const url = getSourceUrl(source);
        if (source.gated && !hfToken) {
            reasons.push(`${url}: gated, no Hugging Face token saved`);
            continue;
        }
        if (isDownloadBackedOff(url)) {
            reasons.push(`${url}: the last download failed less than ${DOWNLOAD_RETRY_MS / 1000} s ago`);
            continue;
        }
        try {
            console.info('Downloading tokenizer file:', url);
            const body = await downloadSource(entry, source, hfToken);
            writeFileAtomicSync(cachedFile, body);
            clearDownloadFailure(url);
            const { license } = getSourceLicense(entry, source);
            console.info(`Downloaded the ${entry.family} tokenizer. License: ${license}`);
            return { path: cachedFile, license };
        } catch (error) {
            recordDownloadFailure(url);
            reasons.push(`${url}: ${error.message}`);
        }
    }
    throw new Error(`Could not download the ${entry.family} tokenizer (${entry.id}). ${reasons.join('; ')}`);
}

/**
 * Gets a registry entry's file from the cache, downloading it from its pinned sources when absent.
 * @param {TokenizerSourceEntry} entry Registry entry
 * @param {import('./users.js').UserDirectoryList} [directories] The requesting user's directories, for their saved Hugging Face token
 * @returns {Promise<{ path: string, downloaded: boolean, license: string }>} `downloaded` is true only for the
 * call that fetched the file. `license` is that of the source the file came from when this call or one it
 * shared fetched it, else the entry's.
 */
export async function getPinnedTokenizerFile(entry, directories) {
    const cacheDir = path.join(globalThis.DATA_ROOT, '_cache');
    const cachedFile = path.join(cacheDir, getCacheFileName(entry));
    if (fs.existsSync(cachedFile)) {
        return { path: cachedFile, downloaded: false, license: entry.license };
    }

    const sha256 = entry.sha256.toLowerCase();
    const pending = inFlight.get(sha256);
    if (pending) {
        return { ...await pending, downloaded: false };
    }

    if (!IS_DOWNLOAD_ALLOWED) {
        throw new Error('Downloading tokenizers is disabled, the file is not cached');
    }

    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    const hfToken = directories ? readSecret(directories, SECRET_KEYS.HUGGINGFACE) : '';
    const download = downloadEntry(entry, cachedFile, hfToken);
    inFlight.set(sha256, download);
    try {
        return { ...await download, downloaded: true };
    } finally {
        inFlight.delete(sha256);
    }
}
