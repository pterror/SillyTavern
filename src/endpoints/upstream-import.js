import express from 'express';

import { requestStore, storeRoute } from '../user-stores.js';
import { importUpstreamData } from '../upstream-import.js';

/**
 * Imports the user directory's upstream SillyTavern groups, World Info books and chats into the store
 * (src/upstream-import.js): a new store does it once by itself; this runs it again, after files were copied in.
 */
export const router = express.Router();

/**
 * Answers `{ imported: { groups, worlds, chats, groupChats, messages }, present: [{ file, why }], notImported:
 * [{ file, why }] }`: what went in, what the store had already, and what couldn't be imported, with why.
 */
router.post('/', storeRoute('importing the upstream data', async (request, response) => {
    const store = await requestStore(request);
    return response.send(await importUpstreamData(store, request.user.directories));
}));
