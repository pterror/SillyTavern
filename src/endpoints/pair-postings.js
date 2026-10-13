import express from 'express';

import { requestStore, storeRoute } from '../user-stores.js';

/**
 * The search option "Faster quoted phrases (uses more disk)" (build path 5d, pair postings): an index of adjacent
 * word pairs, built or deleted over the user's existing text in the background when the option changes.
 */
export const router = express.Router();

/** `{ on }`: turns the pair postings on or off. Answers the option as it is then (`{ on, pending }`). */
router.post('/', storeRoute('changing the pair postings', async (request, response) => {
    if (typeof request.body?.on !== 'boolean') return response.status(400).send({ error: 'on must be a boolean' });
    const { lib } = await requestStore(request);
    await lib.setPairPostings(request.body.on);
    return response.send(await lib.pairPostings());
}));

/** The option as it is: `{ on, pending }`, `pending` while its build or delete is under way. */
router.post('/state', storeRoute('reading the pair postings', async (request, response) => {
    const { lib } = await requestStore(request);
    return response.send(await lib.pairPostings());
}));
