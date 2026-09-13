import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { readSettingsAtPaths } from '../settings-store.js';

export const router = express.Router();

// Mirrors the field set in public/scripts/power-user.js's getThemeObject().
const THEME_SETTINGS_FIELDS = [
    'blur_strength', 'main_text_color', 'italics_text_color', 'underline_text_color',
    'quote_text_color', 'blur_tint_color', 'chat_tint_color', 'user_mes_blur_tint_color',
    'bot_mes_blur_tint_color', 'shadow_color', 'shadow_width', 'border_color', 'font_scale',
    'fast_ui_mode', 'waifuMode', 'avatar_style', 'chat_display', 'toastr_position', 'noShadows',
    'chat_width', 'chat_width_max', 'timer_enabled', 'timestamps_enabled', 'timestamp_model_icon',
    'mesIDDisplay_enabled', 'hideChatAvatars_enabled', 'message_token_count_enabled',
    'expand_message_actions', 'enableZenSliders', 'enableLabMode', 'hotswap_enabled', 'custom_css',
    'bogus_folders', 'zoomed_avatar_magnification', 'reduced_motion', 'compact_input_area',
    'show_swipe_num_all_messages', 'click_to_edit', 'media_display',
];

router.post('/save', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    const filename = path.join(request.user.directories.themes, sanitize(`${request.body.name}.json`));
    writeFileAtomicSync(filename, JSON.stringify(request.body, null, 4), 'utf8');

    return response.sendStatus(200);
});

// Composes a theme from the server's own stored power_user settings, instead of trusting a
// client-reassembled snapshot of settings it already has.
router.post('/save-from-settings', (request, response) => {
    const { name, overrides } = request.body ?? {};
    if (!name) {
        return response.sendStatus(400);
    }

    const dottedPaths = THEME_SETTINGS_FIELDS.map(field => `power_user.${field}`);
    const values = readSettingsAtPaths(request.user.directories, dottedPaths);

    const theme = { name };
    for (const field of THEME_SETTINGS_FIELDS) {
        theme[field] = values[`power_user.${field}`];
    }
    if (overrides && typeof overrides === 'object') {
        Object.assign(theme, overrides);
    }

    const filename = path.join(request.user.directories.themes, sanitize(`${name}.json`));
    writeFileAtomicSync(filename, JSON.stringify(theme, null, 4), 'utf8');

    return response.send({ theme });
});

router.post('/delete', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    try {
        const filename = path.join(request.user.directories.themes, sanitize(`${request.body.name}.json`));
        if (!fs.existsSync(filename)) {
            console.error('Theme file not found:', filename);
            return response.sendStatus(404);
        }
        fs.unlinkSync(filename);
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
