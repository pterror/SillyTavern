/**
 * Server-side port of a slice of public/scripts/chat-completion-settings.js: the
 * `TokenHandler`/`Message`/`MessageCollection`/`ChatCompletion` class family ("Candidate 2" of the
 * thin-client-remediation decomposition of the Chat Completion (`main_api === 'openai'`)
 * prompt-assembly pipeline). Unlike the world-info/character-card-dependent pieces ported earlier
 * this session, this is a self-contained, purely stateful token-budget-tracking system: every
 * public method only ever touches `{role, content, identifier, name, tool_calls, signature,
 * reasoning}`-shaped inputs it is handed directly, with zero dependency on world-info, character
 * cards, or any other ambient prompt-assembly state.
 *
 * PORTED (public/scripts/chat-completion-settings.js ~lines 3403-4251):
 * - `TokenHandler` (~3403-3462): thin wrapper around an injected async tokenizer function that
 *   tracks running per-"type" token counts (`start_chat`/`prompt`/`bias`/`nudge`/`jailbreak`/
 *   `impersonate`/`examples`/`conversation`). Ported verbatim, including `log()` (kept as an
 *   optional `console.table` debug helper - harmless, matches the client 1:1).
 * - `IdentifierNotFoundError`/`TokenBudgetExceededError`/`InvalidCharacterNameError` (~3468-3489):
 *   trivial `Error` subclasses with custom `.name` and message text. Ported verbatim, including the
 *   client's own inconsistency that `TokenBudgetExceededError`'s `.name` is the string
 *   `'TokenBudgetExceeded'` (no "Error" suffix) and `InvalidCharacterNameError`'s `.name` is
 *   `'InvalidCharacterName'` - only the *class* names carry the "Error" suffix, not the `.name`
 *   string values baked into instances. This looks like a client-side inconsistency, not a typo
 *   introduced here; preserved exactly since other code may pattern-match on `.name`.
 * - `Message` (~3494-3784), EXCLUDING `addImage`/`addVideo`/`addAudio` (and their private helpers
 *   `compressImage`/`getImageTokenCost`). See "NOT PORTED" below.
 * - `MessageCollection` (~3791-3888): ported in full, verbatim - it is entirely pure/synchronous.
 * - `ChatCompletion` (~3900-4251): ported in full. `squashSystemMessages()` needed a judgment call
 *   for its `tokenHandler` dependency - see below.
 *
 * NOT PORTED (explicit, permanent gap, not a TODO): `Message.addImage`/`addVideo`/`addAudio` and
 * their helpers `compressImage`/`getImageTokenCost` are OUT OF SCOPE for this port. They perform
 * real network fetches (`fetch()` of image/video/audio URLs), browser-only media decoding (Canvas
 * 2D context for thumbnailing, `HTMLVideoElement`/`HTMLAudioElement` for duration probing via
 * `getVideoDurationFromDataURL`/`getAudioDurationFromDataURL`), and reference client-only globals
 * (`oai_settings.inline_image_quality`, `chat_completion_sources`). None of that exists server-side
 * yet. A real server-side port would need an image/video/audio processing pipeline (e.g. `sharp` for
 * thumbnailing/resizing, `ffprobe`/similar for media duration) plus a settings-injection story for
 * `inline_image_quality`/`chat_completion_source` - this is flagged here as a genuine follow-up, not
 * attempted. `Message.tokensPerImage` (the static fallback constant those methods use) is likewise
 * omitted since nothing here reads it. Multimodal (`content` as an array of `{type, ...}` parts) is
 * otherwise still representable through this module - `ensureContentIsArray()` is ported, and
 * `Message.content`/`MessageCollection`/`ChatCompletion` never assume `content` is a plain string -
 * only the three media-attaching methods themselves are absent.
 *
 * JUDGMENT CALL - `tokenHandler` injection (no ambient global): the client constructs one
 * module-level singleton, `const tokenHandler = new TokenHandler(countTokensOpenAIAsync);`, and every
 * method below closes over that singleton directly. Matching the "no ambient globals" convention used
 * throughout every other module ported this session (e.g. `countTokens` as an explicit parameter
 * everywhere in src/text-completion-prompt-orchestrator.js), this port instead threads a
 * caller-supplied `TokenHandler` instance through explicitly:
 *   - `Message.createAsync(role, content, identifier, tokenHandler)` - 4th param, was implicit.
 *   - `Message.prototype.setToolCalls(invocations, includeSignature, includeReasoning, tokenHandler)`
 *     - 4th param, was implicit (note `includeReasoning` keeps its own `= false` default from the
 *     client, so `tokenHandler` is always the 4th positional argument here, not inserted before it).
 *   - `Message.prototype.setName(name, tokenHandler)` - 2nd param, was implicit.
 *   - `ChatCompletion`'s constructor now takes `tokenHandler` as its sole parameter -
 *     `new ChatCompletion(tokenHandler)` - and stores it as `this.tokenHandler`, since
 *     `squashSystemMessages()` is a `ChatCompletion` INSTANCE method with no method-call-site
 *     equivalent to thread a param through the way `add`/`insert`/etc. take their arguments (it takes
 *     no arguments at all on the client and is called with none by callers). Storing it on the
 *     instance at construction time was chosen over adding a parameter to `squashSystemMessages()`
 *     itself because (a) it keeps the public call site `chatCompletion.squashSystemMessages()`
 *     unchanged from the client's, and (b) every other token-accounting operation on a
 *     `ChatCompletion` (`add`, `insert`, budget checks) already implicitly needs the *same*
 *     `tokenHandler` that produced the token counts on the `Message`/`MessageCollection` objects
 *     being added to it, so requiring it once at construction is more consistent than requiring
 *     it again on individual calls that already receive fully-token-counted `Message` objects.
 * `Message.fromPromptAsync(prompt)` (the other, unlisted-in-the-task static factory at client
 * ~3775) is also ported for completeness (it is a one-line wrapper the client uses elsewhere) and
 * likewise gained a `tokenHandler` parameter: `Message.fromPromptAsync(prompt, tokenHandler)`.
 *
 * JUDGMENT CALL / VERIFICATION - `tool_call` (singular) vs `tool_calls` (plural): the client
 * declares a field `tool_call = null;` at the top of `Message` (~line 3508) but grepping the whole
 * file for `\.tool_call\b` (word-boundary, singular) versus `\.tool_calls\b` (plural) shows the
 * singular field is NEVER read or written anywhere in the file after its declaration - it is dead
 * code. Every actual read/write site (`setToolCalls()`'s `this.tool_calls = ...`, `getChat()`'s
 * `message.tool_calls`/`item.tool_calls` checks and spread in both `MessageCollection.getChat()` and
 * `ChatCompletion.getChat()`, and `ChatCompletion.insert()`'s `message.content || message.tool_calls`
 * guard) uses the plural `tool_calls`. This port therefore does NOT declare a `tool_call` field at
 * all (it would be equally dead here) and only ever uses `tool_calls`, initialized implicitly
 * `undefined` until `setToolCalls()` is called, exactly matching the client's real runtime behavior
 * (the dead `tool_call = null` field never affects any observable behavior since nothing reads it).
 *
 * VERIFICATION - `validateMessageCollection`/`validateMessage`: both throw a plain `new Error(...)`
 * (client ~3155-3173 equivalent, actual lines ~4155-4173), NOT `IdentifierNotFoundError`,
 * `TokenBudgetExceededError`, or any other custom class. Confirmed by direct reading and ported
 * exactly - only `checkTokenBudget()` throws `TokenBudgetExceededError` and only
 * `findMessageIndex()`/`insert()` throw `IdentifierNotFoundError`.
 *
 * Everything else (field names, method bodies, control flow, the exact object-spread shapes built by
 * `getChat()` in both `MessageCollection` and `ChatCompletion` - deliberately NOT DRY'd into a shared
 * helper, matching the client's own near-duplicate-but-not-shared implementations) is a line-for-line
 * behavioral port.
 */

/**
 * @callback CountTokenAsyncFn
 * @param {object[]|object} messages Message(s) to count tokens for, in whatever shape the injected
 *  tokenizer expects (e.g. `{role, content}` or `{role, tool_calls}`).
 * @param {boolean} [full] Whether to count "full" tokens (passed through verbatim to the tokenizer).
 * @returns {Promise<number>}
 */

/**
 * Wraps an injected async tokenizer function and tracks running per-"type" token counts.
 */
export class TokenHandler {
    /**
     * @param {CountTokenAsyncFn} countTokenAsyncFn Function used to count tokens.
     */
    constructor(countTokenAsyncFn) {
        this.countTokenAsyncFn = countTokenAsyncFn;
        this.counts = {
            'start_chat': 0,
            'prompt': 0,
            'bias': 0,
            'nudge': 0,
            'jailbreak': 0,
            'impersonate': 0,
            'examples': 0,
            'conversation': 0,
        };
    }

    getCounts() {
        return this.counts;
    }

    resetCounts() {
        Object.keys(this.counts).forEach((key) => this.counts[key] = 0);
    }

    setCounts(counts) {
        this.counts = counts;
    }

    uncount(value, type) {
        this.counts[type] -= value;
    }

    /**
     * Count tokens for a message or messages, adding the result to the running count for `type`.
     * @param {object|any[]} messages Messages to count tokens for
     * @param {boolean} [full] Count full tokens
     * @param {string} [type] Identifier for the token count
     * @returns {Promise<number>} The token count
     */
    async countAsync(messages, full, type) {
        const token_count = await this.countTokenAsyncFn(messages, full);
        this.counts[type] += token_count;

        return token_count;
    }

    getTokensForIdentifier(identifier) {
        return this.counts[identifier] ?? 0;
    }

    getTotal() {
        return Object.values(this.counts).reduce((a, b) => a + (isNaN(b) ? 0 : b), 0);
    }

    /**
     * Optional debug helper - prints the per-type counts plus the total via console.table.
     * Harmless to call server-side; not invoked by anything in this module.
     */
    log() {
        console.table({ ...this.counts, 'total': this.getTotal() });
    }
}

/** Thrown by ChatCompletion when a requested prompt couldn't be found. */
export class IdentifierNotFoundError extends Error {
    constructor(identifier) {
        super(`Identifier ${identifier} not found.`);
        this.name = 'IdentifierNotFoundError';
    }
}

/** Thrown by ChatCompletion when the token budget is unexpectedly exceeded. */
export class TokenBudgetExceededError extends Error {
    constructor(identifier = '') {
        super(`Token budged exceeded. Message: ${identifier}`);
        this.name = 'TokenBudgetExceeded';
    }
}

/** Thrown when a character name is invalid. */
export class InvalidCharacterNameError extends Error {
    constructor(identifier = '') {
        super(`Invalid character name. Message: ${identifier}`);
        this.name = 'InvalidCharacterName';
    }
}

/**
 * Used for creating, managing, and interacting with a specific message object.
 *
 * Does NOT declare a `tool_call` (singular) field - see the module doc comment's
 * "tool_call vs tool_calls" verification note. `tool_calls` (plural) is `undefined` until
 * `setToolCalls()` is called, matching real client runtime behavior.
 */
export class Message {
    /** @type {number} */
    tokens;
    /** @type {string} */
    identifier;
    /** @type {string} */
    role;
    /** @type {string|any[]} */
    content;
    /** @type {string} */
    name;
    /** @type {object[]} */
    tool_calls;
    /** @type {string?} */
    signature = null;
    /** @type {string?} */
    reasoning = null;

    /**
     * @constructor
     * @param {string} role - The role of the entity creating the message.
     * @param {string} content - The actual content of the message.
     * @param {string} identifier - A unique identifier for the message.
     * @private Don't use this constructor directly. Use createAsync instead.
     */
    constructor(role, content, identifier) {
        this.identifier = identifier;
        this.role = role;
        this.content = content;

        if (!this.role) {
            console.log(`Message role not set, defaulting to 'system' for identifier '${this.identifier}'`);
            this.role = 'system';
        }

        this.tokens = 0;
    }

    /**
     * Create a new Message instance, counting its tokens via the given tokenHandler.
     * @param {string} role
     * @param {string} content
     * @param {string} identifier
     * @param {TokenHandler} tokenHandler Injected token handler (see module doc comment).
     * @returns {Promise<Message>} Message instance
     */
    static async createAsync(role, content, identifier, tokenHandler) {
        const message = new Message(role, content, identifier);

        if (typeof message.content === 'string' && message.content.length > 0) {
            message.tokens = await tokenHandler.countAsync({ role: message.role, content: message.content });
        }

        return message;
    }

    /**
     * Reconstruct the message from a tool invocation.
     * @param {{id: string, name: string, parameters: any, signature?: string, reasoning?: string}[]} invocations
     *  The tool invocations to reconstruct the message from (shape of `ToolInvocation`).
     * @param {boolean} includeSignature Whether to include the signature in the tool calls.
     * @param {boolean} [includeReasoning] Whether to include plaintext reasoning fallback.
     * @param {TokenHandler} tokenHandler Injected token handler (see module doc comment).
     * @returns {Promise<void>}
     */
    async setToolCalls(invocations, includeSignature, includeReasoning = false, tokenHandler) {
        this.tool_calls = invocations.map(i => ({
            id: i.id,
            type: 'function',
            function: {
                arguments: i.parameters,
                name: i.name,
            },
            ...(includeSignature && i.signature ? { signature: i.signature } : {}),
        }));
        const fallbackReasoning = invocations.find(i => typeof i.reasoning === 'string' && i.reasoning.length > 0)?.reasoning || null;
        this.reasoning = includeReasoning ? fallbackReasoning : null;
        this.tokens = await tokenHandler.countAsync({
            role: this.role,
            tool_calls: JSON.stringify(this.tool_calls),
            ...(this.reasoning ? { reasoning: this.reasoning } : {}),
        });
    }

    /**
     * Add a name to the message.
     * @param {string} name Name to set for the message.
     * @param {TokenHandler} tokenHandler Injected token handler (see module doc comment).
     * @returns {Promise<void>}
     */
    async setName(name, tokenHandler) {
        this.name = name;
        this.tokens = await tokenHandler.countAsync({ role: this.role, content: this.content, name: this.name });
    }

    /**
     * Ensures the content is an array. If it's a string, converts it to an array with a single text object.
     * @returns {any[]} Content as an array
     */
    ensureContentIsArray() {
        const textContent = this.content;
        if (!Array.isArray(this.content)) {
            this.content = [];
            if (typeof textContent === 'string') {
                this.content.push({ type: 'text', text: textContent });
            }
        }
        return this.content;
    }

    /**
     * Create a new Message instance from a prompt asynchronously.
     * @static
     * @param {{role: string, content: string, identifier: string}} prompt - The prompt object.
     * @param {TokenHandler} tokenHandler Injected token handler (see module doc comment).
     * @returns {Promise<Message>} A new instance of Message.
     */
    static fromPromptAsync(prompt, tokenHandler) {
        return Message.createAsync(prompt.role, prompt.content, prompt.identifier, tokenHandler);
    }

    /**
     * Returns the number of tokens in the message.
     * @returns {number} Number of tokens in the message.
     */
    getTokens() { return this.tokens; }
}

/**
 * Used for creating, managing, and interacting with a collection of Message instances.
 *
 * @class MessageCollection
 */
export class MessageCollection {
    collection = [];
    identifier;

    /**
     * @constructor
     * @param {string} identifier - A unique identifier for the MessageCollection.
     * @param {...(Message|MessageCollection)} items - Items to be added to the collection.
     */
    constructor(identifier, ...items) {
        for (let item of items) {
            if (!(item instanceof Message || item instanceof MessageCollection)) {
                throw new Error('Only Message and MessageCollection instances can be added to MessageCollection');
            }
        }

        this.collection.push(...items);
        this.identifier = identifier;
    }

    /**
     * Get chat in the format of {role, name, content, tool_calls}.
     * @returns {Array} Array of objects with role, name, and content properties.
     */
    getChat() {
        return this.collection.reduce((acc, message) => {
            if (message.content || message.tool_calls) {
                acc.push({
                    role: message.role,
                    content: message.content,
                    ...(message.name && { name: message.name }),
                    ...(message.tool_calls && { tool_calls: message.tool_calls }),
                    ...(message.role === 'tool' && { tool_call_id: message.identifier }),
                    ...(message.signature && { signature: message.signature }),
                    ...(message.reasoning && { reasoning: message.reasoning }),
                });
            }
            return acc;
        }, []);
    }

    /**
     * Method to get the collection of messages.
     * @returns {Array} The collection of Message instances.
     */
    getCollection() {
        return this.collection;
    }

    /**
     * Add a new item to the collection.
     * @param {Object} item - The Message or MessageCollection instance to be added.
     */
    add(item) {
        this.collection.push(item);
    }

    /**
     * Get an item from the collection by its identifier.
     * @param {string} identifier - The identifier of the item to be found.
     * @returns {Object} The found item, or undefined if no item was found.
     */
    getItemByIdentifier(identifier) {
        return this.collection.find(item => item?.identifier === identifier);
    }

    /**
     * Check if an item with the given identifier exists in the collection.
     * @param {string} identifier - The identifier to check.
     * @returns {boolean} True if an item with the given identifier exists, false otherwise.
     */
    hasItemWithIdentifier(identifier) {
        return this.collection.some(message => message.identifier === identifier);
    }

    /**
     * Get the total number of tokens in the collection.
     * @returns {number} The total number of tokens.
     */
    getTokens() {
        return this.collection.reduce((tokens, message) => tokens + message.getTokens(), 0);
    }

    /**
     * Combines message collections into a single collection.
     * @returns {Message[]} The collection of messages flattened into a single array.
     */
    flatten() {
        return this.collection.reduce((acc, message) => {
            if (message instanceof MessageCollection) {
                acc.push(...message.flatten());
            } else {
                acc.push(message);
            }
            return acc;
        }, []);
    }
}

/**
 * OpenAI API chat completion representation
 * const map = [{identifier: 'example', message: {role: 'system', content: 'exampleContent'}}, ...];
 *
 * This class creates a chat context that can be sent to Open AI's api
 * Includes message management and token budgeting.
 *
 * @see https://platform.openai.com/docs/guides/gpt/chat-completions-api
 */
export class ChatCompletion {
    /**
     * Initializes a new instance of ChatCompletion.
     * Sets up the initial token budget and a new message collection.
     * @param {TokenHandler} tokenHandler Injected token handler, stored on the instance so
     *  `squashSystemMessages()` (which the client calls with zero arguments) has access to it - see
     *  the module doc comment's "tokenHandler injection" judgment call.
     */
    constructor(tokenHandler) {
        this.tokenHandler = tokenHandler;
        this.tokenBudget = 0;
        this.messages = new MessageCollection('root');
        this.loggingEnabled = false;
        this.overriddenPrompts = [];
    }

    /**
     * Combines consecutive system messages into one if they have no name attached.
     * @returns {Promise<void>}
     */
    async squashSystemMessages() {
        const excludeList = ['newMainChat', 'newChat', 'groupNudge'];
        this.messages.collection = this.messages.flatten();

        let lastMessage = null;
        let squashedMessages = [];

        for (let message of this.messages.collection) {
            // Force exclude empty messages
            if (message.role === 'system' && !message.content) {
                continue;
            }

            const shouldSquash = (message) => {
                return !excludeList.includes(message.identifier) && message.role === 'system' && !message.name;
            };

            if (shouldSquash(message)) {
                if (lastMessage && shouldSquash(lastMessage)) {
                    lastMessage.content += '\n' + message.content;
                    lastMessage.tokens = await this.tokenHandler.countAsync({ role: lastMessage.role, content: lastMessage.content });
                } else {
                    squashedMessages.push(message);
                    lastMessage = message;
                }
            } else {
                squashedMessages.push(message);
                lastMessage = message;
            }
        }

        this.messages.collection = squashedMessages;
    }

    /**
     * Retrieves all messages.
     * @returns {MessageCollection} The MessageCollection instance holding all messages.
     */
    getMessages() {
        return this.messages;
    }

    /**
     * Calculates and sets the token budget based on context and response.
     * @param {number} context - Number of tokens in the context.
     * @param {number} response - Number of tokens in the response.
     */
    setTokenBudget(context, response) {
        this.log(`Prompt tokens: ${context}`);
        this.log(`Completion tokens: ${response}`);

        this.tokenBudget = context - response;

        this.log(`Token budget: ${this.tokenBudget}`);
    }

    /**
     * Adds a message or message collection to the collection.
     * @param {Message|MessageCollection} collection - The message or message collection to add.
     * @param {number|null} [position] - The position at which to add the collection.
     * @returns {ChatCompletion} The current instance for chaining.
     */
    add(collection, position = null) {
        this.validateMessageCollection(collection);
        this.checkTokenBudget(collection, collection.identifier);

        if (null !== position && -1 !== position) {
            this.messages.collection[position] = collection;
        } else {
            this.messages.collection.push(collection);
        }

        this.decreaseTokenBudgetBy(collection.getTokens());

        this.log(`Added ${collection.identifier}. Remaining tokens: ${this.tokenBudget}`);

        return this;
    }

    /**
     * Inserts a message at the start of the specified collection.
     * @param {Message} message - The message to insert.
     * @param {string} identifier - The identifier of the collection where to insert the message.
     */
    insertAtStart(message, identifier) {
        this.insert(message, identifier, 'start');
    }

    /**
     * Inserts a message at the end of the specified collection.
     * @param {Message} message - The message to insert.
     * @param {string} identifier - The identifier of the collection where to insert the message.
     */
    insertAtEnd(message, identifier) {
        this.insert(message, identifier, 'end');
    }

    /**
     * Inserts a message at the specified position in the specified collection.
     * @param {Message} message - The message to insert.
     * @param {string} identifier - The identifier of the collection where to insert the message.
     * @param {string|number} [position] - The position at which to insert the message ('start' or 'end').
     */
    insert(message, identifier, position = 'end') {
        this.validateMessage(message);
        this.checkTokenBudget(message, message.identifier);

        const index = this.findMessageIndex(identifier);
        if (message.content || message.tool_calls) {
            if ('start' === position) this.messages.collection[index].collection.unshift(message);
            else if ('end' === position) this.messages.collection[index].collection.push(message);
            else if (typeof position === 'number') this.messages.collection[index].collection.splice(position, 0, message);

            this.decreaseTokenBudgetBy(message.getTokens());

            this.log(`Inserted ${message.identifier} into ${identifier}. Remaining tokens: ${this.tokenBudget}`);
        }
    }

    /**
     * Remove the last item of the collection
     * @param identifier
     */
    removeLastFrom(identifier) {
        const index = this.findMessageIndex(identifier);
        const message = this.messages.collection[index].collection.pop();

        if (!message) {
            this.log(`No message to remove from ${identifier}`);
            return;
        }

        this.increaseTokenBudgetBy(message.getTokens());

        this.log(`Removed ${message.identifier} from ${identifier}. Remaining tokens: ${this.tokenBudget}`);
    }

    /**
     * Checks if the token budget can afford the tokens of the specified message.
     * @param {Message|MessageCollection} message - The message to check for affordability.
     * @returns {boolean} True if the budget can afford the message, false otherwise.
     */
    canAfford(message) {
        return 0 <= this.tokenBudget - message.getTokens();
    }

    /**
     * Checks if the token budget can afford the tokens of all the specified messages.
     * @param {Message[]} messages - The messages to check for affordability.
     * @returns {boolean} True if the budget can afford all the messages, false otherwise.
     */
    canAffordAll(messages) {
        return 0 <= this.tokenBudget - messages.reduce((total, message) => total + message.getTokens(), 0);
    }

    /**
     * Checks if a message with the specified identifier exists in the collection.
     * @param {string} identifier - The identifier to check for existence.
     * @returns {boolean} True if a message with the specified identifier exists, false otherwise.
     */
    has(identifier) {
        return this.messages.hasItemWithIdentifier(identifier);
    }

    /**
     * Retrieves the total number of tokens in the collection.
     * @returns {number} The total number of tokens.
     */
    getTotalTokenCount() {
        return this.messages.getTokens();
    }

    /**
     * Retrieves the chat as a flattened array of messages.
     * @returns {Array} The chat messages.
     */
    getChat() {
        const chat = [];
        for (let item of this.messages.collection) {
            if (item instanceof MessageCollection) {
                chat.push(...item.getChat());
            } else if (item instanceof Message && (item.content || item.tool_calls)) {
                const message = {
                    role: item.role,
                    content: item.content,
                    ...(item.name ? { name: item.name } : {}),
                    ...(item.tool_calls ? { tool_calls: item.tool_calls } : {}),
                    ...(item.role === 'tool' ? { tool_call_id: item.identifier } : {}),
                    ...(item.signature ? { signature: item.signature } : {}),
                    ...(item.reasoning ? { reasoning: item.reasoning } : {}),
                };
                chat.push(message);
            } else {
                this.log(`Skipping invalid or empty message in collection: ${JSON.stringify(item)}`);
            }
        }
        return chat;
    }

    /**
     * Logs an output message to the console if logging is enabled.
     * @param {string} output - The output message to log.
     */
    log(output) {
        if (this.loggingEnabled) console.log('[ChatCompletion] ' + output);
    }

    /**
     * Enables logging of output messages to the console.
     */
    enableLogging() {
        this.loggingEnabled = true;
    }

    /**
     * Disables logging of output messages to the console.
     */
    disableLogging() {
        this.loggingEnabled = false;
    }

    /**
     * Validates if the given argument is an instance of MessageCollection.
     * Throws a plain Error if the validation fails (NOT a custom error class - verified against
     * the client source; see module doc comment).
     * @param {MessageCollection|Message} collection - The collection to validate.
     */
    validateMessageCollection(collection) {
        if (!(collection instanceof MessageCollection)) {
            console.log(collection);
            throw new Error('Argument must be an instance of MessageCollection');
        }
    }

    /**
     * Validates if the given argument is an instance of Message.
     * Throws a plain Error if the validation fails (NOT a custom error class - see above).
     * @param {Message} message - The message to validate.
     */
    validateMessage(message) {
        if (!(message instanceof Message)) {
            console.log(message);
            throw new Error('Argument must be an instance of Message');
        }
    }

    /**
     * Checks if the token budget can afford the tokens of the given message.
     * Throws a TokenBudgetExceededError if the budget can't afford the message.
     * @param {Message|MessageCollection} message - The message to check.
     * @param {string} identifier - The identifier of the message.
     */
    checkTokenBudget(message, identifier) {
        if (!this.canAfford(message)) {
            throw new TokenBudgetExceededError(identifier);
        }
    }

    /**
     * Reserves the tokens required by the given message from the token budget.
     * @param {Message|MessageCollection|number} message - The message whose tokens to reserve, or a
     *  raw token count.
     */
    reserveBudget(message) {
        const tokens = typeof message === 'number' ? message : message.getTokens();
        this.decreaseTokenBudgetBy(tokens);
    }

    /**
     * Frees up the tokens used by the given message from the token budget.
     * @param {Message|MessageCollection} message - The message whose tokens to free.
     */
    freeBudget(message) { this.increaseTokenBudgetBy(message.getTokens()); }

    /**
     * Increases the token budget by the given number of tokens.
     * This function should be used sparingly, per design the completion should be able to work with its initial budget.
     * @param {number} tokens - The number of tokens to increase the budget by.
     */
    increaseTokenBudgetBy(tokens) {
        this.tokenBudget += tokens;
    }

    /**
     * Decreases the token budget by the given number of tokens.
     * This function should be used sparingly, per design the completion should be able to work with its initial budget.
     * @param {number} tokens - The number of tokens to decrease the budget by.
     */
    decreaseTokenBudgetBy(tokens) {
        this.tokenBudget -= tokens;
    }

    /**
     * Finds the index of a message in the collection by its identifier.
     * Throws an IdentifierNotFoundError if a message with the given identifier is not found.
     * @param {string} identifier - The identifier of the message to find.
     * @returns {number} The index of the message in the collection.
     */
    findMessageIndex(identifier) {
        const index = this.messages.collection.findIndex(item => item?.identifier === identifier);
        if (index < 0) {
            throw new IdentifierNotFoundError(identifier);
        }
        return index;
    }

    /**
     * Sets the list of overridden prompts.
     * @param {string[]} list A list of prompts that were overridden.
     */
    setOverriddenPrompts(list) {
        this.overriddenPrompts = list;
    }

    getOverriddenPrompts() {
        return this.overriddenPrompts ?? [];
    }
}
