import express from 'express';

import { FONT_ID, IMAGE_ID } from '@st/looks/look';
import { fontsDirectory, lookImagesDirectory } from '../looks-store.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const FONT_TYPES = Object.freeze({ woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' });
const IMAGE_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' });

/**
 * A file named by its bytes' hash, so its address never shows other bytes.
 * @param {RegExp} ids
 * @param {Readonly<Record<string, string>>} types
 * @param {(root: string) => string} directory
 */
function byHash(ids, types, directory) {
    const router = express.Router();
    router.get('/:id', (request, response) => {
        const { id } = request.params;
        if (!ids.test(id)) return response.sendStatus(404);
        response.setHeader('Cache-Control', IMMUTABLE);
        response.type(types[id.slice(id.lastIndexOf('.') + 1)]);
        return response.sendFile(id, { root: directory(request.user.directories.root) }, error => {
            if (error && !response.headersSent) response.sendStatus(404);
        });
    });
    return router;
}

export const router = byHash(FONT_ID, FONT_TYPES, fontsDirectory);

// The images drawn as things' small pictures.
export const lookImagesRouter = byHash(IMAGE_ID, IMAGE_TYPES, lookImagesDirectory);
