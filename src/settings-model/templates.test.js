import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TYPE } from '../library-codes.js';
import { TEMPLATE_KINDS, bindingFromUpstream, bindingToUpstream, templateFromUpstream, templateToUpstream } from './templates.js';

const PRESETS = path.join(import.meta.dirname, '../../default/content/presets');

for (const kind of TEMPLATE_KINDS) {
    test(`every shipped ${kind} template comes back as it came`, () => {
        const files = fs.readdirSync(path.join(PRESETS, kind)).filter(file => file.endsWith('.json'));
        assert.ok(files.length > 0);
        for (const file of files) {
            const json = JSON.parse(fs.readFileSync(path.join(PRESETS, kind, file), 'utf8'));
            const name = path.basename(file, '.json');
            const template = templateFromUpstream(kind, name, structuredClone(json));
            assert.equal(template.type, TYPE.template);
            assert.equal(template.key, `${kind}:${name}`);
            assert.deepEqual(templateToUpstream(JSON.parse(JSON.stringify(template))), json, file);
        }
    });
}

test('a template keeps fields that aren\'t upstream\'s', () => {
    const file = { name: 'X', content: 'c', extensions: { a: [1] }, someday: true };
    assert.deepEqual(templateToUpstream(templateFromUpstream('sysprompt', 'X', file)), file);
});

test('an unknown template kind is refused', () => {
    assert.throws(() => templateFromUpstream('story', 'X', {}));
});

test('a model binding refers to its templates by key and gives back their names', () => {
    const binding = bindingFromUpstream('llama-3-8b.gguf', { instruct: 'Llama 3 Instruct', context: 'Llama 3 Instruct' });
    assert.equal(binding.type, TYPE.modelTemplateBinding);
    assert.equal(binding.key, 'llama-3-8b.gguf');
    assert.deepEqual(binding.values, { instruct: 'instruct:Llama 3 Instruct', context: 'context:Llama 3 Instruct' });
    assert.deepEqual(bindingToUpstream(binding), { instruct: 'Llama 3 Instruct', context: 'Llama 3 Instruct' });
    for (const entry of [{ context: 'ChatML' }, { context: null, extra: 1 }, {}]) {
        assert.deepEqual(bindingToUpstream(JSON.parse(JSON.stringify(bindingFromUpstream('h', entry)))), entry);
    }
});
