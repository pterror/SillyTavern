import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tokenizer-resolve.js (which owns the `tokenizers` enum) statically imports
// src/endpoints/tokenizers.js, which reads process-wide config at module import time - the config
// path must be set before that import chain runs, so both modules are imported dynamically,
// after setConfigFilePath().
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

const { tokenizers } = await import('./tokenizer-resolve.js');
const { lookupModelTokenizer } = await import('./tokenizer-model-map.js');

const GENERAL_API = 'textgenerationwebui';

/**
 * @param {string} api
 * @param {any} name
 * @param {number|string|null} expected
 */
function check(api, name, expected) {
    assert.equal(lookupModelTokenizer(api, name), expected, `${api} / ${JSON.stringify(name)}`);
}

// --- Llama 2 ---
check(GENERAL_API, 'llama-2-13b-chat', tokenizers.LLAMA);
check(GENERAL_API, 'codellama-13b', null);

// --- Llama 3.0 ---
check(GENERAL_API, 'Llama-3-8B', tokenizers.LLAMA3);
check(GENERAL_API, 'llama-3.1-8b', null);
// any occurrence failing its "not followed by" check leaves the name unmapped
check(GENERAL_API, 'llama-3-llama-3.1', null);

// --- Mistral V1 ---
check(GENERAL_API, 'mistral-7b-instruct-v0.2', tokenizers.MISTRAL);
check(GENERAL_API, 'mixtral-8x7b-instruct-v0.1', tokenizers.MISTRAL);
check(GENERAL_API, 'mistral-7b-instruct-v0.3', null);

// --- Mistral NeMo ---
check(GENERAL_API, 'Mistral-Nemo-Instruct-2407', tokenizers.NEMO);
check(GENERAL_API, 'nemotron-70b', null);

// --- Gemma 1/2 ---
check(GENERAL_API, 'gemma-2-9b-it', tokenizers.GEMMA);
check(GENERAL_API, 'gemma-3-27b', null);
check(GENERAL_API, 'gemma_3', null);
check(GENERAL_API, 'gemma 3', null);
check(GENERAL_API, 'gemma.3', null);
check(GENERAL_API, 'gemma-3n-e4b', null);
check(GENERAL_API, 'gemma3-12b', null);

// --- Yi ---
check(GENERAL_API, 'yi-34b-chat', tokenizers.YI);

// --- Jamba 1.5 ---
check(GENERAL_API, 'jamba-1.5-large', tokenizers.JAMBA);
check(GENERAL_API, 'jamba-instruct', null);

// --- Qwen2 ---
check(GENERAL_API, 'qwen2-72b-instruct', tokenizers.QWEN2);
check(GENERAL_API, 'qwen2.5-72b', null);

// --- Command-R ---
check(GENERAL_API, 'command-r-plus', tokenizers.COMMAND_R);
check(GENERAL_API, 'command-r7b-12-2024', null);

// --- Command-A ---
check(GENERAL_API, 'command-a-03-2025', tokenizers.COMMAND_A);
check(GENERAL_API, 'command-r', tokenizers.COMMAND_R);
check(GENERAL_API, 'command', null);

// --- DeepSeek V3 ---
check(GENERAL_API, 'deepseek-v3', tokenizers.DEEPSEEK);
check(GENERAL_API, 'deepseek-v3.1', null);

// --- OpenAI (tiktoken on the lowercased raw name) ---
check(GENERAL_API, 'GPT-4o', 'gpt-4o');
check(GENERAL_API, 'gpt-oss-120b', null);
check(GENERAL_API, 'gpt_4o', null);
check(GENERAL_API, 'gpt 4o', null);
check(GENERAL_API, 'gpt.4o', null);

// --- NovelAI: only the NovelAI entries ---
check('novel', 'clio-v1', tokenizers.NERD);
check('novel', 'kayra-v1', tokenizers.NERD2);
check('novel', 'erato-v1', tokenizers.LLAMA3);
check('novel', 'llama-3-8b', null);
check('novel', 'clio-kayra', null);
check(GENERAL_API, 'kayra-v1', null);

// --- models whose official tokenizer.model is byte-identical to a bundled file ---
// Yi 1.5 (every 01-ai/Yi-1.5-* tokenizer.model is yi.model)
check(GENERAL_API, 'Yi-1.5-34B-Chat', tokenizers.YI);
check(GENERAL_API, 'yi-1.5-34b', tokenizers.YI);
check(GENERAL_API, 'yi1-34b', null);

// Jamba 1.6 / 1.7 and Jamba-tiny-dev (their tokenizer.model is jamba.model)
check(GENERAL_API, 'AI21-Jamba-Mini-1.7', tokenizers.JAMBA);
check(GENERAL_API, 'AI21-Jamba-Large-1.6', tokenizers.JAMBA);
check(GENERAL_API, 'jamba-1.6-mini', tokenizers.JAMBA);
check(GENERAL_API, 'jamba-1.7-large', tokenizers.JAMBA);
check(GENERAL_API, 'Jamba-tiny-dev', tokenizers.JAMBA);
check(GENERAL_API, 'Jamba-v0.1', null);
check(GENERAL_API, 'AI21-Jamba2-Mini', null);
check(GENERAL_API, 'AI21-Jamba-Reasoning-3B', null);
check(GENERAL_API, 'jamba-large', null);

// Phi-3 / Phi-3.5, not small (cl100k) and not vision (no tokenizer.model; its tokenizer.json differs)
check(GENERAL_API, 'Phi-3.5-mini-instruct', tokenizers.LLAMA);
check(GENERAL_API, 'Phi-3-mini-4k-instruct', tokenizers.LLAMA);
check(GENERAL_API, 'Phi-3-medium-128k-instruct', tokenizers.LLAMA);
check(GENERAL_API, 'Phi-3.5-MoE-instruct', tokenizers.LLAMA);
check(GENERAL_API, 'Phi-3-small-8k-instruct', null);
check(GENERAL_API, 'Phi-3-vision-128k-instruct', null);
check(GENERAL_API, 'Phi-3.5-vision-instruct', null);
check(GENERAL_API, 'phi-3.1-mini', null);
check(GENERAL_API, 'phi-4', null);

// Mixtral 8x22B base v0.1 (mistral.model); the Instruct and v0.3 files differ
check(GENERAL_API, 'Mixtral-8x22B-v0.1', tokenizers.MISTRAL);
check(GENERAL_API, 'Mixtral-8x22B-Instruct-v0.1', null);
check(GENERAL_API, 'mixtral-8x22B-v0.3', null);
check(GENERAL_API, 'open-mixtral-8x22b', null);

// CodeLlama 34b (llama.model); the 7b/13b base and Instruct and all 70b files differ
check(GENERAL_API, 'CodeLlama-34b-Instruct-hf', tokenizers.LLAMA);
check(GENERAL_API, 'CodeLlama-34b-Python-hf', tokenizers.LLAMA);
check(GENERAL_API, 'CodeLlama-7b-hf', null);
check(GENERAL_API, 'CodeLlama-70b-hf', null);
check(GENERAL_API, 'CodeLlama-7b-Python-hf', tokenizers.LLAMA);
check(GENERAL_API, 'CodeLlama-13b-Python-hf', tokenizers.LLAMA);
check(GENERAL_API, 'codellama:7b-python-q4_0', tokenizers.LLAMA);
check(GENERAL_API, 'codellama:34b', tokenizers.LLAMA);
check(GENERAL_API, 'CodeLlama-7b-Instruct-hf', null);
check(GENERAL_API, 'CodeLlama-70b-Python-hf', null);
check(GENERAL_API, 'codellama:python', null);

// Jamba-tiny-reward-dev (jamba.model)
check(GENERAL_API, 'Jamba-tiny-reward-dev', tokenizers.JAMBA);
check(GENERAL_API, 'Jamba-tiny-random', null);

// Ollama's single-token Phi forms (phi3 is Phi-3 mini/medium, phi3.5 is Phi-3.5-mini)
check(GENERAL_API, 'phi3:mini', tokenizers.LLAMA);
check(GENERAL_API, 'phi3:14b-medium-4k-instruct-q4_0', tokenizers.LLAMA);
check(GENERAL_API, 'phi3.5:3.8b-mini-instruct-q4_0', tokenizers.LLAMA);
// ':' is a separator like '.', so 'phi3:3.8b' reads as 'phi3.3.8b' (an unknown version)
check(GENERAL_API, 'phi3:3.8b', null);
check(GENERAL_API, 'phi3-small', null);
check(GENERAL_API, 'phi3-vision', null);

// Gemma-derived models whose tokenizer.model (RecurrentGemma sfp-cpp: tokenizer.spm) is gemma.model
check(GENERAL_API, 'recurrentgemma-2b-it', tokenizers.GEMMA);
check(GENERAL_API, 'recurrentgemma-9b', tokenizers.GEMMA);
check(GENERAL_API, 'recurrentgemma-2b-it-sfp-cpp', tokenizers.GEMMA);
check(GENERAL_API, 'shieldgemma-2b', tokenizers.GEMMA);
check(GENERAL_API, 'shieldgemma:27b', tokenizers.GEMMA);
check(GENERAL_API, 'shieldgemma-2-4b-it', null);
check(GENERAL_API, 'datagemma-rig-27b-it', tokenizers.GEMMA);
check(GENERAL_API, 'datagemma-rag-27b-it', tokenizers.GEMMA);
check(GENERAL_API, 'txgemma-2b-predict', tokenizers.GEMMA);
check(GENERAL_API, 'txgemma-9b-chat', tokenizers.GEMMA);
check(GENERAL_API, 'txgemma-27b-predict', tokenizers.GEMMA);
check(GENERAL_API, 'txgemma-2b-chat', null);

// --- separator forms ---
check(GENERAL_API, 'llama 2', tokenizers.LLAMA);
check(GENERAL_API, 'llama.2', tokenizers.LLAMA);
check(GENERAL_API, 'llama_2', tokenizers.LLAMA);

// --- unmapped ---
check(GENERAL_API, 'claude-sonnet-4', null);
check(GENERAL_API, 'gemini-2.5-pro', null);
check(GENERAL_API, '', null);
check(GENERAL_API, undefined, null);
check(GENERAL_API, 42, null);

// --- facts about the bundled tokenizer files, so a replaced file fails this test ---

/**
 * Counts the top-level repeated field 1 (`pieces`) of a sentencepiece ModelProto.
 * @param {Buffer} buf
 * @returns {number}
 */
function countSentencepiecePieces(buf) {
    let pos = 0;
    const readVarint = () => {
        let result = 0n;
        let shift = 0n;
        for (;;) {
            assert.ok(pos < buf.length, 'truncated varint');
            const byte = buf[pos++];
            result |= BigInt(byte & 0x7f) << shift;
            shift += 7n;
            if (!(byte & 0x80)) return result;
        }
    };
    let count = 0;
    while (pos < buf.length) {
        const key = Number(readVarint());
        const fieldNumber = key >>> 3;
        const wireType = key & 7;
        if (wireType === 0) {
            readVarint();
        } else if (wireType === 1) {
            pos += 8;
        } else if (wireType === 5) {
            pos += 4;
        } else if (wireType === 2) {
            const length = Number(readVarint());
            if (fieldNumber === 1) count++;
            pos += length;
        } else {
            assert.fail(`unexpected wire type ${wireType}`);
        }
    }
    assert.equal(pos, buf.length, 'protobuf walk overran the file');
    return count;
}

const tokenizersDir = path.join(__dirname, 'tokenizers');
const expectedPieceCounts = {
    'llama.model': 32000,
    'mistral.model': 32000,
    'gemma.model': 256000,
    'yi.model': 64000,
    'jamba.model': 65536,
};
for (const [file, expected] of Object.entries(expectedPieceCounts)) {
    const buf = fs.readFileSync(path.join(tokenizersDir, file));
    assert.equal(countSentencepiecePieces(buf), expected, `${file} piece count`);
}

// sha256 of each bundled .model, which is byte-identical to the official files named above
const expectedSha256 = {
    'llama.model': '9e556afd44213b6bd1be2b850ebbbd98f5481437a8021afaf58ee7fb1818d347',
    'mistral.model': 'dadfd56d766715c61d2ef780a525ab43b8e6da4de6865bda3d95fdef5e134055',
    'gemma.model': '61a7b147390c64585d6c3543dd6fc636906c9af3865a5548f27f31aee1d4c8e2',
    'yi.model': '386c49cf943d71aa110361135338c50e38beeff0a66593480421f37b319e1a39',
    'jamba.model': '8b0df4fb43262c452ef37061951a06df4c63ca191d02a60ea08f14428af24376',
};
for (const [file, expected] of Object.entries(expectedSha256)) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(tokenizersDir, file))).digest('hex');
    assert.equal(digest, expected, `${file} sha256`);
}

const llama3 = JSON.parse(fs.readFileSync(path.join(tokenizersDir, 'llama3.json'), 'utf8'));
assert.equal(Object.keys(llama3.model.vocab).length, 128000, 'llama3.json model.vocab size');
assert.equal(llama3.added_tokens.length, 256, 'llama3.json added_tokens size');
const addedById = new Map(llama3.added_tokens.map(t => [t.id, t.content]));
assert.equal(addedById.get(128004), '<|reserved_special_token_2|>');
assert.equal(addedById.get(128008), '<|reserved_special_token_4|>');

console.log('tokenizer-model-map tests passed');
