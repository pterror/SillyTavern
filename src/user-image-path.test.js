import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userImageFile, userImageUrl } from './user-image-path.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-user-image-path-'));
const directories = /** @type {any} */ ({ root, userImages: path.join(root, 'user/images') });
fs.mkdirSync(directories.userImages, { recursive: true });
try {
    for (const name of ['#?.png', '%23.png', 'raw%bad.png', 'a b ü.png']) {
        const relative = `/user/images/${name}`;
        const file = path.join(directories.userImages, name);
        fs.writeFileSync(file, 'image');
        assert.equal(userImageFile(directories, userImageUrl(relative)), file);
    }
    const legacy = '/user/images/legacy%23.png';
    fs.writeFileSync(path.join(root, legacy), 'legacy');
    assert.equal(userImageFile(directories, legacy), path.join(root, legacy));
    for (const bad of ['/user/images/../../../outside', '/user/images/%2e%2e/%2e%2e/outside', '/user/images/%2e%2e%2f%2e%2e%2foutside', '/user/avatars/image.png']) {
        assert.equal(userImageFile(directories, bad), null);
    }
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
