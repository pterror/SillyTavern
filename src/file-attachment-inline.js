import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {object} FileAttachmentEntry
 * @property {string} [text]
 * @property {string} [url]
 */

/**
 * @typedef {object} FileAttachmentDirectories
 * @property {string} files
 */

/**
 * @param {string} url
 * @param {{directories?: FileAttachmentDirectories}} [options]
 * @returns {Promise<string|undefined>}
 */
export async function readFileAttachment(url, { directories } = {}) {
    if (!url || !directories?.files) {
        return undefined;
    }
    try {
        const fileName = path.basename(url);
        const resolvedFilesDir = path.resolve(directories.files);
        const filePath = path.resolve(resolvedFilesDir, fileName);
        if (filePath !== resolvedFilesDir && !filePath.startsWith(resolvedFilesDir + path.sep)) {
            console.error(`Could not read file attachment: resolved path escapes files directory (url=${url})`);
            return undefined;
        }
        return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
        console.error('Could not read file attachment', error);
        return undefined;
    }
}

/**
 * @param {{files?: FileAttachmentEntry[]}|null|undefined} extra
 * @param {string} messageText
 * @param {{directories?: FileAttachmentDirectories}} [options]
 * @returns {Promise<string>}
 */
export async function appendFileAttachments(extra, messageText, { directories } = {}) {
    if (!extra || typeof extra !== 'object' || !Array.isArray(extra.files) || extra.files.length === 0) {
        return messageText;
    }

    const fileTexts = [];
    for (const file of extra.files) {
        const fileText = file?.text || (await readFileAttachment(file?.url, { directories }));
        if (fileText) {
            fileTexts.push(fileText);
        }
    }
    const mergedFileTexts = fileTexts.join('\n\n') + '\n\n';
    return mergedFileTexts + messageText;
}
