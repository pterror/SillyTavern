import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const powerUserJs = fs.readFileSync(new URL('../public/scripts/power-user.js', import.meta.url), 'utf8');
const worldInfoJs = fs.readFileSync(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');
const styleCss = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

describe('Lorebook Import Dialog setting', () => {
    test('nothing reads the setting, since the embedded-lorebook import popup is removed', () => {
        expect(worldInfoJs).not.toContain('world_import_dialog');
    });

    test('its control is hidden but stays in the page', () => {
        const labels = indexHtml.match(/<label\b[^>]*\bfor="world_import_dialog"[^>]*>/gi) ?? [];
        expect(labels).toHaveLength(1);
        expect(labels[0]).toMatch(/\bclass="[^"]*\bdisplayNone\b[^"]*"/);
        expect(indexHtml).toMatch(/<input\b[^>]*\bid="world_import_dialog"[^>]*\btype="checkbox"/);
        expect(styleCss).toMatch(/\.displayNone\s*{[^}]*display:\s*none\s*!important;/s);
    });

    test('its setting key keeps its default, load and save', () => {
        expect(powerUserJs).toMatch(/^\s*world_import_dialog: true,$/m);
        expect(powerUserJs).toContain('$(\'#world_import_dialog\').prop(\'checked\', power_user.world_import_dialog);');
        expect(powerUserJs).toMatch(/\$\('#world_import_dialog'\)\.on\('input', function \(\) \{\s*const value = !!\$\(this\)\.prop\('checked'\);\s*power_user\.world_import_dialog = value;\s*saveSettingsDebounced\('power_user\.world_import_dialog'\);/s);
    });
});
