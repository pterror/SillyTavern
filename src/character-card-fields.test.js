import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { write as writeCard } from './character-card-parser.js';
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));
const { getCharacterCardFields, getGroupCharacterDepthPrompts } = await import('./character-card-fields.js');

const { convertedUser, writeLibraryCard } = await import('../tests/converted-user.fixture.js');

const user = await convertedUser('st-character-card-fields-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

const baseImage = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'ai4.png'));

/**
 * @param {string} avatar
 * @param {object} overrides
 * @returns {Promise<string>}
 */
async function writeCharacter(avatar, overrides = {}) {
    const name = overrides.data?.name ?? overrides.name ?? avatar.replace(/\.png$/, '');
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
    if (!Object.prototype.hasOwnProperty.call(overrides, 'data')) {
        for (const key of ['description', 'personality', 'scenario', 'first_mes', 'mes_example']) {
            if (Object.prototype.hasOwnProperty.call(overrides, key)) {
                card.data[key] = overrides[key];
            }
        }
    }
    const cardJson = JSON.stringify(card);
    const buffer = writeCard(baseImage, cardJson);
    await writeLibraryCard(user, avatar, cardJson, buffer);
    return avatar;
}

async function writeGroup(id, group) {
    await user.store.lib.writeGroup({ id, ...group });
}

async function run() {
    {
        const avatar = await writeCharacter('Alice.png', {
            description: 'Alice is {{char}}.',
            personality: 'Cheerful',
            scenario: 'A cozy cafe',
            mes_example: '<START>\n{{char}}: Hi!',
            first_mes: 'Hello, {{char}} here!',
            data: {
                name: 'Alice',
                description: 'Alice is {{char}}.',
                personality: 'Cheerful',
                scenario: 'A cozy cafe',
                first_mes: 'Hello, {{char}} here!',
                mes_example: '<START>\n{{char}}: Hi!',
                system_prompt: 'You are {{char}}.',
                post_history_instructions: 'Stay in character as {{char}}.',
                character_version: '1.2',
                creator_notes: 'Notes about {{char}}.',
                alternate_greetings: ['Greeting one from {{char}}', 'Greeting two from {{char}}'],
                extensions: { depth_prompt: { prompt: 'Depth note for {{char}}' } },
            },
        });

        const fields = await getCharacterCardFields(directories, {
            avatar,
            preferCharacterPrompt: true,
            preferCharacterJailbreak: true,
            personaDescription: 'A curious {{user}}',
        });

        assert.equal(fields.system, 'You are Alice.', 'system resolves and macro-substitutes when preferCharacterPrompt is true');
        assert.equal(fields.jailbreak, 'Stay in character as Alice.');
        assert.equal(fields.description, 'Alice is Alice.');
        assert.equal(fields.personality, 'Cheerful');
        assert.equal(fields.scenario, 'A cozy cafe');
        assert.equal(fields.mesExamples, '<START>\nAlice: Hi!');
        assert.equal(fields.firstMessage, 'Hello, Alice here!');
        assert.equal(fields.version, '1.2');
        assert.equal(fields.charDepthPrompt, 'Depth note for Alice');
        assert.equal(fields.charDepthPromptDepth, 4);
        assert.equal(fields.charDepthPromptRole, 0);
        assert.equal(fields.creatorNotes, 'Notes about Alice.');
        assert.equal(fields.persona, 'A curious ');
        assert.deepEqual(fields.alternateGreetings, ['Greeting one from Alice', 'Greeting two from Alice']);
    }

    {
        const avatar = await writeCharacter('Bob.png', {
            data: {
                name: 'Bob',
                system_prompt: 'You are Bob.',
                post_history_instructions: 'Stay Bob.',
            },
        });
        const fields = await getCharacterCardFields(directories, {
            avatar,
            preferCharacterPrompt: false,
            preferCharacterJailbreak: false,
        });
        assert.equal(fields.system, '');
        assert.equal(fields.jailbreak, '');
    }

    {
        const avatar = await writeCharacter('Carol.png', {
            scenario: 'Carol\'s own scenario',
            mes_example: '<START>\nCarol\'s own example',
            data: { name: 'Carol' },
        });
        const fields = await getCharacterCardFields(directories, {
            avatar,
            chatMetadata: { scenario: 'Per-chat scenario override', mes_example: 'Per-chat example override' },
        });
        assert.equal(fields.scenario, 'Per-chat scenario override');
        assert.equal(fields.mesExamples, 'Per-chat example override');

        const fieldsNoOverride = await getCharacterCardFields(directories, { avatar, chatMetadata: {} });
        assert.equal(fieldsNoOverride.scenario, 'Carol\'s own scenario');
        assert.equal(fieldsNoOverride.mesExamples, '<START>\nCarol\'s own example');
    }

    {
        const fields = await getCharacterCardFields(directories, { avatar: undefined, personaDescription: 'Just a persona' });
        assert.equal(fields.system, '');
        assert.equal(fields.jailbreak, '');
        assert.equal(fields.description, '');
        assert.equal(fields.personality, '');
        assert.equal(fields.scenario, '');
        assert.equal(fields.mesExamples, '');
        assert.equal(fields.firstMessage, '');
        assert.equal(fields.version, '');
        assert.deepEqual(fields.alternateGreetings, []);
        assert.equal(fields.persona, 'Just a persona');
        assert.equal(fields.charDepthPromptDepth, 4);
        assert.equal(fields.charDepthPromptRole, 0);
    }

    {
        const avatarUser = await writeCharacter('Dave.png', {
            data: {
                name: 'Dave',
                extensions: { depth_prompt: { prompt: 'Dave depth note', depth: 7, role: 'user' } },
            },
        });
        const fieldsUser = await getCharacterCardFields(directories, { avatar: avatarUser });
        assert.equal(fieldsUser.charDepthPrompt, 'Dave depth note');
        assert.equal(fieldsUser.charDepthPromptDepth, 7);
        assert.equal(fieldsUser.charDepthPromptRole, 1, 'role \'user\' resolves to extension_prompt_roles.USER (1)');

        const avatarAssistant = await writeCharacter('Eve.png', {
            data: {
                name: 'Eve',
                extensions: { depth_prompt: { prompt: 'Eve depth note', depth: 0, role: 'assistant' } },
            },
        });
        const fieldsAssistant = await getCharacterCardFields(directories, { avatar: avatarAssistant });
        assert.equal(fieldsAssistant.charDepthPromptDepth, 0);
        assert.equal(fieldsAssistant.charDepthPromptRole, 2, 'role \'assistant\' resolves to extension_prompt_roles.ASSISTANT (2)');

        const avatarNumericRole = await writeCharacter('Frank.png', {
            data: {
                name: 'Frank',
                extensions: { depth_prompt: { prompt: 'Frank depth note', depth: 2, role: 1 } },
            },
        });
        const fieldsNumericRole = await getCharacterCardFields(directories, { avatar: avatarNumericRole });
        assert.equal(fieldsNumericRole.charDepthPromptRole, 1, 'a valid numeric role passes through unchanged');

        const avatarBadRole = await writeCharacter('Grace.png', {
            data: {
                name: 'Grace',
                extensions: { depth_prompt: { prompt: 'Grace depth note', role: 'not-a-role' } },
            },
        });
        const fieldsBadRole = await getCharacterCardFields(directories, { avatar: avatarBadRole });
        assert.equal(fieldsBadRole.charDepthPromptRole, 0, 'unrecognized role name falls back to SYSTEM (0)');
    }

    {
        const memberA = await writeCharacter('GroupMemberA.png', {
            description: 'A description',
            personality: 'A personality',
            scenario: 'A scenario',
            mes_example: 'A example line',
            data: { name: 'MemberA' },
        });
        const memberB = await writeCharacter('GroupMemberB.png', {
            description: 'B description',
            personality: 'B personality',
            scenario: 'B scenario',
            mes_example: 'B example line',
            data: { name: 'MemberB' },
        });
        const memberDisabled = await writeCharacter('GroupMemberDisabled.png', {
            description: 'Disabled description',
            data: { name: 'MemberDisabled' },
        });

        await writeGroup('group-append', {
            generation_mode: 1,
            members: [memberA, memberB, memberDisabled],
            disabled_members: [memberDisabled],
            generation_mode_join_prefix: '[<FIELDNAME> of {{char}}]\n',
            generation_mode_join_suffix: '\n[/<FIELDNAME>]',
        });

        const fields = await getCharacterCardFields(directories, {
            avatar: memberA,
            groupId: 'group-append',
            chatMetadata: {},
        });

        assert.ok(!fields.description.includes('Disabled description'), 'disabled member is skipped in APPEND mode');
        assert.equal(
            fields.description,
            '[Description of MemberA]\nA description\n[/Description]\n[Description of MemberB]\nB description\n[/Description]',
        );
        assert.equal(
            fields.personality,
            '[Personality of MemberA]\nA personality\n[/Personality]\n[Personality of MemberB]\nB personality\n[/Personality]',
        );
        assert.equal(
            fields.scenario,
            '[Scenario of MemberA]\nA scenario\n[/Scenario]\n[Scenario of MemberB]\nB scenario\n[/Scenario]',
        );
        assert.equal(
            fields.mesExamples,
            '[Example Messages of MemberA]\n<START>\nA example line\n[/Example Messages]\n'
            + '[Example Messages of MemberB]\n<START>\nB example line\n[/Example Messages]',
        );

        const fieldsAsDisabled = await getCharacterCardFields(directories, {
            avatar: memberDisabled,
            groupId: 'group-append',
        });
        assert.ok(fieldsAsDisabled.description.includes('Disabled description'), 'disabled member is included when it is the current avatar');

        await writeGroup('group-append-disabled', {
            generation_mode: 2,
            members: [memberA, memberDisabled],
            disabled_members: [memberDisabled],
        });
        const fieldsAppendDisabled = await getCharacterCardFields(directories, {
            avatar: memberA,
            groupId: 'group-append-disabled',
        });
        assert.ok(fieldsAppendDisabled.description.includes('Disabled description'), 'APPEND_DISABLED mode always includes disabled members');

        const fieldsOverride = await getCharacterCardFields(directories, {
            avatar: memberA,
            groupId: 'group-append',
            chatMetadata: { scenario: 'Group chat scenario override', mes_example: 'Group chat example override' },
        });
        assert.equal(fieldsOverride.scenario, 'Group chat scenario override');
        assert.equal(fieldsOverride.mesExamples, 'Group chat example override');

        await writeGroup('group-swap', { generation_mode: 0, members: [memberA, memberB] });
        const fieldsSwap = await getCharacterCardFields(directories, { avatar: memberA, groupId: 'group-swap' });
        assert.equal(fieldsSwap.description, 'A description');
    }

    {
        const memberNoPrompt = await writeCharacter('DepthMemberNone.png', {
            data: { name: 'DepthMemberNone' },
        });
        const memberWithPrompt = await writeCharacter('DepthMemberWith.png', {
            data: {
                name: 'DepthMemberWith',
                extensions: { depth_prompt: { prompt: 'Depth note for {{char}}', depth: 3, role: 'user' } },
            },
        });
        const memberDisabledCurrent = await writeCharacter('DepthMemberDisabledCurrent.png', {
            data: {
                name: 'DepthMemberDisabledCurrent',
                extensions: { depth_prompt: { prompt: 'Disabled-but-current note' } },
            },
        });
        const memberDisabledOther = await writeCharacter('DepthMemberDisabledOther.png', {
            data: {
                name: 'DepthMemberDisabledOther',
                extensions: { depth_prompt: { prompt: 'Disabled-and-not-current note' } },
            },
        });

        await writeGroup('group-depth-prompts', {
            generation_mode: 1,
            members: [memberNoPrompt, memberWithPrompt, memberDisabledCurrent, memberDisabledOther],
            disabled_members: [memberDisabledCurrent, memberDisabledOther],
        });

        const depthPrompts = await getGroupCharacterDepthPrompts(directories, 'group-depth-prompts', memberDisabledCurrent);
        assert.equal(depthPrompts.length, 2, 'no-prompt member excluded, disabled-and-not-current member excluded');
        const byText = depthPrompts.map(p => p.text);
        assert.ok(byText.includes('Depth note for DepthMemberWith'), 'enabled member with a depth_prompt is included, macro-substituted');
        assert.ok(byText.includes('Disabled-but-current note'), 'disabled member IS included when it is the current characterAvatar');
        assert.ok(!byText.includes('Disabled-and-not-current note'), 'disabled member that is NOT the current characterAvatar is excluded');

        const withPromptEntry = depthPrompts.find(p => p.text === 'Depth note for DepthMemberWith');
        assert.equal(withPromptEntry.depth, 3);
        assert.equal(withPromptEntry.role, 1, 'role \'user\' resolves to extension_prompt_roles.USER (1)');

        const disabledCurrentEntry = depthPrompts.find(p => p.text === 'Disabled-but-current note');
        assert.equal(disabledCurrentEntry.depth, 4, 'no explicit depth -> DEPTH_PROMPT_DEPTH_DEFAULT (4)');
        assert.equal(disabledCurrentEntry.role, 0, 'no explicit role -> SYSTEM (0)');

        await writeGroup('group-depth-prompts-swap', {
            generation_mode: 0,
            members: [memberWithPrompt],
        });
        const swapPrompts = await getGroupCharacterDepthPrompts(directories, 'group-depth-prompts-swap', memberWithPrompt);
        assert.deepEqual(swapPrompts, [], 'SWAP-mode group returns no depth prompts at all');

        assert.deepEqual(await getGroupCharacterDepthPrompts(directories, undefined, memberWithPrompt), []);
        assert.deepEqual(await getGroupCharacterDepthPrompts(directories, 'no-such-group', memberWithPrompt), []);
    }

    console.log('character-card-fields.test.js: all assertions passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => user.close());
