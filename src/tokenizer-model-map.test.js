import assert from 'node:assert/strict';
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
check(GENERAL_API, 'yi-1.5-34b', null);

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

const llama3 = JSON.parse(fs.readFileSync(path.join(tokenizersDir, 'llama3.json'), 'utf8'));
assert.equal(Object.keys(llama3.model.vocab).length, 128000, 'llama3.json model.vocab size');
assert.equal(llama3.added_tokens.length, 256, 'llama3.json added_tokens size');
const addedById = new Map(llama3.added_tokens.map(t => [t.id, t.content]));
assert.equal(addedById.get(128004), '<|reserved_special_token_2|>');
assert.equal(addedById.get(128008), '<|reserved_special_token_4|>');

console.log('tokenizer-model-map tests passed');
