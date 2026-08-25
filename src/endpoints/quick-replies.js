import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

export const router = express.Router();

router.post('/save', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    const filename = path.join(request.user.directories.quickreplies, sanitize(`${request.body.name}.json`));
    writeFileAtomicSync(filename, JSON.stringify(request.body, null, 4), 'utf8');

    return response.sendStatus(200);
});

router.post('/save-partial', (request, response) => {
    const { name, setProps, qrUpdates, qrDeletes, qrAdds, qrOrder } = request.body ?? {};
    if (!name) {
        return response.sendStatus(400);
    }

    const filename = path.join(request.user.directories.quickreplies, sanitize(`${name}.json`));

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
        const { qrList: _ql, name: _n, ...safeProps } = setProps;
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

    // 3. Append new QR entries
    if (Array.isArray(qrAdds)) {
        current.qrList = current.qrList ?? [];
        current.qrList.push(...qrAdds);
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

    writeFileAtomicSync(filename, JSON.stringify(current, null, 4), 'utf8');
    return response.sendStatus(200);
});

router.post('/delete', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    const filename = path.join(request.user.directories.quickreplies, sanitize(`${request.body.name}.json`));
    if (fs.existsSync(filename)) {
        fs.unlinkSync(filename);
    }

    return response.sendStatus(200);
});
