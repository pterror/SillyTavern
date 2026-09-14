import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Server-side port of the "file-attachment inlining" read path from public/scripts/chats.js's
 * `appendFileContent(message, messageText)` (~line 458-490), which itself calls
 * `getFileAttachment(url)` (~line 260-279) to download each attached file's text.
 *
 * STRUCTURAL DIFFERENCE FROM THE CLIENT (judgment call, not a bug): on the client,
 * `getFileAttachment(url)` does an HTTP `fetch(url)` because attachments are only reachable over
 * HTTP from the browser's perspective. On the server, that HTTP round-trip would just be the
 * server calling back into itself - `src/users.js` (~line 1217) confirms `/user/files/*` is a
 * plain static-file route serving directly from `req.user.directories.files`
 * (`router.use('/user/files/*', createRouteHandler(req => req.user.directories.files))`), and
 * `src/endpoints/files.js`'s `/upload` handler confirms the URL shape: it writes to
 * `path.join(directories.files, name)` and returns `clientRelativePath(directories.root,
 * pathToUpload)`, which (since `directories.root` and `directories.files` are both
 * `path.join(DATA_ROOT, handle, <template>)`, with the `files` template segment being
 * `'user/files'` per `src/constants.js`'s `USER_DIRECTORY_TEMPLATE`) yields a URL of the exact
 * shape `/user/files/<filename>`. So `readFileAttachment()` below reads the file directly off
 * disk via `directories.files` instead of making an HTTP call - it takes only the URL's trailing
 * path component (`path.basename`) and joins it onto `directories.files`, then verifies the
 * resolved path still lies inside `directories.files` (the same defense-in-depth check
 * `src/endpoints/files.js`'s `/delete` and `/verify` handlers already use) before reading, so a
 * crafted `../../` URL can't escape the files directory.
 *
 * DELIBERATE OMISSION (judgment call, not a missing feature): the client's `appendFileContent`
 * bakes a WRITE into an otherwise-pure text-derivation function - it deletes `extra.fileLength`
 * if present, recomputes it from the resolved merged file text, and then `commit()`s that
 * recomputed field back into the chat message store (via `updateIn`/`chatOpEdit`/
 * `saveChatConditional` - a real database/settings write), every single time the function runs,
 * including during pure prompt-assembly reads. This is itself an instance of the exact "a read
 * action should never write" anti-pattern this porting effort has been fixing elsewhere (e.g.
 * `stats.js`'s `characterStatsHandler`). For a pure `assembleTextCompletionPrompt()` prompt-
 * assembly path, reproducing that write-on-read side effect would be actively wrong, not merely
 * out of scope - so `appendFileAttachments()` below does NOT write `fileLength` (or anything
 * else) back anywhere. It only resolves and returns text.
 *
 * ERROR HANDLING (judgment call): the client's `getFileAttachment` catches a failed fetch, shows
 * a toast, and returns `undefined` for that one file - the caller (`appendFileContent`) then just
 * skips that file's text (via `if (fileText) fileTexts.push(fileText)`) rather than aborting the
 * whole message. `readFileAttachment()` below mirrors that: a missing/unreadable file is
 * `console.error`'d (no toast mechanism exists server-side, and there's no other user-facing
 * surface to report it to from inside a pure prompt-assembly function) and resolves to
 * `undefined`, letting the caller move on to the other files instead of throwing.
 */

/**
 * @typedef {object} FileAttachmentEntry Shape used by this module. Mirrors the subset of the
 * client's `extra.files[]` entries (see public/scripts/chats.js) that this module cares about.
 * @property {string} [text] Already-resolved file text, if present - used verbatim, no disk read.
 * @property {string} [url] Attachment URL, e.g. `/user/files/<filename>` - triggers a real
 *   filesystem read via `readFileAttachment()` when `text` isn't already set.
 */

/**
 * @typedef {object} FileAttachmentDirectories Minimal directories shape this module needs.
 * @property {string} files Absolute path to the user's `user/files` directory
 *   (`req.user.directories.files` server-side).
 */

/**
 * Reads one file attachment's text directly off disk, given its client-facing `url`
 * (e.g. `/user/files/1234_abcd.txt`). Real filesystem read, no HTTP call - see the module doc
 * comment above for why that's the correct server-side equivalent of the client's
 * `getFileAttachment()` (which downloads over HTTP because that's the only way the client can
 * reach it).
 * @param {string} url The attachment's client-facing URL.
 * @param {{directories?: FileAttachmentDirectories}} [options]
 * @returns {Promise<string|undefined>} The file's text, or `undefined` if the URL is falsy, the
 *   file can't be resolved safely inside `directories.files`, or the read fails (logged via
 *   `console.error`, matching the client's catch-and-report-but-don't-throw behavior minus the
 *   toast - see the module doc comment's ERROR HANDLING note).
 */
export async function readFileAttachment(url, { directories } = {}) {
    if (!url || !directories?.files) {
        return undefined;
    }
    try {
        // Only the trailing path component of the URL is trusted (matches the real
        // `/user/files/<filename>` shape this module's doc comment derives) - then the resolved
        // path is re-checked to still be inside directories.files, the same defense-in-depth
        // pattern src/endpoints/files.js's /delete and /verify handlers use, so a crafted `../`
        // segment in `url` can't escape the files directory.
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
 * Server-side, WRITE-FREE port of `appendFileContent(message, messageText)`
 * (public/scripts/chats.js ~458-490): resolves every entry in `extra.files` (using `.text`
 * verbatim when present, otherwise a real `readFileAttachment()` disk read of `.url`), and
 * prepends the resolved, `\n\n`-joined file texts onto `messageText`.
 *
 * Preserves the client's exact join/suffix logic, including its non-obvious edge case: the
 * client only ever pushes a file's text into `fileTexts` when it's truthy
 * (`if (fileText) fileTexts.push(fileText)`), so `fileTexts.join('\n\n') + '\n\n'` is computed
 * ONLY inside the `extra.files.length > 0` guard - meaning if `extra.files` is non-empty but
 * EVERY individual file's resolved text turns out empty/falsy (all missing/unreadable/blank),
 * `fileTexts` ends up `[]`, and `mergedFileTexts` becomes just `'\n\n'` (an empty join plus the
 * unconditional suffix) - which is still prepended onto `messageText`. This is traced exactly
 * from the client, not guessed: the `extra.files.length > 0` guard only gates whether the
 * files-array branch runs at all: it does NOT guarantee any individual file resolved to
 * non-empty text, so an all-empty-texts non-empty-array case DOES still result in a leading
 * `'\n\n'` being prepended. This function reproduces that byte-for-byte, per this task's
 * "preserve it exactly" instruction.
 *
 * Does NOT write `extra.fileLength` (or anything else) back anywhere - see the module doc
 * comment's DELIBERATE OMISSION note for why that write-on-read side effect is intentionally
 * dropped here.
 * @param {{files?: FileAttachmentEntry[]}|null|undefined} extra Message's `extra` object (or a
 *   subset of it) - only `.files` is read.
 * @param {string} messageText The message's already-regexed text (this runs AFTER regex, matching
 *   public/script.js's real Generate() ordering).
 * @param {{directories?: FileAttachmentDirectories}} [options]
 * @returns {Promise<string>} `messageText`, prefixed with the joined file-attachment texts when
 *   `extra.files` is a non-empty array; unchanged otherwise.
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
