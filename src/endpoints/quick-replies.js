import fs from 'node:fs';

import express from 'express';

import { bundleFilePath, deleteBundleFile, writeBundleFile } from '../bundle-files.js';

export const router = express.Router();

router.post('/save', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    return response.sendStatus(writeBundleFile(request.user.directories, 'quickReplies', request.body.name, request.body) ? 200 : 400);
});

router.post('/save-partial', (request, response) => {
    const { name, setProps, qrUpdates, qrDeletes, qrAdds, qrOrder } = request.body ?? {};
    if (!name) {
        return response.sendStatus(400);
    }

    const filename = bundleFilePath(request.user.directories, 'quickReplies', name);
    if (!filename) {
        return response.sendStatus(400);
    }

    // Read current state (synchronous read-modify-write, same concurrency model as settings/save-partial)
    let current = {};
    if (fs.existsSync(filename)) {
        try {
            current = JSON.parse(fs.readFileSync(filename, 'utf8'));
        } catch {
            return response.status(500).send({ error: 'Current QR set file is not valid JSON.' });
        }
    }

    // 1. Merge set-level properties (shallow, never touches qrList/name)
    if (setProps && typeof setProps === 'object' && !Array.isArray(setProps)) {
        const safeProps = { ...setProps };
        delete safeProps.qrList;
        delete safeProps.name;
        Object.assign(current, safeProps);
    }

    // 2. Update existing QR entries by stable id (shallow merge per entry)
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

    // 3. Append new QR entries, minting an id for any entry that doesn't already have one
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

    // 4. Remove QR entries by stable id
    if (Array.isArray(qrDeletes)) {
        current.qrList = (current.qrList ?? []).filter(qr => !qrDeletes.includes(qr.id));
    }

    // 5. Reorder QR entries by stable id list (entries not in the list are appended at the end)
    if (Array.isArray(qrOrder)) {
        const byId = new Map((current.qrList ?? []).map(qr => [qr.id, qr]));
        const ordered = qrOrder.map(id => byId.get(id)).filter(Boolean);
        const remaining = (current.qrList ?? []).filter(qr => !qrOrder.includes(qr.id));
        current.qrList = [...ordered, ...remaining];
    }

    writeBundleFile(request.user.directories, 'quickReplies', name, current);
    return response.send({ ok: true, assignedIds });
});

router.post('/delete', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    deleteBundleFile(request.user.directories, 'quickReplies', request.body.name);
    return response.sendStatus(200);
});
