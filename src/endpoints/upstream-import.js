import express from 'express';

import { requestStore, storeRoute } from '../user-stores.js';
import { importUpstreamData } from '../upstream-import.js';

export const router = express.Router();

router.post('/', storeRoute('importing the upstream data', async (request, response) => {
    const store = await requestStore(request);
    return response.send(await importUpstreamData(store, request.user.directories));
}));
