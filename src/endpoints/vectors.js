import path from 'node:path';
import fs from 'node:fs';

import vectra from 'vectra';
import express from 'express';
import sanitize from 'sanitize-filename';

import { getConfigValue } from '../util.js';

import { getNomicAIBatchVector, getNomicAIVector } from '../vectors/nomicai-vectors.js';
import { getOpenAIVector, getOpenAIBatchVector } from '../vectors/openai-vectors.js';
import { getTransformersVector, getTransformersBatchVector } from '../vectors/embedding.js';
import { getExtrasVector, getExtrasBatchVector } from '../vectors/extras-vectors.js';
import { getMakerSuiteVector, getMakerSuiteBatchVector } from '../vectors/google-vectors.js';
import { getVertexVector, getVertexBatchVector } from '../vectors/google-vectors.js';
import { getCohereVector, getCohereBatchVector } from '../vectors/cohere-vectors.js';
import { getLlamaCppVector, getLlamaCppBatchVector } from '../vectors/llamacpp-vectors.js';
import { getVllmVector, getVllmBatchVector } from '../vectors/vllm-vectors.js';
import { getOllamaVector, getOllamaBatchVector } from '../vectors/ollama-vectors.js';

// Don't forget to add new sources to the SOURCES array
const SOURCES = [
    'transformers',
    'mistral',
    'openai',
    'extras',
    'palm',
    'togetherai',
    'nomicai',
    'cohere',
    'ollama',
    'llamacpp',
    'vllm',
    'webllm',
    'koboldcpp',
    'vertexai',
    'electronhub',
    'openrouter',
    'chutes',
    'nanogpt',
    'siliconflow',
    'workers_ai',
];

/**
 * Per-source vectorizer dispatch table. Each entry bundles the three pieces of per-source behavior that
 * getVector/getBatchVector/getSourceSettings used to hand-write in three separate switches over the same
 * source labels: how to embed one text, how to embed a batch, and how to build sourceSettings from a request.
 * @type {Record<string, {
 *   getVector: (text: string, sourceSettings: object, isQuery: boolean, directories: import('../users.js').UserDirectoryList) => Promise<number[]>|number[],
 *   getBatchVector: (batch: string[], sourceSettings: object, isQuery: boolean, directories: import('../users.js').UserDirectoryList) => Promise<number[][]>|number[][],
 *   getSettings: (request: object) => object,
 * }>}
 */
const VECTOR_SOURCES = {
    nomicai: {
        getVector: (text, sourceSettings, isQuery, directories) => getNomicAIVector(text, 'nomicai', directories),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getNomicAIBatchVector(batch, 'nomicai', directories),
        getSettings: () => ({ model: 'nomic-embed-text-v1.5' }),
    },
    togetherai: {
        getVector: (text, sourceSettings, isQuery, directories) => getOpenAIVector(text, 'togetherai', directories, sourceSettings.model),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getOpenAIBatchVector(batch, 'togetherai', directories, sourceSettings.model),
        getSettings: (request) => ({ model: String(request.body.model) }),
    },
    mistral: {
        getVector: (text, sourceSettings, isQuery, directories) => getOpenAIVector(text, 'mistral', directories, sourceSettings.model),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getOpenAIBatchVector(batch, 'mistral', directories, sourceSettings.model),
        getSettings: () => ({ model: 'mistral-embed' }),
    },
    openai: {
        getVector: (text, sourceSettings, isQuery, directories) => getOpenAIVector(text, 'openai', directories, sourceSettings.model),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getOpenAIBatchVector(batch, 'openai', directories, sourceSettings.model),
        getSettings: (request) => ({ model: String(request.body.model) }),
    },
    electronhub: {
        getVector: (text, sourceSettings, isQuery, directories) => getOpenAIVector(text, 'electronhub', directories, sourceSettings.model),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getOpenAIBatchVector(batch, 'electronhub', directories, sourceSettings.model),
        getSettings: (request) => ({ model: String(request.body.model || 'text-embedding-3-small') }),
    },
    openrouter: {
        getVector: (text, sourceSettings, isQuery, directories) => getOpenAIVector(text, 'openrouter', directories, sourceSettings.model),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getOpenAIBatchVector(batch, 'openrouter', directories, sourceSettings.model),
        getSettings: (request) => ({ model: String(request.body.model) || 'openai/text-embedding-3-large' }),
    },
    transformers: {
        getVector: (text) => getTransformersVector(text),
        getBatchVector: (batch) => getTransformersBatchVector(batch),
        getSettings: () => ({ model: getConfigValue('extensions.models.embedding', '') }),
    },
    extras: {
        getVector: (text, sourceSettings) => getExtrasVector(text, sourceSettings.extrasUrl, sourceSettings.extrasKey),
        getBatchVector: (batch, sourceSettings) => getExtrasBatchVector(batch, sourceSettings.extrasUrl, sourceSettings.extrasKey),
        getSettings: (request) => ({ extrasUrl: String(request.body.extrasUrl), extrasKey: String(request.body.extrasKey) }),
    },
    palm: {
        getVector: (text, sourceSettings) => getMakerSuiteVector(text, sourceSettings.model, sourceSettings.request),
        getBatchVector: (batch, sourceSettings) => getMakerSuiteBatchVector(batch, sourceSettings.model, sourceSettings.request),
        getSettings: (request) => ({ model: String(request.body.model || 'text-embedding-005'), request }),
    },
    vertexai: {
        getVector: (text, sourceSettings) => getVertexVector(text, sourceSettings.model, sourceSettings.request),
        getBatchVector: (batch, sourceSettings) => getVertexBatchVector(batch, sourceSettings.model, sourceSettings.request),
        getSettings: (request) => ({ model: String(request.body.model || 'text-embedding-005'), request }),
    },
    cohere: {
        getVector: (text, sourceSettings, isQuery, directories) => getCohereVector(text, isQuery, directories, sourceSettings.model),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getCohereBatchVector(batch, isQuery, directories, sourceSettings.model),
        getSettings: (request) => ({ model: String(request.body.model) }),
    },
    llamacpp: {
        getVector: (text, sourceSettings, isQuery, directories) => getLlamaCppVector(text, sourceSettings.apiUrl, directories),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getLlamaCppBatchVector(batch, sourceSettings.apiUrl, directories),
        getSettings: (request) => ({ apiUrl: String(request.body.apiUrl) }),
    },
    vllm: {
        getVector: (text, sourceSettings, isQuery, directories) => getVllmVector(text, sourceSettings.apiUrl, sourceSettings.model, directories),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getVllmBatchVector(batch, sourceSettings.apiUrl, sourceSettings.model, directories),
        getSettings: (request) => ({ apiUrl: String(request.body.apiUrl), model: String(request.body.model) }),
    },
    ollama: {
        getVector: (text, sourceSettings, isQuery, directories) => getOllamaVector(text, sourceSettings.apiUrl, sourceSettings.model, sourceSettings.keep, directories),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getOllamaBatchVector(batch, sourceSettings.apiUrl, sourceSettings.model, sourceSettings.keep, directories),
        getSettings: (request) => ({ apiUrl: String(request.body.apiUrl), model: String(request.body.model), keep: Boolean(request.body.keep) }),
    },
    webllm: {
        getVector: (text, sourceSettings) => sourceSettings.embeddings[text],
        getBatchVector: (batch, sourceSettings) => batch.map(x => sourceSettings.embeddings[x]),
        getSettings: (request) => ({ model: String(request.body.model), embeddings: request.body.embeddings ?? {} }),
    },
    koboldcpp: {
        getVector: (text, sourceSettings) => sourceSettings.embeddings[text],
        getBatchVector: (batch, sourceSettings) => batch.map(x => sourceSettings.embeddings[x]),
        getSettings: (request) => ({ model: String(request.body.model), embeddings: request.body.embeddings ?? {} }),
    },
    chutes: {
        getVector: (text, sourceSettings, isQuery, directories) => getOpenAIVector(text, 'chutes', directories, sourceSettings.model),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getOpenAIBatchVector(batch, 'chutes', directories, sourceSettings.model),
        getSettings: (request) => ({ model: String(request.body.model || 'chutes-qwen-qwen3-embedding-8b') }),
    },
    nanogpt: {
        getVector: (text, sourceSettings, isQuery, directories) => getOpenAIVector(text, 'nanogpt', directories, sourceSettings.model),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getOpenAIBatchVector(batch, 'nanogpt', directories, sourceSettings.model),
        getSettings: (request) => ({ model: String(request.body.model || 'text-embedding-3-small') }),
    },
    siliconflow: {
        getVector: (text, sourceSettings, isQuery, directories) => getOpenAIVector(text, 'siliconflow', directories, sourceSettings.model, sourceSettings.urlOverride),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getOpenAIBatchVector(batch, 'siliconflow', directories, sourceSettings.model, sourceSettings.urlOverride),
        getSettings: (request) => ({
            model: String(request.body.model || 'Qwen/Qwen3-Embedding-0.6B'),
            urlOverride: request.body.siliconflow_endpoint === 'cn'
                ? 'https://api.siliconflow.cn/v1' : null,
        }),
    },
    workers_ai: {
        getVector: (text, sourceSettings, isQuery, directories) => getOpenAIVector(text, 'workers_ai', directories, sourceSettings.model, sourceSettings.urlOverride),
        getBatchVector: (batch, sourceSettings, isQuery, directories) => getOpenAIBatchVector(batch, 'workers_ai', directories, sourceSettings.model, sourceSettings.urlOverride),
        getSettings: (request) => {
            const accountId = String(request.body.workers_ai_account_id || '').trim();
            return {
                model: String(request.body.model || '@cf/baai/bge-m3'),
                urlOverride: accountId
                    ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`
                    : null,
            };
        },
    },
};

/**
 * Gets the vector for the given text from the given source.
 * @param {string} source - The source of the vector
 * @param {Object} sourceSettings - Settings for the source, if it needs any
 * @param {string} text - The text to get the vector for
 * @param {boolean} isQuery - If the text is a query for embedding search
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @returns {Promise<number[]>} - The vector for the text
 */
async function getVector(source, sourceSettings, text, isQuery, directories) {
    const entry = VECTOR_SOURCES[source];
    if (!entry) {
        throw new Error(`Unknown vector source ${source}`);
    }
    return entry.getVector(text, sourceSettings, isQuery, directories);
}

/**
 * Gets the vector for the given text batch from the given source.
 * @param {string} source - The source of the vector
 * @param {Object} sourceSettings - Settings for the source, if it needs any
 * @param {string[]} texts - The array of texts to get the vector for
 * @param {boolean} isQuery - If the text is a query for embedding search
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @returns {Promise<number[][]>} - The array of vectors for the texts
 */
async function getBatchVector(source, sourceSettings, texts, isQuery, directories) {
    const entry = VECTOR_SOURCES[source];
    if (!entry) {
        throw new Error(`Unknown vector source ${source}`);
    }

    const batchSize = 10;
    const batches = Array(Math.ceil(texts.length / batchSize)).fill(undefined).map((_, i) => texts.slice(i * batchSize, i * batchSize + batchSize));

    let results = [];
    for (let batch of batches) {
        results.push(...await entry.getBatchVector(batch, sourceSettings, isQuery, directories));
    }

    return results;
}

/**
 * Extracts settings for the vectorization sources from the HTTP request headers.
 * @param {string} source - Which source to extract settings for.
 * @param {object} request - The HTTP request object.
 * @returns {object} - An object that can be used as `sourceSettings` in functions that take that parameter.
 */
function getSourceSettings(source, request) {
    const entry = VECTOR_SOURCES[source];
    return entry ? entry.getSettings(request) : {};
}

/**
 * Gets the model scope for the source.
 * @param {object} sourceSettings - The settings for the source
 * @returns {string} The model scope for the source
 */
function getModelScope(sourceSettings) {
    return (sourceSettings?.model || '');
}

/**
 * Gets the index for the vector collection
 * @param {import('../users.js').UserDirectoryList} directories - User directories
 * @param {string} collectionId - The collection ID
 * @param {string} source - The source of the vector
 * @param {object} sourceSettings - The model for the source
 * @returns {Promise<vectra.LocalIndex>} - The index for the collection
 */
async function getIndex(directories, collectionId, source, sourceSettings) {
    const model = getModelScope(sourceSettings);
    const pathToFile = path.join(directories.vectors, sanitize(source), sanitize(collectionId), sanitize(model));
    const store = new vectra.LocalIndex(pathToFile);

    if (!await store.isIndexCreated()) {
        await store.createIndex();
    }

    return store;
}

/**
 * Inserts items into the vector collection
 * @param {import('../users.js').UserDirectoryList} directories - User directories
 * @param {string} collectionId - The collection ID
 * @param {string} source - The source of the vector
 * @param {Object} sourceSettings - Settings for the source, if it needs any
 * @param {{ hash: number; text: string; index: number; }[]} items - The items to insert
 */
async function insertVectorItems(directories, collectionId, source, sourceSettings, items) {
    const store = await getIndex(directories, collectionId, source, sourceSettings);

    await store.beginUpdate();

    const vectors = await getBatchVector(source, sourceSettings, items.map(x => x.text), false, directories);

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const vector = vectors[i];
        await store.upsertItem({ vector: vector, metadata: { hash: item.hash, text: item.text, index: item.index } });
    }

    await store.endUpdate();
}

/**
 * Gets the hashes of the items in the vector collection
 * @param {import('../users.js').UserDirectoryList} directories - User directories
 * @param {string} collectionId - The collection ID
 * @param {string} source - The source of the vector
 * @param {Object} sourceSettings - Settings for the source, if it needs any
 * @returns {Promise<number[]>} - The hashes of the items in the collection
 */
async function getSavedHashes(directories, collectionId, source, sourceSettings) {
    const store = await getIndex(directories, collectionId, source, sourceSettings);

    const items = await store.listItems();
    const hashes = items.map(x => Number(x.metadata.hash));

    return hashes;
}

/**
 * Deletes items from the vector collection by hash
 * @param {import('../users.js').UserDirectoryList} directories - User directories
 * @param {string} collectionId - The collection ID
 * @param {string} source - The source of the vector
 * @param {Object} sourceSettings - Settings for the source, if it needs any
 * @param {number[]} hashes - The hashes of the items to delete
 */
async function deleteVectorItems(directories, collectionId, source, sourceSettings, hashes) {
    const store = await getIndex(directories, collectionId, source, sourceSettings);
    const items = await store.listItemsByMetadata({ hash: { '$in': hashes } });

    await store.beginUpdate();

    for (const item of items) {
        await store.deleteItem(item.id);
    }

    await store.endUpdate();
}

/**
 * Gets the hashes of the items in the vector collection that match the search text
 * @param {import('../users.js').UserDirectoryList} directories - User directories
 * @param {string} collectionId - The collection ID
 * @param {string} source - The source of the vector
 * @param {Object} sourceSettings - Settings for the source, if it needs any
 * @param {string} searchText - The text to search for
 * @param {number} topK - The number of results to return
 * @param {number} threshold - The threshold for the search
 * @returns {Promise<{hashes: number[], metadata: object[]}>} - The metadata of the items that match the search text
 */
async function queryCollection(directories, collectionId, source, sourceSettings, searchText, topK, threshold) {
    const store = await getIndex(directories, collectionId, source, sourceSettings);
    const vector = await getVector(source, sourceSettings, searchText, true, directories);

    const result = await store.queryItems(vector, topK);
    const metadata = result.filter(x => x.score >= threshold).map(x => x.item.metadata);
    const hashes = result.map(x => Number(x.item.metadata.hash));
    return { metadata, hashes };
}

/**
 * Queries multiple collections for the given search queries. Returns the overall top K results.
 * @param {import('../users.js').UserDirectoryList} directories - User directories
 * @param {string[]} collectionIds - The collection IDs to query
 * @param {string} source - The source of the vector
 * @param {Object} sourceSettings - Settings for the source, if it needs any
 * @param {string} searchText - The text to search for
 * @param {number} topK - The number of results to return
 * @param {number} threshold - The threshold for the search
 *
 * @returns {Promise<Record<string, { hashes: number[], metadata: object[] }>>} - The top K results from each collection
 */
async function multiQueryCollection(directories, collectionIds, source, sourceSettings, searchText, topK, threshold) {
    const vector = await getVector(source, sourceSettings, searchText, true, directories);
    const results = [];

    for (const collectionId of collectionIds) {
        const store = await getIndex(directories, collectionId, source, sourceSettings);
        const result = await store.queryItems(vector, topK);
        results.push(...result.map(result => ({ collectionId, result })));
    }

    // Sort results by descending similarity, apply threshold, and take top K
    const sortedResults = results
        .sort((a, b) => b.result.score - a.result.score)
        .filter(x => x.result.score >= threshold)
        .slice(0, topK);

    /**
     * Group the results by collection ID
     * @type {Record<string, { hashes: number[], metadata: object[] }>}
     */
    const groupedResults = {};
    for (const result of sortedResults) {
        if (!groupedResults[result.collectionId]) {
            groupedResults[result.collectionId] = { hashes: [], metadata: [] };
        }

        groupedResults[result.collectionId].hashes.push(Number(result.result.item.metadata.hash));
        groupedResults[result.collectionId].metadata.push(result.result.item.metadata);
    }

    return groupedResults;
}

/**
 * Performs a request to regenerate the index if it is corrupted.
 * @param {import('express').Request} req Express request object
 * @param {import('express').Response} res Express response object
 * @param {Error} error Error object
 * @returns {Promise<any>} Promise
 */
async function regenerateCorruptedIndexErrorHandler(req, res, error) {
    if (error instanceof SyntaxError && !req.query.regenerated) {
        const collectionId = String(req.body.collectionId);
        const source = String(req.body.source) || 'transformers';
        const sourceSettings = getSourceSettings(source, req);

        if (collectionId && source) {
            const index = await getIndex(req.user.directories, collectionId, source, sourceSettings);
            const exists = await index.isIndexCreated();

            if (exists) {
                const path = index.folderPath;
                console.warn(`Corrupted index detected at ${path}, regenerating...`);
                await index.deleteIndex();
                return res.redirect(307, req.originalUrl + '?regenerated=true');
            }
        }
    }

    console.error(error);
    return res.sendStatus(500);
}

export const router = express.Router();

router.post('/query', async (req, res) => {
    try {
        if (!req.body.collectionId || !req.body.searchText) {
            return res.sendStatus(400);
        }

        const collectionId = String(req.body.collectionId);
        const searchText = String(req.body.searchText);
        const topK = Number(req.body.topK) || 10;
        const threshold = Number(req.body.threshold) || 0.0;
        const source = String(req.body.source) || 'transformers';
        const sourceSettings = getSourceSettings(source, req);

        const results = await queryCollection(req.user.directories, collectionId, source, sourceSettings, searchText, topK, threshold);
        return res.json(results);
    } catch (error) {
        return regenerateCorruptedIndexErrorHandler(req, res, error);
    }
});

router.post('/query-multi', async (req, res) => {
    try {
        if (!Array.isArray(req.body.collectionIds) || !req.body.searchText) {
            return res.sendStatus(400);
        }

        const collectionIds = req.body.collectionIds.map(x => String(x));
        const searchText = String(req.body.searchText);
        const topK = Number(req.body.topK) || 10;
        const threshold = Number(req.body.threshold) || 0.0;
        const source = String(req.body.source) || 'transformers';
        const sourceSettings = getSourceSettings(source, req);

        const results = await multiQueryCollection(req.user.directories, collectionIds, source, sourceSettings, searchText, topK, threshold);
        return res.json(results);
    } catch (error) {
        return regenerateCorruptedIndexErrorHandler(req, res, error);
    }
});

router.post('/insert', async (req, res) => {
    try {
        if (!Array.isArray(req.body.items) || !req.body.collectionId) {
            return res.sendStatus(400);
        }

        const collectionId = String(req.body.collectionId);
        const items = req.body.items.map(x => ({ hash: x.hash, text: x.text, index: x.index }));
        const source = String(req.body.source) || 'transformers';
        const sourceSettings = getSourceSettings(source, req);

        await insertVectorItems(req.user.directories, collectionId, source, sourceSettings, items);
        return res.sendStatus(200);
    } catch (error) {
        return regenerateCorruptedIndexErrorHandler(req, res, error);
    }
});

router.post('/list', async (req, res) => {
    try {
        if (!req.body.collectionId) {
            return res.sendStatus(400);
        }

        const collectionId = String(req.body.collectionId);
        const source = String(req.body.source) || 'transformers';
        const sourceSettings = getSourceSettings(source, req);

        const hashes = await getSavedHashes(req.user.directories, collectionId, source, sourceSettings);
        return res.json(hashes);
    } catch (error) {
        return regenerateCorruptedIndexErrorHandler(req, res, error);
    }
});

router.post('/delete', async (req, res) => {
    try {
        if (!Array.isArray(req.body.hashes) || !req.body.collectionId) {
            return res.sendStatus(400);
        }

        const collectionId = String(req.body.collectionId);
        const hashes = req.body.hashes.map(x => Number(x));
        const source = String(req.body.source) || 'transformers';
        const sourceSettings = getSourceSettings(source, req);

        await deleteVectorItems(req.user.directories, collectionId, source, sourceSettings, hashes);
        return res.sendStatus(200);
    } catch (error) {
        return regenerateCorruptedIndexErrorHandler(req, res, error);
    }
});

router.post('/purge-all', async (req, res) => {
    try {
        for (const source of SOURCES) {
            const sourcePath = path.join(req.user.directories.vectors, sanitize(source));
            if (!fs.existsSync(sourcePath)) {
                continue;
            }
            await fs.promises.rm(sourcePath, { recursive: true });
            console.info(`Deleted vector source store at ${sourcePath}`);
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

router.post('/purge', async (req, res) => {
    try {
        if (!req.body.collectionId) {
            return res.sendStatus(400);
        }

        const collectionId = String(req.body.collectionId);

        for (const source of SOURCES) {
            const sourcePath = path.join(req.user.directories.vectors, sanitize(source), sanitize(collectionId));
            if (!fs.existsSync(sourcePath)) {
                continue;
            }
            await fs.promises.rm(sourcePath, { recursive: true });
            console.info(`Deleted vector index at ${sourcePath}`);
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});
