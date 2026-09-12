export class WebLlmVectorProvider {
    /** @type {object?} WebLLM engine */
    #engine = null;

    constructor() {
        this.#engine = null;
    }

    #checkWebLlm() {
        if (!Object.hasOwn(SillyTavern, 'llm')) {
            throw new Error('WebLLM is not available', { cause: 'webllm-not-available' });
        }

        if (typeof SillyTavern.llm.generateEmbedding !== 'function') {
            throw new Error('WebLLM is not updated', { cause: 'webllm-not-updated' });
        }
    }

    #initEngine(modelId) {
        this.#checkWebLlm();
        if (!this.#engine) {
            this.#engine = SillyTavern.llm.getEngine();
        }

        return this.#engine.loadModel(modelId);
    }

    getModels() {
        this.#checkWebLlm();
        return SillyTavern.llm.getEmbeddingModels();
    }

    async embedTexts(texts, modelId) {
        await this.#initEngine(modelId);
        return this.#engine.generateEmbedding(texts);
    }

    async loadModel(modelId) {
        await this.#initEngine(modelId);
    }
}
