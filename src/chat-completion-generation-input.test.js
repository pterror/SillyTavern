import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { write as writeCard } from './character-card-parser.js';
import './fetch-patch.js';
import { Jimp, JimpMime } from './jimp.js';
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

const { resolveChatCompletionGenerationInput } = await import('./chat-completion-generation-input.js');
const { importWorldInfoFromRaw } = await import('./endpoints/worldinfo.js');
const { writeAllSettings } = await import('./settings-store.js');
const { buildChatCompletionPrompt } = await import('./prompt/chat-prompt.js');
const { world_info_position } = await import('./world-info/result-bucketing.js');
const { extension_prompt_types, extension_prompt_roles } = await import('./prompt/injections.js');
const { encodeTextByLocalTokenizerType, getTiktokenTokenizer } = await import('./endpoints/tokenizers.js');
const { rememberOpenRouterModels } = await import('./openrouter-models.js');
rememberOpenRouterModels([]);
const { createLlamaCppPropsCheck } = await import('./llamacpp-props.js');
const { writeBack } = await import('./token-count-store.js');

const { convertedUser, writeLibraryCard, saveBranch, loadBranch, chatContextOf } = await import('../tests/converted-user.fixture.js');

const user = await convertedUser('st-chat-completion-generation-input-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;
const { newSessionKey } = await import('./chat-engine.js');

/**
 * @param {{ avatar?: string, group?: string }} owner
 * @param {string} [name]
 */
async function ctxOf(owner, name) {
    const session = name === undefined ? newSessionKey() : (await loadBranch(user.store, owner, name)).branch.session;
    return chatContextOf(user.store, owner, session);
}

async function writeLorebook(name, entries) {
    const entriesObj = {};
    for (const entry of entries) {
        entriesObj[String(entry.uid)] = entry;
    }
    await importWorldInfoFromRaw(directories, name, JSON.stringify({ entries: entriesObj }));
}

const baseImage = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'ai4.png'));

async function writeCharacter(avatar, overrides = {}) {
    const name = overrides.name ?? avatar.replace(/\.png$/, '');
    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name,
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        avatar,
        data: {
            name,
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            system_prompt: '',
            post_history_instructions: '',
            character_version: '',
            creator_notes: '',
            alternate_greetings: [],
            extensions: {},
        },
        ...overrides,
    };
    const cardJson = JSON.stringify(card);
    const buffer = writeCard(baseImage, cardJson);
    await writeLibraryCard(user, avatar, cardJson, buffer);
    return avatar;
}

function buildSettingsFixture() {
    return {
        username: 'Tester',
        user_avatar: 'Tester.png',
        main_api: 'koboldhorde',
        power_user: {
            persona_data: {
                'Tester.png': { description: 'A curious {{user}}.', position: 1 },
            },
            console_log_prompts: false,
            pin_examples: false,
            prefer_character_prompt: true,
            prefer_character_jailbreak: false,
        },
        world_info_settings: {
            world_info: {
                globalSelect: ['TestLore'],
                charLore: [],
            },
            world_info_character_strategy: 1,
            world_info_depth: 10,
        },
        oai_settings: {
            chat_completion_source: 'openai',
            openai_model: 'gpt-4o',
            openai_max_context: 8192,
            openai_max_tokens: 512,
            squash_system_messages: true,
            wi_format: '{0}',
            new_chat_prompt: '[Start a new Chat]',
            new_group_chat_prompt: '[Start a new group chat. Group members: {{group}}]',
            new_example_chat_prompt: '[Example Chat]',
            send_if_empty: '',
            continue_nudge_prompt: '[Continue your last message.]',
            impersonation_prompt: '[Write the next reply as {{user}}.]',
            assistant_prefill: '',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'You are {{char}}.', system_prompt: true },
                { identifier: 'worldInfoBefore', name: 'World Info (before)', role: 'system', content: '', system_prompt: true },
                { identifier: 'charDescription', name: 'Char Description', role: 'system', content: '', system_prompt: true },
                { identifier: 'charPersonality', name: 'Char Personality', role: 'system', content: '', system_prompt: true },
                { identifier: 'scenario', name: 'Scenario', role: 'system', content: '', system_prompt: true },
                { identifier: 'worldInfoAfter', name: 'World Info (after)', role: 'system', content: '', system_prompt: true },
                { identifier: 'dialogueExamples', name: 'Chat Examples', role: 'system', content: '', system_prompt: true },
                { identifier: 'chatHistory', name: 'Chat History', role: 'system', content: '', system_prompt: true },
                { identifier: 'jailbreak', name: 'Post-History Instructions', role: 'system', content: '', system_prompt: true },
            ],
            prompt_order: [
                {
                    character_id: 100000,
                    order: [
                        { identifier: 'main', enabled: true },
                        { identifier: 'worldInfoBefore', enabled: true },
                        { identifier: 'charDescription', enabled: true },
                        { identifier: 'charPersonality', enabled: true },
                        { identifier: 'scenario', enabled: true },
                        { identifier: 'worldInfoAfter', enabled: true },
                        { identifier: 'dialogueExamples', enabled: true },
                        { identifier: 'chatHistory', enabled: true },
                        { identifier: 'jailbreak', enabled: true },
                    ],
                },
            ],
        },
    };
}

async function gemmaModelCountsWithGemma() {
    const settings = buildSettingsFixture();
    settings.oai_settings.chat_completion_source = 'openrouter';
    settings.oai_settings.openrouter_model = 'google/gemma-2-9b-it';
    writeAllSettings(directories, settings);
    const avatar = await writeCharacter('Gem.png', { name: 'Gem', data: { name: 'Gem', first_mes: 'Hi.' } });
    await saveBranch(user.store, { avatar: avatar }, 'gem-chat', [
        { chat_metadata: {} },
        { name: 'Gem', is_user: false, mes: 'Hi.', send_date: 1, extra: {} },
    ]);

    const input = await resolveChatCompletionGenerationInput(directories, { avatar, chatContext: await ctxOf({ avatar }, 'gem-chat'), branchName: 'gem-chat' });

    const message = { role: 'user', content: 'Antidisestablishmentarianism, naïveté and 東京 split differently.' };
    const gemmaCount = (await encodeTextByLocalTokenizerType('gemma', `${message.role}\n\n${message.content}`)).length;
    const gpt35 = getTiktokenTokenizer('gpt-3.5-turbo');
    const gpt35Count = 3 + gpt35.encode(message.role).length + gpt35.encode(message.content).length + 3;
    assert.notEqual(gemmaCount, gpt35Count, 'the fixture tells the two tokenizers apart');

    assert.equal(await input.tokenHandler.countTokenAsyncFn([message]), gemmaCount, 'counted with gemma');
}

async function startStubLlamaCpp() {
    const tokenizeBodies = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (req.method === 'GET' && req.url.split('?')[0] === '/props') {
                return res.end(JSON.stringify({ default_generation_settings: { n_ctx: 4096 }, total_slots: 1, build_info: 'b1-abc', model_path: '/models/stub.gguf' }));
            }
            if (req.url === '/tokenize') {
                const parsed = JSON.parse(body);
                tokenizeBodies.push(parsed);
                return res.end(JSON.stringify({ tokens: Array.from(Buffer.from(String(parsed.content))).map(byte => 1000 + byte) }));
            }
            res.writeHead(404);
            res.end();
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, tokenizeBodies, url: `http://127.0.0.1:${server.address().port}` };
}

async function storedCountsSkipTextOnlyMessages() {
    const stub = await startStubLlamaCpp();
    try {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'custom';
        settings.oai_settings.custom_url = stub.url;
        settings.oai_settings.custom_model = 'stub-model';
        settings.world_info_settings.world_info.globalSelect = [];
        writeAllSettings(directories, settings);
        const avatar = await writeCharacter('Stow.png', { name: 'Stow', data: { name: 'Stow', first_mes: 'Hi.' } });
        await saveBranch(user.store, { avatar: avatar }, 'stow-chat', [
            { chat_metadata: {} },
            { name: 'Stow', is_user: false, mes: 'Hello there.', send_date: 1, extra: {} },
            { name: 'Tester', is_user: true, mes: 'What time is it?', send_date: 2, extra: {} },
            {
                name: 'Stow', is_user: false, mes: 'Checking the clock.', send_date: 3,
                extra: { tool_invocations: [{ id: 'call_1', name: 'get_time', parameters: '{}', result: 'Noon.' }] },
            },
            { name: 'Stow', is_user: false, mes: 'It is noon.', send_date: 4, extra: {} },
        ]);

        const generate = async () => {
            stub.tokenizeBodies.length = 0;
            const input = await resolveChatCompletionGenerationInput(directories, {
                avatar, chatContext: await ctxOf({ avatar }, 'stow-chat'), branchName: 'stow-chat', type: 'normal',
                llamaCppProps: createLlamaCppPropsCheck({ reuse: false }),
            });
            const prepared = await buildChatCompletionPrompt({ ...input, canUseToolsOverride: true });
            return { input, prepared, bodies: stub.tokenizeBodies.map(body => String(body.content)) };
        };
        const isToolCallCount = (content) => content.startsWith('assistant\n\n[{"id":"call_1"');
        const toolResultCount = 'tool\n\nNoon.';
        const isFreshCount = (content) => isToolCallCount(content) || content === toolResultCount;

        const first = await generate();
        assert.ok(first.bodies.some(isToolCallCount), 'the first resolution counted the tool-call message with /tokenize');
        assert.ok(first.bodies.includes(toolResultCount), 'and the tool result');
        assert.ok(first.bodies.some(content => !isFreshCount(content)), 'and text-only messages with /tokenize');
        assert.ok(first.input.tokenCountRows.counts.length > 0, 'the first resolution has rows to write back');
        await writeBack(directories, first.input.tokenCountRows);

        const second = await generate();
        assert.deepEqual(second.bodies.filter(content => !isFreshCount(content)), [], 'no /tokenize for a text-only message counted in the first');
        assert.deepEqual(second.bodies.filter(isToolCallCount), first.bodies.filter(isToolCallCount), 'the tool-call message is counted both times');
        assert.deepEqual(second.bodies.filter(content => content === toolResultCount), first.bodies.filter(content => content === toolResultCount), 'the tool result is counted both times');
        assert.deepEqual(second.prepared.chat, first.prepared.chat, 'the same messages');
        assert.deepEqual((await second.prepared.itemize()).parts, (await first.prepared.itemize()).parts, 'the same counts');
    } finally {
        stub.server.close();
    }
}

async function run() {
    await gemmaModelCountsWithGemma();
    await storedCountsSkipTextOnlyMessages();
    writeAllSettings(directories, buildSettingsFixture());
    const WI_DEPTH_TEST_DEPTH = 3;
    const WI_DEPTH_TEST_ROLE = extension_prompt_roles.SYSTEM;
    const WI_DEPTH_TEST_CONTENT = 'A secret passed down at this exact depth.';
    await writeLorebook('TestLore', [
        { uid: 'wi1', key: ['traveler'], keysecondary: [], comment: '', content: 'The ancient tower looms over the village.', constant: false, selective: false, order: 10, position: 0, disable: false },
        {
            uid: 'wi2', key: ['nice to meet'], keysecondary: [], comment: '', content: WI_DEPTH_TEST_CONTENT,
            constant: false, selective: false, order: 5, disable: false,
            position: world_info_position.atDepth, depth: WI_DEPTH_TEST_DEPTH, role: WI_DEPTH_TEST_ROLE,
        },
    ]);
    const avatar = await writeCharacter('Rex.png', {
        name: 'Rex',
        description: 'Rex is a {{char}}.',
        data: { name: 'Rex', description: 'Rex is a {{char}}.', first_mes: 'Hi, I am Rex.' },
    });

    const ownerId = avatar;
    const branchName = 'main-chat';
    await saveBranch(user.store, { avatar: ownerId }, branchName, [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        { name: 'Tester', is_user: true, mes: 'Hi Rex, nice to meet you.', send_date: 2, extra: {} },
        { name: 'Rex', is_user: false, mes: 'Likewise!', send_date: 3, extra: {} },
    ]);

    const input = await resolveChatCompletionGenerationInput(directories, {
        avatar, chatContext: await ctxOf({ avatar }, branchName), branchName,
        type: 'normal',
    });

    assert.equal(input.name2, 'Rex', 'name2 resolves from the real character card, not guessed');
    assert.equal(input.mainApi, 'openai', 'mainApi is hardcoded for this chat-completion-only resolver');
    assert.equal(input.model, 'gpt-4o', 'model resolves via the real getChatCompletionModel() port, keyed on oai_settings.chat_completion_source');
    assert.equal(input.maxContext, 8192, 'maxContext resolves from oai_settings.openai_max_context');
    assert.equal(input.maxTokens, 512, 'maxTokens resolves from oai_settings.openai_max_tokens');
    assert.equal(input.squashSystemMessages, true);
    assert.equal(input.personaDescription, 'A curious {{user}}.', 'personaDescription resolves from power_user.persona_data[user_avatar].description');
    assert.equal(input.personaDescriptionPosition, 1);
    assert.equal(input.wiFormat, '{0}');
    const savedIds = buildSettingsFixture().oai_settings.prompts.map(p => p.identifier);
    assert.deepEqual(input.prompts.map(p => p.identifier).slice(0, savedIds.length), savedIds, 'prompts are the saved ones first');
    assert.ok(input.prompts.some(p => p.identifier === 'personaDescription'), 'and every default prompt they lack, as the prompt manager adds it');
    assert.equal(input.characterId, 100001, 'characterId defaults to the chat completion prompt manager\'s global order id');
    assert.ok(input.promptOrder.some(list => list.character_id === 100001 && list.order.some(entry => entry.identifier === 'personaDescription')), 'with the default order under it when none is saved there');

    assert.equal(input.charDescription, 'Rex is a Rex.', 'charDescription resolves via the real getCharacterCardFields(), including macro substitution');
    assert.equal(input.systemPromptOverride, '', 'systemPromptOverride resolves from fields.system (empty card system_prompt here, but the real preferCharacterPrompt-gated path)');

    assert.equal(input.worldInfoCandidates.length, 2, 'worldInfoCandidates is auto-resolved for real from the on-disk lorebook named in settings.world_info_settings.world_info.globalSelect (wi1 + the new @Depth wi2)');
    assert.equal(input.worldInfoCandidates[0].content, 'The ancient tower looms over the village.');

    const { lib } = await (await import('./user-stores.js')).userStore(directories);
    const refOf = async (uid) => {
        const found = await lib.books.entryOf('TestLore', uid);
        assert.equal(typeof found, 'object');
        return { book: String(/** @type {any} */ (found).book), entry: String(/** @type {any} */ (found).id) };
    };
    const storedMessages = (await loadBranch(user.store, { avatar }, branchName)).messages;
    const storedNodes = storedMessages.map(m => m.node_id);
    const { getStringHash } = await import('../public/scripts/hash-utils.js');
    assert.ok(input.activations, 'the generation keeps a record of what came up');
    assert.deepEqual(input.activations.cut, []);
    const recorded = Object.fromEntries(input.activations.entries.map(e => [JSON.stringify(e.ref), e]));
    const tower = recorded[JSON.stringify(await refOf('wi1'))];
    assert.equal(tower.why, 'key');
    assert.deepEqual(tower.keys, [{ key: 'traveler', in: [{ node: storedNodes.at(-3), spans: [[13, 21]], of: getStringHash(storedMessages.at(-3).mes) }] }], 'the matched name, in the stored message it was found in, at its place in that message\'s text, with the text those offsets are into');
    const secret = recorded[JSON.stringify(await refOf('wi2'))];
    assert.deepEqual(secret.keys, [{ key: 'nice to meet', in: [{ node: storedNodes.at(-2), spans: [[8, 20]], of: getStringHash(storedMessages.at(-2).mes) }] }]);
    assert.deepEqual([secret.position, secret.depth, secret.role], [world_info_position.atDepth, WI_DEPTH_TEST_DEPTH, WI_DEPTH_TEST_ROLE]);

    assert.equal(input.worldInfoAfter, '', 'the test entry is position:before, so worldInfoAfter stays empty');
    assert.ok(
        input.worldInfoBefore.includes('The ancient tower looms over the village.'),
        'worldInfoBefore contains the real entry content, genuinely activated via keyword scan against the real chat history',
    );

    const wiDepthKey = `customDepthWI_${WI_DEPTH_TEST_DEPTH}_${WI_DEPTH_TEST_ROLE}`;
    const wiDepthEntry = input.entries.find(entry => entry.key === wiDepthKey);
    assert.ok(wiDepthEntry, `the entries hold the @Depth lore at the expected ${wiDepthKey} key`);
    assert.deepEqual(wiDepthEntry.children.map(child => child.text), [WI_DEPTH_TEST_CONTENT], 'it holds the real, genuinely-activated @Depth entry content');
    assert.equal(wiDepthEntry.position, extension_prompt_types.IN_CHAT);
    assert.equal(wiDepthEntry.depth, WI_DEPTH_TEST_DEPTH);
    assert.equal(wiDepthEntry.role, WI_DEPTH_TEST_ROLE);
    assert.ok(!input.worldInfoBefore.includes(WI_DEPTH_TEST_CONTENT), 'the @Depth entry content is NOT duplicated into worldInfoBefore');
    assert.ok(!input.worldInfoAfter.includes(WI_DEPTH_TEST_CONTENT), 'the @Depth entry content is NOT duplicated into worldInfoAfter');

    const overriddenWI = await resolveChatCompletionGenerationInput(directories, {
        avatar, chatContext: await ctxOf({ avatar }, branchName), branchName, worldInfoCandidates: [],
    });
    assert.deepEqual(overriddenWI.worldInfoCandidates, [], 'an explicit worldInfoCandidates override bypasses auto-resolution');

    assert.equal(input.messages.length, 3, 'messages resolves from the stored chat, converted to chat-completion shape');
    assert.equal(input.messages[0].content, 'Likewise!', 'messages[0] is the NEWEST turn - buildChatCompletionMessages() output is newest-first');
    assert.equal(input.messages[0].role, 'assistant');
    assert.equal(input.messages[1].role, 'user');
    assert.equal(input.messages[1].content, 'Hi Rex, nice to meet you.');
    assert.equal(input.messages[2].content, 'Hello there, traveler.', 'messages[2] is the OLDEST turn');
    assert.ok(!('is_user' in input.messages[0]), 'messages are NOT left in the tree-DB native {is_user, mes} shape');

    const withUserMessage = await resolveChatCompletionGenerationInput(directories, {
        avatar, chatContext: await ctxOf({ avatar }, branchName), branchName,
        userMessageText: 'What happens next, Rex?',
    });
    assert.equal(withUserMessage.messages.length, 4, 'userMessageText appends one new message onto the real loaded history');
    const appended = withUserMessage.messages[0];
    assert.equal(appended.role, 'user');
    assert.equal(appended.content, 'What happens next, Rex?');
    assert.equal(input.messages.length, 3, 'omitting userMessageText leaves messages exactly as loaded, unchanged');

    const jpegBuffer = await (async () => {
        const image = new Jimp({ width: 16, height: 16, color: 0xffffffff });
        return image.getBuffer(JimpMime.jpeg, { quality: 90, jpegColorSpace: 'ycbcr' });
    })();
    const dataUrl = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
    const withUserMessageExtra = await resolveChatCompletionGenerationInput(directories, {
        avatar, chatContext: await ctxOf({ avatar }, branchName), branchName,
        userMessageText: 'Look at this.',
        userMessageExtra: { media: [{ url: dataUrl, type: 'image', source: 'upload' }], media_index: 0 },
        macroExtras: { imageInlining: true },
    });
    const appendedWithExtra = withUserMessageExtra.messages[0];
    assert.deepEqual(appendedWithExtra.media, [{ url: dataUrl, type: 'image', source: 'upload' }]);
    const resultWithMedia = await buildChatCompletionPrompt(withUserMessageExtra);
    const turnWithMedia = resultWithMedia.chat.find(m => Array.isArray(m.content));
    assert.ok(turnWithMedia, `expected a message with array (multi-part) content once media is inlined, got: ${JSON.stringify(resultWithMedia.chat)}`);
    const imagePart = turnWithMedia.content.find(p => p.type === 'image_url');
    assert.ok(imagePart, 'a real media-attachment reference forwarded via userMessageExtra is actually inlined into the assembled chat-completion payload as a real image_url content part');
    assert.ok(imagePart.image_url.url.startsWith('data:image/jpeg;base64,'));

    fs.writeFileSync(path.join(directories.files, 'notes.txt'), 'The tower key is hidden under the loose stone.');
    const withFileExtra = await resolveChatCompletionGenerationInput(directories, {
        avatar, chatContext: await ctxOf({ avatar }, branchName), branchName,
        userMessageText: 'Check my notes.',
        userMessageExtra: {
            files: [
                { url: '/user/files/notes.txt', size: 42, name: 'notes.txt', created: 1700000000000 },
                { text: 'Also remember: the drawbridge is broken.', size: 10, name: 'inline.txt', created: 1700000000001 },
            ],
        },
    });
    const appendedWithFileExtra = withFileExtra.messages[0];
    assert.equal(appendedWithFileExtra.role, 'user');
    assert.ok(
        appendedWithFileExtra.content.includes('The tower key is hidden under the loose stone.'),
        'the .url-resolved file text was read off disk and inlined',
    );
    assert.ok(
        appendedWithFileExtra.content.includes('Also remember: the drawbridge is broken.'),
        'the already-resolved .text file entry was inlined without a disk read',
    );
    assert.ok(
        appendedWithFileExtra.content.includes('Check my notes.'),
        'the inlined file text is prepended onto the turn\'s own message text, not a replacement of it',
    );

    assert.equal(input.settings.chat_completion_source, 'openai', 'settings forwards the real oai_settings object for buildChatCompletionPrompt() to resolve tool-capability values from internally');
    assert.equal(input.canUseToolsOverride, undefined);
    assert.ok(input.tokenHandler && typeof input.tokenHandler.countAsync === 'function', 'a real TokenHandler is constructed');

    assert.equal(input.imageInlining, false);
    assert.equal(input.videoInlining, false);
    assert.equal(input.audioInlining, false);
    assert.equal(input.bias, '');

    const overridden = await resolveChatCompletionGenerationInput(directories, {
        avatar, chatContext: await ctxOf({ avatar }, branchName), branchName,
        macroExtras: { quietPrompt: 'Summarize the scene.', bias: '+happy' },
    });
    assert.equal(overridden.quietPrompt, 'Summarize the scene.', 'macroExtras is shallow-merged over the resolved object');
    assert.equal(overridden.bias, '+happy');

    const result = await buildChatCompletionPrompt(input);
    assert.ok(Array.isArray(result.chat), 'buildChatCompletionPrompt() returns a real chat array, not null/undefined');
    assert.ok(result.chat.length > 0, 'the assembled chat-completion payload is non-empty end to end');
    const flattened = JSON.stringify(result.chat);
    assert.ok(flattened.includes('Hello there, traveler.'), 'the real chat history made it into the final chat-completion payload');
    assert.ok(
        flattened.includes('The ancient tower looms over the village.'),
        'the genuinely-activated world-info content (worldInfoBefore) made it all the way into the final assembled chat-completion payload, end to end',
    );
    assert.equal(typeof result.canUseTools, 'boolean', 'canUseTools is resolved internally by buildChatCompletionPrompt(), not by this resolver');
    assert.equal(result.canUseTools, false, 'function_calling is not set in the fixture, so tool calling resolves to false internally');

    const depthOccurrences = result.chat.filter(msg => JSON.stringify(msg).includes(WI_DEPTH_TEST_CONTENT)).length;
    assert.ok(depthOccurrences > 0, 'the @Depth entry content made it into the final assembled chat-completion payload, end to end');
    assert.equal(depthOccurrences, 1, 'the @Depth entry content appears exactly once - not duplicated into worldInfoBefore/worldInfoAfter as well');

    const resultWithUserMessage = await buildChatCompletionPrompt(withUserMessage);
    const flattenedWithUserMessage = JSON.stringify(resultWithUserMessage.chat);
    assert.ok(
        flattenedWithUserMessage.includes('What happens next, Rex?'),
        'the new user message appended by userMessageText made it into the final assembled chat-completion payload',
    );

    const biasFixture = buildSettingsFixture();
    biasFixture.power_user.user_prompt_bias = 'always speak in riddles';
    writeAllSettings(directories, biasFixture);
    const withBias = await resolveChatCompletionGenerationInput(directories, {
        avatar, chatContext: await ctxOf({ avatar }, branchName), branchName,
        type: 'normal',
    });
    assert.equal(
        withBias.bias, 'always speak in riddles',
        'bias resolves via the real getBiasStrings(), falling back to power_user.user_prompt_bias when no textareaText/message-embedded bias is present',
    );

    const withBiasContinue = await resolveChatCompletionGenerationInput(directories, {
        avatar, chatContext: await ctxOf({ avatar }, branchName), branchName,
        type: 'continue',
    });
    assert.equal(withBiasContinue.bias, '', 'type: \'continue\' short-circuits getBiasStrings() to an empty bias, per its own real behavior');

    writeAllSettings(directories, buildSettingsFixture());

    {
        const nova = await writeCharacter('Nova.png', {
            name: 'Nova',
            description: 'Nova is a stoic starship engineer.',
            data: { name: 'Nova', description: 'Nova is a stoic starship engineer.', first_mes: 'Systems nominal.' },
        });
        const zephyr = await writeCharacter('Zephyr.png', {
            name: 'Zephyr',
            description: 'Zephyr is a chaotic weather spirit.',
            data: { name: 'Zephyr', description: 'Zephyr is a chaotic weather spirit.', first_mes: 'Winds are shifting!' },
        });

        const groupId = 'test-group-1';
        const groupChatId = 'test-group-1-chat';
        const groupMetadata = {
            id: groupId,
            name: 'Adventuring Party',
            members: [nova, zephyr],
            avatar_url: 'img/ai4.png',
            allow_self_responses: false,
            activation_strategy: 0,
            generation_mode: 1,
            disabled_members: [],
            fav: false,
            chat_id: groupChatId,
            chats: [groupChatId],
            auto_mode_delay: 5,
            generation_mode_join_prefix: '',
            generation_mode_join_suffix: '',
        };
        await user.store.lib.writeGroup(groupMetadata);

        await saveBranch(user.store, { group: groupId }, groupChatId, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hello, party!', send_date: 1, extra: {} },
            { name: 'Zephyr', is_user: false, mes: 'Winds are shifting!', send_date: 2, extra: {} },
        ]);

        const groupInput = await resolveChatCompletionGenerationInput(directories, {
            avatar: nova, groupId, chatContext: await ctxOf({ group: groupId }, groupChatId), branchName: groupChatId,
            type: 'normal',
        });

        assert.equal(groupInput.macroContext.isGroup, true, 'isGroup is real (Boolean(groupId)) in macroContext');
        assert.equal(groupInput.historyOptions.isGroup, true, 'isGroup is real in historyOptions');

        assert.equal(groupInput.name2, 'Nova', 'name2 resolves to the specific responding member, not the group\'s own name, even though groupId is also set');

        assert.deepEqual(groupInput.groupMemberNames.slice().sort(), ['Nova', 'Zephyr'], 'groupMemberNames covers the whole roster, as a plain string[]');

        assert.ok(groupInput.charDescription.includes('Nova is a stoic starship engineer.'), 'combined charDescription includes Nova\'s own description');
        assert.ok(groupInput.charDescription.includes('Zephyr is a chaotic weather spirit.'), 'combined charDescription ALSO includes Zephyr\'s description - proving real combining, not just the responding member\'s own uncombined card');

        const groupResult = await buildChatCompletionPrompt(groupInput);
        assert.ok(Array.isArray(groupResult.chat), 'buildChatCompletionPrompt() returns a real chat array for a group turn');
        const groupFlattened = JSON.stringify(groupResult.chat);
        assert.ok(groupFlattened.includes('Zephyr: Winds are shifting!'), 'the non-responding member\'s message is name-prefixed ("Zephyr: ...") in the assembled chat-completion payload - real group-appropriate name-prefixing, not the single-character (unprefixed) behavior');
        assert.ok(groupFlattened.includes('Nova is a stoic starship engineer.'), 'the combined group-card description made it all the way into the final assembled chat-completion payload');
        assert.ok(groupFlattened.includes('Zephyr is a chaotic weather spirit.'), 'the OTHER member\'s combined-card description also made it into the final assembled chat-completion payload');
    }

    {
        const mainLeafId = input.macroContext.chat[input.macroContext.chat.length - 1].node_id;
        const viaNodeId = await resolveChatCompletionGenerationInput(directories, {
            avatar, chatContext: await ctxOf({ avatar }, branchName), nodeId: mainLeafId,
        });
        const withoutBookmarkLink = chat => chat.map(m => {
            const extra = { ...m.extra };
            delete extra.bookmark_link;
            return { ...m, extra };
        });
        assert.deepEqual(withoutBookmarkLink(viaNodeId.macroContext.chat), withoutBookmarkLink(input.macroContext.chat), 'an explicit node_id resolves the exact same chat history as the equivalent explicit branch_name');
        assert.equal(viaNodeId.resolvedNodeId, mainLeafId, 'resolvedNodeId echoes back the given node_id');
        assert.equal(viaNodeId.chatResolutionAmbiguous, false);

        const ambiguous = await resolveChatCompletionGenerationInput(directories, {
            avatar, chatContext: await ctxOf({ avatar }),
        });
        assert.equal(ambiguous.chatResolutionAmbiguous, true, 'an owner with real existing history and no given identifier is reported as ambiguous, not silently resolved');
        assert.equal(ambiguous.resolvedNodeId, null);
        assert.equal(ambiguous.rawChatLength, 0, 'the ambiguous case resolves to an empty chat rather than guessing the current leaf');

        const freshAvatar = await writeCharacter('FreshOwner.png', { name: 'FreshOwner', data: { name: 'FreshOwner', first_mes: 'Hi.' } });
        const fresh = await resolveChatCompletionGenerationInput(directories, {
            avatar: freshAvatar, chatContext: await ctxOf({ avatar: freshAvatar }),
        });
        assert.equal(fresh.chatResolutionAmbiguous, false, 'a genuinely empty owner is not ambiguous');
        assert.equal(fresh.resolvedNodeId, null, 'a genuinely empty owner\'s chat is at the tree\'s root');
        assert.equal(fresh.rawChatLength, 0, 'a genuinely new owner correctly resolves to an empty chat, not an error');
    }

    {
        await writeLorebook('FlagLore', [
            { uid: 'f1', key: ['TRAVELER'], keysecondary: [], comment: '', content: 'Upper case key content.', constant: false, selective: false, order: 10, position: 0, disable: false },
            { uid: 'f2', key: ['travel'], keysecondary: [], comment: '', content: 'Part of a word content.', constant: false, selective: false, order: 11, position: 0, disable: false },
        ]);
        const shownWith = async (worldInfoFlags) => {
            const settings = buildSettingsFixture();
            settings.world_info_settings.world_info.globalSelect = ['FlagLore'];
            Object.assign(settings.world_info_settings, worldInfoFlags);
            writeAllSettings(directories, settings);
            const resolved = await resolveChatCompletionGenerationInput(directories, {
                avatar, chatContext: await ctxOf({ avatar }, branchName), branchName, type: 'normal', dryRun: true,
            });
            return resolved.worldInfoBefore;
        };
        const loose = await shownWith({ world_info_case_sensitive: false, world_info_match_whole_words: false });
        assert.ok(loose.includes('Upper case key content.'), 'with the global case setting off, a key without its own flag matches in any case');
        assert.ok(loose.includes('Part of a word content.'), 'with the global whole-words setting off, a key without its own flag matches inside a word');
        const strict = await shownWith({ world_info_case_sensitive: true, world_info_match_whole_words: true });
        assert.ok(!strict.includes('Upper case key content.'), 'with the global case setting on, a key without its own flag matches only in its own case');
        assert.ok(!strict.includes('Part of a word content.'), 'with the global whole-words setting on, a key without its own flag matches only whole words');
        writeAllSettings(directories, buildSettingsFixture());
    }

    console.log('chat-completion-generation-input.test.js: all assertions passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => user.close());
