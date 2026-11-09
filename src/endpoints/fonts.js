import express from 'express';

import { FONT_ID } from '@st/looks/look';
import { fontsDirectory } from '../looks-store.js';

export const router = express.Router();

const IMMUTABLE = 'public, max-age=31536000, immutable';
const TYPES = Object.freeze({ woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' });

// A font is named by its bytes' hash, so its address never shows other bytes.
router.get('/:id', (request, response) => {
    const { id } = request.params;
    if (!FONT_ID.test(id)) return response.sendStatus(404);
    response.setHeader('Cache-Control', IMMUTABLE);
    response.type(TYPES[/** @type {keyof typeof TYPES} */ (id.slice(id.lastIndexOf('.') + 1))]);
    return response.sendFile(id, { root: fontsDirectory(request.user.directories.root) }, error => {
        if (error && !response.headersSent) response.sendStatus(404);
    });
});
