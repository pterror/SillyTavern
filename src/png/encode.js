import crc32pkg from 'crc-32';

/**
 * Encodes PNG chunks into a PNG file format buffer.
 * @param {Array<{ name: string; data: Uint8Array }>} chunks Array of PNG chunks
 * @returns {Uint8Array} Encoded PNG data
 * @copyright Based on https://github.com/hughsk/png-chunks-encode (MIT)
 */
export default function encode(chunks) {
    const uint8 = new Uint8Array(4);
    const int32 = new Int32Array(uint8.buffer);
    const uint32 = new Uint32Array(uint8.buffer);

    let totalSize = 8;
    let idx = totalSize;

    for (let i = 0; i < chunks.length; i++) {
        totalSize += chunks[i].data.length;
        totalSize += 12;
    }

    const output = new Uint8Array(totalSize);

    output[0] = 0x89;
    output[1] = 0x50;
    output[2] = 0x4E;
    output[3] = 0x47;
    output[4] = 0x0D;
    output[5] = 0x0A;
    output[6] = 0x1A;
    output[7] = 0x0A;

    for (let i = 0; i < chunks.length; i++) {
        const { name, data } = chunks[i];
        const size = data.length;
        const nameChars = [
            name.charCodeAt(0),
            name.charCodeAt(1),
            name.charCodeAt(2),
            name.charCodeAt(3),
        ];

        uint32[0] = size;
        output[idx++] = uint8[3];
        output[idx++] = uint8[2];
        output[idx++] = uint8[1];
        output[idx++] = uint8[0];

        output[idx++] = nameChars[0];
        output[idx++] = nameChars[1];
        output[idx++] = nameChars[2];
        output[idx++] = nameChars[3];

        // Bulk copy via TypedArray.set() (a native memcpy) instead of a byte-at-a-time JS loop - same
        // output, but for a multi-MB chunk (e.g. IDAT) the per-byte loop was measured as a real,
        // significant contributor to writeCardToFile()'s per-file cost on a real corpus (2026-08
        // local-import perf investigation) - copying byte-by-byte in JS pays per-iteration interpreter/JIT
        // overhead that .set() skips entirely.
        output.set(data, idx);
        idx += size;

        // crc-32 (not the 'crc' package) - same PNG-compatible CRC-32/IEEE polynomial (verified against
        // the standard 0xcbf43926 test vector), but ~4x faster in real benchmarks against this exact
        // buffer size (2026-08 local-import perf investigation) and already a transitive dependency via
        // the patched png-chunks-extract fork's own chunk-CRC verification, so this trades zero new
        // dependency surface for a real per-file win on the now-CPU-bound encode() path.
        const crc = crc32pkg.buf(data, crc32pkg.buf(new Uint8Array(nameChars), 0));

        int32[0] = crc;
        output[idx++] = uint8[3];
        output[idx++] = uint8[2];
        output[idx++] = uint8[1];
        output[idx++] = uint8[0];
    }

    return output;
}
