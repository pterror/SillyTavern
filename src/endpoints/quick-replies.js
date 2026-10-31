import express from 'express';
import sanitize from 'sanitize-filename';

import { deleteBundle, readBundle, writeBundle } from '../bundle-store.js';

export const router = express.Router();

router.post('/save', async (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    return response.sendStatus(await writeBundle(request.user.directories, 'quickReplies', request.body.name, request.body) ? 200 : 400);
});

router.post('/save-partial', async (request, response) => {
    const { name, setProps, qrUpdates, qrDeletes, qrAdds, qrOrder } = request.body ?? {};
    if (!name) {
        return response.sendStatus(400);
    }

    if (!sanitize(String(name))) {
        return response.sendStatus(400);
    }

    let current = /** @type {Record<string, any>} */ ((await readBundle(request.user.directories, 'quickReplies', name)) ?? {});

    if (setProps && typeof setProps === 'object' && !Array.isArray(setProps)) {
        const safeProps = { ...setProps };
        delete safeProps.qrList;
        delete safeProps.name;
        Object.assign(current, safeProps);
    }

    if (Array.isArray(qrUpdates)) {
        const qrList = current.qrList ?? [];
        for (const update of qrUpdates) {
            if (update.id == null) continue;
            const existing = qrList.find(qr => qr.id === update.id);
            if (existing) {
                Object.assign(existing, update);
            }
        }
    }

    /** @type {number[]} */
    const assignedIds = [];
    if (Array.isArray(qrAdds)) {
        current.qrList = current.qrList ?? [];
        for (const add of qrAdds) {
            if (add.id == null) {
                const maxId = current.qrList.reduce((max, qr) => Math.max(max, qr.id ?? 0), 0);
                add.id = maxId + 1;
            }
            assignedIds.push(add.id);
            current.qrList.push(add);
        }
    }

    if (Array.isArray(qrDeletes)) {
        current.qrList = (current.qrList ?? []).filter(qr => !qrDeletes.includes(qr.id));
    }

    if (Array.isArray(qrOrder)) {
        const byId = new Map((current.qrList ?? []).map(qr => [qr.id, qr]));
        const ordered = qrOrder.map(id => byId.get(id)).filter(Boolean);
        const remaining = (current.qrList ?? []).filter(qr => !qrOrder.includes(qr.id));
        current.qrList = [...ordered, ...remaining];
    }

    await writeBundle(request.user.directories, 'quickReplies', name, current);
    return response.send({ ok: true, assignedIds });
});

router.post('/delete', async (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    await deleteBundle(request.user.directories, 'quickReplies', request.body.name);
    return response.sendStatus(200);
});
