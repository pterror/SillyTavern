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
 * One place a registry entry's file can be downloaded from, pinned to a commit.
 * @typedef {object} TokenizerSource
 * @property {string} repo Hugging Face repo, `owner/name`
 * @property {string} revision Full 40-hex commit sha
 * @property {string} path File path inside the repo at that revision
 * @property {boolean} gated Whether the repo is gated. Only the model's own (official) repo can be.
 */

/**
 * One official tokenizer file. Every source of an entry serves the same bytes.
 * @typedef {object} TokenizerSourceEntry
 * @property {string} id
 * @property {string} family
 * @property {TokenizerFileFormat} format
 * @property {string} sha256 64-hex sha256 of the file
 * @property {number} bytes File size in bytes
 * @property {string} license License name
 * @property {string} licenseUrl
 * @property {readonly TokenizerSource[]} sources Tried in order: the model's own repo first, then verified byte-identical copies
 * @property {import('./tokenizer-loader.js').TiktokenConfig} [tiktoken] For the `tiktoken` format: how the repo's own code builds its encoding
 */

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
        license: 'Modified MIT',
        licenseUrl: 'https://huggingface.co/moonshotai/Kimi-K2-Instruct/blob/fd1984e2b7a3350dbf7305fe73a4ede25c14de50/LICENSE',
        sources: [
            { repo: 'moonshotai/Kimi-K2-Instruct', revision: 'fd1984e2b7a3350dbf7305fe73a4ede25c14de50', path: 'tiktoken.model', gated: false },
        ],
        // tokenization_kimi.py and tokenizer_config.json at the same revision.
        tiktoken: {
            patStr: [
                String.raw`[\p{Han}]+`,
                String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?`,
                String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?`,
                String.raw`\p{N}{1,3}`,
                String.raw` ?[^\s\p{L}\p{N}]+[\r\n]*`,
                String.raw`\s*[\r\n]+`,
                String.raw`\s+(?!\S)`,
                String.raw`\s+`,
            ].join('|'),
            specialTokens: {
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
            },
            reservedSpecialTokens: { start: 163584, count: 256, name: '<|reserved_token_{id}|>' },
            allowedSpecial: 'all',
            split: { maxChars: 400000, maxRun: 25000 },
        },
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
 * The name an entry's tokenizer is shown under, also its Advanced Formatting → Tokenizer option.
 * @param {TokenizerSourceEntry} entry
 * @returns {string}
 */
export function getTokenizerDisplayName(entry) {
    return `${entry.family} (official)`;
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
    return `https://huggingface.co/${source.repo}/resolve/${source.revision}/${source.path}`;
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
 * @type {Map<string, Promise<string>>}
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
 * @returns {Promise<string>} The cached file's path
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
            console.info(`Downloaded the ${entry.family} tokenizer. License: ${entry.license}`);
            return cachedFile;
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
 * @returns {Promise<{ path: string, downloaded: boolean, license: string }>} `downloaded` is true only for the call that fetched the file
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
        return { path: await pending, downloaded: false, license: entry.license };
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
        return { path: await download, downloaded: true, license: entry.license };
    } finally {
        inFlight.delete(sha256);
    }
}
