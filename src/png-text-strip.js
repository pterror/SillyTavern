import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks holding text: a card's (`chara`, `ccv3`) and any other. */
const TEXT_CHUNKS = new Set(['tEXt', 'iTXt', 'zTXt']);

/**
 * A PNG passed through without its text chunks, read as it streams: a chunk's 8-byte header decides whether its bytes
 * (data and CRC) go on or are dropped, so nothing is held but a header at a time. Anything that isn't a PNG passes
 * through as it is.
 * @returns {Transform}
 */
export function stripPngText() {
    /** Bytes not yet decided: the signature, or a chunk header. */
    let held = Buffer.alloc(0);
    let signatureChecked = false;
    let isPng = true;
    /** The rest of the current chunk: passed on, or dropped. */
    let remaining = 0;
    let dropping = false;

    return new Transform({
        transform(chunk, _encoding, done) {
            let input = held.length ? Buffer.concat([held, chunk]) : chunk;
            held = Buffer.alloc(0);
            /** @type {Buffer[]} */
            const out = [];
            if (!signatureChecked) {
                if (input.length < SIGNATURE.length) {
                    held = input;
                    return done();
                }
                signatureChecked = true;
                isPng = input.subarray(0, SIGNATURE.length).equals(SIGNATURE);
                if (!isPng) return done(null, input);
                out.push(input.subarray(0, SIGNATURE.length));
                input = input.subarray(SIGNATURE.length);
            }
            if (!isPng) return done(null, input);
            while (input.length) {
                if (remaining > 0) {
                    const take = Math.min(remaining, input.length);
                    if (!dropping) out.push(input.subarray(0, take));
                    remaining -= take;
                    input = input.subarray(take);
                    continue;
                }
                if (input.length < 8) {
                    held = Buffer.from(input);
                    break;
                }
                const length = input.readUInt32BE(0);
                const type = input.toString('latin1', 4, 8);
                dropping = TEXT_CHUNKS.has(type);
                if (!dropping) out.push(input.subarray(0, 8));
                // The data and its 4-byte CRC.
                remaining = length + 4;
                input = input.subarray(8);
            }
            done(null, out.length ? Buffer.concat(out) : undefined);
        },
        flush(done) {
            // A truncated file: what was held goes on as it is.
            done(null, held.length ? held : undefined);
        },
    });
}

/**
 * A character's image without its text chunks (the card it may still hold as imported is never sent: the store is
 * the card, character-avatars.js), streamed; answered 304 when the page's copy is current.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} file
 */
export async function sendPngWithoutText(req, res, file) {
    const stat = await fs.promises.stat(file);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('ETag', `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`);
    if (req.fresh) return res.sendStatus(304);
    if (req.method === 'HEAD') return res.end();
    await pipeline(fs.createReadStream(file), stripPngText(), res).catch(() => {
        // The page went away mid-image, or the file did: nothing to answer any more.
    });
}
