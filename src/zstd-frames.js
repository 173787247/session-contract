import { constants, zstdDecompressSync } from "node:zlib";

/** Zstandard magic 28 B5 2F FD as Uint32LE. */
const ZSTD_MAGIC = 4247762216;

/**
 * Locate complete concatenated Zstandard frames (dsh JSONL persistence layout).
 * @param {Buffer} buffer
 * @returns {{ frames: { start: number, end: number }[], tornStart?: number }}
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid zstd frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`reserved zstd frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * Decompress a dsh `.jsonl.zstd` artifact: concatenated frames, optional torn tail.
 * @param {Buffer} buf
 */
export function decompressDshZstd(buf) {
  const { frames, tornStart } = scanZstdFrames(buf);
  const parts = [];
  for (const { start, end } of frames) {
    parts.push(zstdDecompressSync(buf.subarray(start, end)));
  }
  if (tornStart !== undefined && tornStart < buf.length) {
    try {
      parts.push(
        zstdDecompressSync(buf.subarray(tornStart), {
          finishFlush: constants.ZSTD_e_flush,
        }),
      );
    } catch {
      // incomplete final frame: keep complete frames only
    }
  }
  if (parts.length === 0) {
    return zstdDecompressSync(buf);
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}
