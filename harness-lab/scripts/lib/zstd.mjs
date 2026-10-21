/**
 * Concatenated-frame Zstandard decoding for session logs.
 *
 * DSH appends one frame per durable batch, so a session file is a container of
 * independent frames. Node's one-shot `zstdDecompressSync` decodes only the
 * first, and its stream stops at the first frame end, so the frame boundaries
 * are found from the container structure and each frame is decoded alone.
 *
 * The scanner mirrors `dsh-session-persistence-jsonl`'s format: a complete frame
 * is magic + descriptor + optional fields + blocks (+ checksum). A file that
 * ends mid-frame (a live session) keeps its complete frames.
 *
 * @see https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md
 */
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

export function scanFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }

    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** Decode every complete frame; a torn tail is reported, not treated as failure. */
export function decompressSessionLog(buffer) {
  const { frames, tornStart } = scanFrames(buffer)
  const parts = []
  for (const { start, end } of frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch (error) {
      throw new Error(`corrupt Zstandard frame at byte ${start}: ${error.message}`)
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), torn: tornStart !== undefined, frames: frames.length }
}
