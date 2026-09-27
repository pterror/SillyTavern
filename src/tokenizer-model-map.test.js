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

/**
 * @param {string} api
 * @param {string} name
 * @param {string} source registry entry id
 */
function checkSource(api, name, source) {
    assert.deepEqual(lookupModelTokenizer(api, name), { source }, `${api} / ${JSON.stringify(name)}`);
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

// --- Gemma 1/2: a name with an explicit Gemma 1 or 2 version ---
for (const name of [
    'gemma-2-9b-it', 'google/gemma-2-27b-it', 'gemma2-9b-it', 'gemma2:27b', 'gemma2:latest', 'gemma-2b', 'gemma-7b-it',
    'gemma-1.1-7b-it', 'gemma:7b-instruct', 'gemma:2b', 'gemma:v1.1',
]) {
    check(GENERAL_API, name, tokenizers.GEMMA);
}
check(GENERAL_API, 'gemma-3-27b', null);
check(GENERAL_API, 'gemma_3', null);
check(GENERAL_API, 'gemma 3', null);
check(GENERAL_API, 'gemma.3', null);

// --- Gemma: one official file each ---
/**
 * @param {string} name
 * @param {string} source registry entry id
 */
function checkSelfHostedOnly(name, source) {
    assert.deepEqual(lookupModelTokenizer(GENERAL_API, name), { byBackend: { other: { source } } }, name);
}

// Gemma 3's -it file, for the models Google's API also serves.
for (const name of [
    'gemma-3-27b-it', 'google/gemma-3-1b-it', 'gemma-3-4b-it-Q4_K_M.gguf', 'unsloth/gemma-3-12b-it-GGUF',
    'mlabonne/gemma-3-27b-it-abliterated', 'gemma3:27b', 'gemma3:1b', 'gemma3:12b-it-q8_0', 'gemma3-12b',
]) {
    checkSelfHostedOnly(name, 'gemma-3-it');
}
// Gemma 3's -pt file: the -pt repos, 270m and 270m-it, the -it QAT repos, MedGemma, TranslateGemma, ShieldGemma 2.
for (const name of [
    'gemma-3-27b-pt', 'google/gemma-3-1b-pt', 'gemma-3-270m', 'gemma-3-270m-it', 'gemma3:270m',
    'gemma-3-12b-it-qat-q4_0-unquantized', 'gemma-3-27b-it-qat-int4-unquantized', 'gemma-3-27b-pt-qat-q4_0-gguf',
    'gemma3:27b-it-qat', 'medgemma-4b-it', 'medgemma-27b-text-it', 'medgemma-1.5-4b-it', 'medgemma:27b',
    'translategemma-12b-it', 'translategemma:27b', 'shieldgemma-2-4b-it',
]) {
    checkSource(GENERAL_API, name, 'gemma-3-pt');
}
// Gemma 3n: one file for E2B and E4B, base and -it.
for (const name of ['gemma-3n-E4B', 'gemma-3n-e2b']) {
    checkSource(GENERAL_API, name, 'gemma-3n');
}
for (const name of ['gemma-3n-E2B-it', 'google/gemma-3n-e4b-it', 'gemma3n:e2b', 'gemma3n:e4b-it-q8_0']) {
    checkSelfHostedOnly(name, 'gemma-3n');
}
// Gemma 4: the -it and base files have the same content; the assistant file lacks `<|video|>`.
for (const name of [
    'gemma-4-E4B-it', 'gemma-4-12B-it', 'gemma4:e2b', 'gemma4:12b', 'gemma-4-31B-it-qat-q4_0-unquantized',
    'gemma4:31b-it-qat', 'gemma-4-31B', 'gemma-4-E2B',
]) {
    checkSource(GENERAL_API, name, 'gemma-4');
}
for (const name of [
    'gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'google/gemma-4-31B-it', 'gemma-4-26b-a4b-it-maas', 'gemma4:31b',
    'gemma4:26b', 'gemma4:26b-a4b-it-mtp-q4_K_M', 'gemma4:31b-cloud',
]) {
    checkSelfHostedOnly(name, 'gemma-4');
}
for (const name of ['gemma-4-31B-it-assistant', 'gemma-4-12B-it-assistant', 'gemma-4-E4B-it-qat-q4_0-unquantized-assistant']) {
    checkSource(GENERAL_API, name, 'gemma-4-assistant');
}
for (const name of ['codegemma-7b-it', 'codegemma-2b', 'codegemma-1.1-7b-it', 'codegemma:7b-instruct-v1.1-q4_0', 'codegemma:2b-code']) {
    checkSource(GENERAL_API, name, 'codegemma');
}
for (const name of ['gemma-2-2b-jpn-it', 'google/gemma-2-2b-jpn-it-GGUF']) {
    checkSource(GENERAL_API, name, 'gemma-2-jpn');
}

// Unknown Gemma versions and sizes, names that pick no one model, and Gemma models whose files have no entry.
for (const name of [
    'gemma-5-9b', 'gemma-1.2-2b', 'gemma-2.5-9b', 'gemma-3.1-27b-it', 'gemma-4.1-31b-it', 'codegemma-2-7b',
    'medgemma-2-4b-it', 'translategemma-2-4b-it', 'shieldgemma-3-4b', 'gemma-3-2b-it', 'gemma-4-8b-it',
    'gemma', 'gemma:latest', 'gemma:instruct', 'gemma:text', 'gemma-it', 'Tiger-Gemma-9B-v3', 'Big-Tiger-Gemma-27B-v3',
    'gemma3', 'gemma3:latest', 'gemma-3', 'gemma3n', 'gemma3n:latest', 'gemma4', 'gemma4:latest', 'gemma4:cloud',
    'gemma4:31b-coding-mtp-bf16', 'codegemma', 'codegemma:latest', 'codegemma:instruct', 'codegemma:code',
    'medgemma:latest', 'translategemma:latest', 'functiongemma-270m-it', 'embeddinggemma-300m', 'paligemma2-3b-mix-224',
    'vaultgemma-1b',
]) {
    check(GENERAL_API, name, null);
}

// --- Yi ---
check(GENERAL_API, 'yi-34b-chat', tokenizers.YI);

// --- Jamba 1.5 ---
check(GENERAL_API, 'jamba-1.5-large', tokenizers.JAMBA);
check(GENERAL_API, 'jamba-instruct', null);

// --- Qwen2 ---
check(GENERAL_API, 'qwen2-72b-instruct', tokenizers.QWEN2);
checkSource(GENERAL_API, 'qwen2.5-72b', 'qwen2.5');
check(GENERAL_API, 'Qwen1.5-7B-Chat', tokenizers.QWEN2);
check(GENERAL_API, 'Qwen2-Audio-7B', tokenizers.QWEN2);

// --- Qwen: one official file each ---
checkSource(GENERAL_API, 'Qwen2-VL-7B-Instruct', 'qwen2-vl');
for (const name of [
    'Qwen2.5-7B-Instruct', 'Qwen2.5-Coder-32B-Instruct', 'Qwen2.5-Math-72B', 'Qwen2.5-VL-72B-Instruct',
    'Qwen2.5-14B-Instruct-1M', 'QwQ-32B-Preview', 'QVQ-72B-Preview', 'Qwen3-8B-Base', 'qwen2.5:7b',
]) {
    checkSource(GENERAL_API, name, 'qwen2.5');
}
for (const name of [
    'Qwen3-8B', 'qwen3:8b', 'Qwen3-30B-A3B-Instruct-2507', 'Qwen3-Next-80B-A3B-Instruct',
    'Qwen3-Coder-480B-A35B-Instruct', 'Qwen3-Coder-Next', 'Qwen3-Coder-Next-Base', 'Qwen3-VL-8B-Instruct',
    'QwQ-32B', 'Qwen3-Reranker-8B', 'qwen3-235b-a22b-thinking-2507',
]) {
    checkSource(GENERAL_API, name, 'qwen3');
}
for (const name of ['Qwen3.5-9B', 'Qwen3.6-27B', 'qwen3.5:0.8b', 'qwen3.5-27b:thinking']) {
    checkSource(GENERAL_API, name, 'qwen3.5');
}
checkSource(GENERAL_API, 'Qwen3.5-9B-Base', 'qwen3.5-base');
for (const name of ['Qwen3.8-27B', 'Qwen3.8-2.4T-A95B', 'Qwen3.8-Flash-Next']) {
    checkSource(GENERAL_API, name, 'qwen3.8');
}
checkSource(GENERAL_API, 'CodeQwen1.5-7B-Chat', 'codeqwen1.5');

// Qwen repos whose file differs from their family's (or that have none) are unmapped.
for (const name of [
    'Qwen2-VL-7B-Instruct-AWQ', 'Qwen2-VL-2B-Instruct-GPTQ-Int4', 'Qwen2.5-Omni-7B', 'Qwen2.5-Math-PRM-72B',
    'Qwen2.5-Math-7B-PRM800K', 'Qwen3-Embedding-8B', 'Qwen3-VL-Embedding-2B', 'Qwen3-ASR-1.7B',
    'Qwen3-ForcedAligner-0.6B', 'Qwen3-TTS-12Hz-1.7B-Base', 'Qwen3-Omni-30B-A3B-Instruct',
    'Qwen3-235B-A22B-MLX-4bit',
]) {
    check(GENERAL_API, name, null);
}

// Closed DashScope ids count by estimate.
for (const name of [
    'qwen3.5-plus', 'qwen3.5-flash-02-23', 'qwen3.6-max-preview', 'qwen3.8-flash', 'qwen3.8-max',
    'qwen3.8-omni-flash', 'qwen3-8-omni-flash', 'qwen3-max', 'qwen3-max-2025-09-23', 'qwen3-coder-plus',
    'qwen3-coder-flash', 'qwen3-vl-plus', 'qwen3-vl-flash', 'qwen3-tts-flash', 'qwen3-rerank', 'qwq-plus',
    'qvq-max', 'qwen-plus', 'qwen-max', 'qwen-turbo',
]) {
    check(GENERAL_API, name, null);
}

// A Qwen name that doesn't pick one model is a moving alias.
for (const alias of [
    'qwen3', 'qwen3:latest', 'qwen3.6', 'qwen3.6:latest', 'qwen3.7', 'qwen3-coder', 'qwen3-vl', 'qwen3-vl-pro',
    'qwen3-vl-instruct', 'qwen3-next', 'qwq', 'qwen2.5-coder', 'qwen1.5', 'codeqwen1.5', 'qwen3.5', 'qwen3.8',
]) {
    check(GENERAL_API, alias, null);
    check('openai', alias, null);
}

// An unknown Qwen3 version is unmapped.
check(GENERAL_API, 'qwen3.7-27b', null);

// --- Command-R ---
check(GENERAL_API, 'command-r-plus', tokenizers.COMMAND_R);
check(GENERAL_API, 'command-r7b-12-2024', null);

// --- Command-A ---
check(GENERAL_API, 'command-a-03-2025', tokenizers.COMMAND_A);
check(GENERAL_API, 'command-r', tokenizers.COMMAND_R);
check(GENERAL_API, 'command', null);

// --- DeepSeek: one official file each ---
for (const name of ['DeepSeek-V2-Lite-Chat', 'DeepSeek-V2', 'deepseek-v2:16b', 'deepseek-v2:latest']) {
    checkSource(GENERAL_API, name, 'deepseek-v2');
}
for (const name of ['DeepSeek-V2.5-1210', 'DeepSeek-V2-Chat-0628', 'DeepSeek-Coder-V2-Lite-Instruct', 'deepseek-coder-v2:16b', 'deepseek-coder-v2:latest', 'deepseek-v2.5:latest']) {
    checkSource(GENERAL_API, name, 'deepseek-v2.5');
}
for (const name of ['deepseek-v3', 'DeepSeek-V3-Base', 'DeepSeek-V3-0324', 'deepseek-v3:671b', 'deepseek-v3:latest']) {
    check(GENERAL_API, name, tokenizers.DEEPSEEK);
}
for (const name of ['deepseek-v3.1', 'DeepSeek-V3.1-Terminus', 'DeepSeek-V3.1-Base', 'DeepSeek-V3.2-Exp', 'DeepSeek-V3.2-Exp-Base', 'deepseek-v3.1:latest']) {
    checkSource(GENERAL_API, name, 'deepseek-v3.1');
}
for (const name of ['DeepSeek-V3.2', 'DeepSeek-V3.2-Speciale', 'deepseek/deepseek-v3.2']) {
    checkSource(GENERAL_API, name, 'deepseek-v3.2');
}
for (const name of ['DeepSeek-R1-0528', 'DeepSeek-R1-Zero', 'deepseek-r1:671b', 'deepseek-r1:671b-0528-q4_K_M']) {
    checkSource(GENERAL_API, name, 'deepseek-r1');
}
for (const name of [
    'DeepSeek-R1-Distill-Qwen-7B', 'DeepSeek-R1-Distill-Qwen-32B', 'deepseek-r1:1.5b-qwen-distill-q4_K_M',
    'deepseek-r1:7b-qwen-distill-fp16', 'deepseek-r1:14b-qwen-distill-q8_0', 'deepseek-r1:32b-qwen-distill-q4_K_M',
]) {
    checkSource(GENERAL_API, name, 'deepseek-r1-distill-qwen');
}
for (const name of ['DeepSeek-R1-Distill-Llama-8B', 'DeepSeek-R1-Distill-Llama-70B', 'deepseek-r1:8b-llama-distill-q4_K_M', 'deepseek-r1:70b-llama-distill-q8_0']) {
    checkSource(GENERAL_API, name, 'deepseek-r1-distill-llama');
}
// This merge ships llama3.json's content, not the distill's.
check(GENERAL_API, 'mergekit-community/Llama-3-DeepSeek-R1-Distill-8B-LewdPlay-Uncensored', tokenizers.LLAMA3);
checkSource(GENERAL_API, 'DeepSeek-R1-0528-Qwen3-8B', 'deepseek-r1-0528-qwen3');
for (const name of ['DeepSeek-V4-Pro', 'DeepSeek-V4-Flash-0731', 'DeepSeek-V4-Pro-0813', 'DeepSeek-V4-Flash-DSpark', 'DeepSeek-V4-Pro-Base']) {
    assert.deepEqual(lookupModelTokenizer(GENERAL_API, name), { byBackend: { other: { source: 'deepseek-v4' } } }, name);
}
for (const name of ['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Flash-Vision-Exp']) {
    checkSource(GENERAL_API, name, 'deepseek-v4.1');
}

// Unknown DeepSeek versions are unmapped.
for (const name of ['deepseek-v3.5', 'deepseek-v3-1226', 'deepseek-v4.2-flash']) {
    check(GENERAL_API, name, null);
}

// DeepSeek names that don't name one official file are unmapped: Ollama's bare `deepseek-r1` and its
// sizes other than 671b are the distills; `deepseek-v4`, `deepseek-v4-lite`, `-latest` and
// `~deepseek/…` are moving aliases; the rest ship other files, or have no rule.
for (const name of [
    'DeepSeek-R1', 'deepseek-r1', 'deepseek-r1:latest', 'deepseek-r1:1.5b', 'deepseek-r1:8b', 'deepseek-r1:32b', 'deepseek-r1:70b',
    'deepseek-r1:8b-0528-qwen3-q4_K_M', 'r1-1776:70b-distill-llama-q4_K_M',
    'deepseek-v4', 'deepseek-v4-lite', 'deepseek-lite', 'deepseek-v4-flash-latest', 'deepseek/deepseek-v4-flash-latest',
    '~deepseek/deepseek-v4-flash-latest', '~deepseek/deepseek-pro-latest', 'deepseek/deepseek-latest',
    'mlx-community/DeepSeek-V4-Pro-Qwen3.5-9B-4bit', 'NousResearch/DeepSeek-V3.1-Alternate-Tokenizer',
    'DevQuasar/deepseek-ai.DeepSeek-V3.2-Speciale-Channel-INT8', 'FuseO1-DeepSeekR1-Qwen2.5-Instruct-32B-Preview',
    'DeepSeek-Prover-V2-671B', 'DeepSeek-Prover-V1.5-RL', 'DeepSeek-Math-V2', 'deepseek-math-7b-instruct',
    'ESFT-token-code-lite', 'deepseek/deepseek-chat-v3.1', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-flash',
    'deepseek-coder-33b-instruct', 'deepseek-coder-7b-instruct-v1.5', 'deepseek-llm-67b-chat', 'deepseek-moe-16b-chat',
    'deepseek-vl2', 'deepseek-vl-7b-chat', 'Janus-Pro-7B', 'DeepSeek-OCR',
]) {
    check(GENERAL_API, name, null);
}

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

// --- registry results, `supersedes`, several official files, moving aliases ---
const { pickMapResult } = await import('./tokenizer-model-map.js');
assert.equal(typeof pickMapResult, 'function', 'pickMapResult is exported');

// A registry result `{ source }` is told apart by its entry id.
assert.deepEqual(pickMapResult([{ result: { source: 'a' } }, { result: { source: 'a' } }]), { source: 'a' });
assert.equal(pickMapResult([{ result: { source: 'a' } }, { result: { source: 'b' } }]), null, 'two entries with different results stay unmapped');
assert.equal(pickMapResult([{ result: { source: 'a' } }, { result: tokenizers.QWEN2 }]), null);
assert.equal(pickMapResult([]), null);

// An entry that supersedes another wins when both match; it names a registry entry id, a
// `tokenizers` key, or `tiktoken` for the tiktoken lookup.
const distillQwen = { result: { source: 'r1-distill-qwen' }, supersedes: ['qwen2.5'] };
assert.deepEqual(pickMapResult([{ result: { source: 'qwen2.5' } }, distillQwen]), { source: 'r1-distill-qwen' });
assert.deepEqual(pickMapResult([distillQwen, { result: { source: 'qwen2.5' } }]), { source: 'r1-distill-qwen' }, 'order does not matter');
assert.deepEqual(pickMapResult([distillQwen]), { source: 'r1-distill-qwen' });
assert.deepEqual(pickMapResult([{ result: { source: 'qwen2.5' } }]), { source: 'qwen2.5' }, 'a superseded entry matching alone stands');
assert.deepEqual(pickMapResult([{ result: tokenizers.LLAMA3 }, { result: { source: 'r1-distill-llama' }, supersedes: ['llama3', 'llama3.1'] }]), { source: 'r1-distill-llama' });
assert.deepEqual(pickMapResult([{ result: 'gpt-4o' }, { result: { source: 'gpt-oss' }, supersedes: ['tiktoken'] }]), { source: 'gpt-oss' });
assert.equal(pickMapResult([{ result: tokenizers.QWEN2 }, distillQwen]), null, 'a match with no supersedes relation still makes the name unmapped');
assert.equal(pickMapResult([
    { result: { source: 'a' }, supersedes: ['b'] },
    { result: { source: 'b' }, supersedes: ['a'] },
]), null, 'entries superseding each other leave nothing');

// One model, several official files: one result carrying a file per kind of backend.
const severalFiles = { byBackend: { vendorApis: { mistralai: { source: 'nemo-tekken' } }, hf: tokenizers.NEMO } };
assert.deepEqual(pickMapResult([{ result: severalFiles }, { result: structuredClone(severalFiles) }]), severalFiles);
assert.equal(pickMapResult([{ result: severalFiles }, { result: tokenizers.NEMO }]), null);

// Ids that point at different models over time are never in the map.
for (const alias of [
    'deepseek-chat', 'deepseek-flash', 'deepseek-reasoner',
    'mistral-large-latest', 'mistral-small-latest', 'mistral-small', 'open-mistral-7b', 'open-mixtral-8x22b',
    'qwen-plus-latest', 'jamba-mini', 'jamba-large', 'mistralai/mistral-large',
]) {
    check(GENERAL_API, alias, null);
    check('openai', alias, null);
}

// DeepSeek's hosted `deepseek-v4-pro` and `deepseek-v4-flash` are moving aliases: unmapped everywhere
// except on a self-hosted backend, where the name is the weights the user loaded.
const { selectBackendResult } = await import('./tokenizer-map-resolution.js');
const { CHAT_COMPLETION_SOURCES, TEXTGEN_TYPES } = await import('./constants.js');
const selfHostedTextgen = ['ooba', 'vllm', 'aphrodite', 'tabby', 'koboldcpp', 'llamacpp', 'ollama'];
const backendStates = [
    ...Object.values(CHAT_COMPLETION_SOURCES).map(source => ({ api: 'openai', source })),
    { api: 'openai' },
    ...Object.values(TEXTGEN_TYPES).map(type => ({ api: GENERAL_API, type })),
    { api: 'kobold' },
    { api: 'koboldhorde' },
    { api: 'novel' },
];
for (const alias of ['deepseek-v4-pro', 'deepseek-v4-flash']) {
    for (const state of backendStates) {
        const selfHosted = state.api === 'kobold' || (state.api === GENERAL_API && selfHostedTextgen.includes(state.type));
        assert.deepEqual(
            selectBackendResult(lookupModelTokenizer(state.api, alias), state),
            selfHosted ? { source: 'deepseek-v4' } : null,
            `${alias} on ${JSON.stringify(state)}`,
        );
    }
}

// DeepSeek's own API gives every id the estimate.
for (const name of ['deepseek-v3', 'deepseek-v3.1', 'DeepSeek-V3.2', 'deepseek-v4.1-flash', 'DeepSeek-R1-0528', 'deepseek-chat']) {
    assert.equal(selectBackendResult(lookupModelTokenizer('openai', name), { api: 'openai', source: 'deepseek' }), null, name);
}

// Gemma models Google's own API also serves (gemma-4-31b-it, gemma-4-26b-a4b-it, gemma-3-*-it, gemma-3n-*-it)
// map only on a self-hosted backend. The others map on every backend.
/** @param {{ api: string, type?: string }} state */
const isSelfHosted = state => state.api === 'kobold' || (state.api === GENERAL_API && selfHostedTextgen.includes(state.type));
for (const [name, source] of [['gemma-3-27b-it', 'gemma-3-it'], ['gemma-3n-e4b-it', 'gemma-3n'], ['gemma-4-31b-it', 'gemma-4'], ['gemma-4-26b-a4b-it', 'gemma-4']]) {
    for (const state of backendStates) {
        assert.deepEqual(selectBackendResult(lookupModelTokenizer(state.api, name), state), isSelfHosted(state) ? { source } : null, `${name} on ${JSON.stringify(state)}`);
    }
}
for (const [name, source] of [['gemma-3-27b-pt', 'gemma-3-pt'], ['gemma-4-E4B-it', 'gemma-4'], ['gemma-4-31B-it-assistant', 'gemma-4-assistant'], ['codegemma-7b-it', 'codegemma']]) {
    for (const state of backendStates) {
        const unmapped = state.api === 'novel' || (state.api === 'openai' && state.source === CHAT_COMPLETION_SOURCES.DEEPSEEK);
        assert.deepEqual(selectBackendResult(lookupModelTokenizer(state.api, name), state), unmapped ? null : { source }, `${name} on ${JSON.stringify(state)}`);
    }
}

console.log('tokenizer-model-map tests passed');
