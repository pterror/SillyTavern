import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { write as writeCard } from './character-card-parser.js';
// character-card-fields.js pulls in src/endpoints/characters.js, which (via character-shallow.js)
// reads process-wide config at import time - set the config path before importing it, the same way
// the real server does at startup (src/config-init.js), since this test runs standalone.
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));
const { getCharacterCardFields } = await import('./character-card-fields.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-card-fields-test-'));
const charactersDir = path.join(root, 'characters');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(charactersDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

const directories = { root, characters: charactersDir, groups: groupsDir };
// endpoints/characters.js's on-disk read cache keys its cache dir off this global (set by the real
// server at startup) - point it at our fixture root so the cache doesn't error out standalone.
globalThis.DATA_ROOT = root;

// A real base PNG to embed card JSON into, same technique tests/character-metadata-db.test.js uses.
const baseImage = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'ai4.png'));

/**
 * Writes a minimal valid Spec V2 character card PNG to the fixture characters directory.
 * @param {string} avatar Filename, e.g. 'Alice.png'
 * @param {object} overrides Shallow-merged onto a minimal card (top-level fields win over `data` mirror by spec)
 * @returns {string} avatar (for chaining into a group's members list)
 */
function writeCharacter(avatar, overrides = {}) {
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
    // Keep data.* mirrors in sync unless the caller explicitly overrode `data` itself.
    if (!Object.prototype.hasOwnProperty.call(overrides, 'data')) {
        for (const key of ['description', 'personality', 'scenario', 'first_mes', 'mes_example']) {
            if (Object.prototype.hasOwnProperty.call(overrides, key)) {
                card.data[key] = overrides[key];
            }
        }
    }
    const buffer = writeCard(baseImage, JSON.stringify(card));
    fs.writeFileSync(path.join(charactersDir, avatar), buffer);
    return avatar;
}

function writeGroup(id, group) {
    fs.writeFileSync(path.join(groupsDir, `${id}.json`), JSON.stringify({ id, ...group }));
}

async function run() {
    // 1. Plain non-group character - all fields resolve, both prefer flags on.
    {
        const avatar = writeCharacter('Alice.png', {
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
        // depth_prompt has no explicit depth/role -> defaults (4 / SYSTEM=0).
        assert.equal(fields.charDepthPromptDepth, 4);
        assert.equal(fields.charDepthPromptRole, 0);
        assert.equal(fields.creatorNotes, 'Notes about Alice.');
        assert.equal(fields.persona, 'A curious ');
        assert.deepEqual(fields.alternateGreetings, ['Greeting one from Alice', 'Greeting two from Alice']);
    }

    // 2. prefer_character_prompt / prefer_character_jailbreak off -> system/jailbreak resolve to ''.
    {
        const avatar = writeCharacter('Bob.png', {
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

    // 3. chat_metadata.scenario / chat_metadata.mes_example override the character's own values.
    {
        const avatar = writeCharacter('Carol.png', {
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

        // Without a chat_metadata override, the character's own values are used.
        const fieldsNoOverride = await getCharacterCardFields(directories, { avatar, chatMetadata: {} });
        assert.equal(fieldsNoOverride.scenario, 'Carol\'s own scenario');
        assert.equal(fieldsNoOverride.mesExamples, '<START>\nCarol\'s own example');
    }

    // 4. No avatar at all -> every field resolves to its empty/default fallback.
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
        // No character at all -> depth-prompt sub-fields fall back to the same defaults too.
        assert.equal(fields.charDepthPromptDepth, 4);
        assert.equal(fields.charDepthPromptRole, 0);
    }

    // 4b. depth_prompt.depth/.role explicitly set - custom numeric depth, and role given by name.
    {
        const avatarUser = writeCharacter('Dave.png', {
            data: {
                name: 'Dave',
                extensions: { depth_prompt: { prompt: 'Dave depth note', depth: 7, role: 'user' } },
            },
        });
        const fieldsUser = await getCharacterCardFields(directories, { avatar: avatarUser });
        assert.equal(fieldsUser.charDepthPrompt, 'Dave depth note');
        assert.equal(fieldsUser.charDepthPromptDepth, 7);
        assert.equal(fieldsUser.charDepthPromptRole, 1, 'role \'user\' resolves to extension_prompt_roles.USER (1)');

        const avatarAssistant = writeCharacter('Eve.png', {
            data: {
                name: 'Eve',
                extensions: { depth_prompt: { prompt: 'Eve depth note', depth: 0, role: 'assistant' } },
            },
        });
        const fieldsAssistant = await getCharacterCardFields(directories, { avatar: avatarAssistant });
        assert.equal(fieldsAssistant.charDepthPromptDepth, 0);
        assert.equal(fieldsAssistant.charDepthPromptRole, 2, 'role \'assistant\' resolves to extension_prompt_roles.ASSISTANT (2)');

        // A role already given as a valid number passes through as-is.
        const avatarNumericRole = writeCharacter('Frank.png', {
            data: {
                name: 'Frank',
                extensions: { depth_prompt: { prompt: 'Frank depth note', depth: 2, role: 1 } },
            },
        });
        const fieldsNumericRole = await getCharacterCardFields(directories, { avatar: avatarNumericRole });
        assert.equal(fieldsNumericRole.charDepthPromptRole, 1, 'a valid numeric role passes through unchanged');

        // An unrecognized role string falls back to SYSTEM (0), matching the client's own fallback.
        const avatarBadRole = writeCharacter('Grace.png', {
            data: {
                name: 'Grace',
                extensions: { depth_prompt: { prompt: 'Grace depth note', role: 'not-a-role' } },
            },
        });
        const fieldsBadRole = await getCharacterCardFields(directories, { avatar: avatarBadRole });
        assert.equal(fieldsBadRole.charDepthPromptRole, 0, 'unrecognized role name falls back to SYSTEM (0)');
    }

    // 5. Group-combine path.
    {
        const memberA = writeCharacter('GroupMemberA.png', {
            description: 'A description',
            personality: 'A personality',
            scenario: 'A scenario',
            mes_example: 'A example line',
            data: { name: 'MemberA' },
        });
        const memberB = writeCharacter('GroupMemberB.png', {
            description: 'B description',
            personality: 'B personality',
            scenario: 'B scenario',
            mes_example: 'B example line',
            data: { name: 'MemberB' },
        });
        const memberDisabled = writeCharacter('GroupMemberDisabled.png', {
            description: 'Disabled description',
            data: { name: 'MemberDisabled' },
        });

        // generation_mode: APPEND (1) - disabled member is skipped unless it's the "current" avatar.
        writeGroup('group-append', {
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

        // Disabled member (not the "current" avatar) is skipped entirely.
        assert.ok(!fields.description.includes('Disabled description'), 'disabled member is skipped in APPEND mode');
        // Prefix/suffix wrap each member's contribution, with <FIELDNAME> and {{char}} substituted per-member.
        assert.equal(
            fields.description,
            '[Description of MemberA]\nA description\n[/Description]\n[Description of MemberB]\nB description\n[/Description]',
        );
        assert.equal(
            fields.personality,
            '[Personality of MemberA]\nA personality\n[/Personality]\n[Personality of MemberB]\nB personality\n[/Personality]',
        );
        // No chat_metadata override -> collected from members.
        assert.equal(
            fields.scenario,
            '[Scenario of MemberA]\nA scenario\n[/Scenario]\n[Scenario of MemberB]\nB scenario\n[/Scenario]',
        );
        // mesExamples: each member's raw text is preprocessed with a <START> prefix before being wrapped.
        assert.equal(
            fields.mesExamples,
            '[Example Messages of MemberA]\n<START>\nA example line\n[/Example Messages]\n'
            + '[Example Messages of MemberB]\n<START>\nB example line\n[/Example Messages]',
        );

        // The disabled member IS included when it's the "current" characterAvatar being asked about.
        const fieldsAsDisabled = await getCharacterCardFields(directories, {
            avatar: memberDisabled,
            groupId: 'group-append',
        });
        assert.ok(fieldsAsDisabled.description.includes('Disabled description'), 'disabled member is included when it is the current avatar');

        // generation_mode: APPEND_DISABLED (2) - disabled members are always included.
        writeGroup('group-append-disabled', {
            generation_mode: 2,
            members: [memberA, memberDisabled],
            disabled_members: [memberDisabled],
        });
        const fieldsAppendDisabled = await getCharacterCardFields(directories, {
            avatar: memberA,
            groupId: 'group-append-disabled',
        });
        assert.ok(fieldsAppendDisabled.description.includes('Disabled description'), 'APPEND_DISABLED mode always includes disabled members');

        // chat_metadata.scenario/mes_example override wins over the collected group value.
        const fieldsOverride = await getCharacterCardFields(directories, {
            avatar: memberA,
            groupId: 'group-append',
            chatMetadata: { scenario: 'Group chat scenario override', mes_example: 'Group chat example override' },
        });
        assert.equal(fieldsOverride.scenario, 'Group chat scenario override');
        assert.equal(fieldsOverride.mesExamples, 'Group chat example override');

        // A group with generation_mode SWAP (0, falsy) never combines - falls back to the plain character.
        writeGroup('group-swap', { generation_mode: 0, members: [memberA, memberB] });
        const fieldsSwap = await getCharacterCardFields(directories, { avatar: memberA, groupId: 'group-swap' });
        assert.equal(fieldsSwap.description, 'A description');
    }

    console.log('character-card-fields.test.js: all assertions passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
