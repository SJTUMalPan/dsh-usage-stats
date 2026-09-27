/**
 * Multi-frame zstd reader for DSH session logs.
 *
 * DSH appends one zstd frame per event, so a session log is a *concatenation*
 * of independent frames. Node's `zlib.zstdDecompressSync` (and its stream
 * form) stop after the first frame, which silently truncates the log to a
 * single event. This module walks the zstd frame structure to find frame
 * boundaries, then decompresses each frame on its own.
 *
 * Only the frame *container* is parsed here; block payloads are handed to the
 * platform decompressor. That keeps the implementation small and avoids
 * reimplementing entropy decoding.
 *
 * @module dsh-usage-stats/zstd
 */

import { zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xfd2fb528 // little-endian bytes 28 B5 2F FD

/** Dictionary_ID field width in bytes, indexed by the descriptor's 2-bit flag. */
const DICT_ID_SIZE = [0, 1, 2, 4]

/**
 * Measure one zstd frame starting at `offset`.
 *
 * Walks the frame header and the block sequence using the sizes the format
 * declares, so no heuristic scanning for magic bytes is needed (magic bytes
 * can legitimately appear inside compressed payloads).
 *
 * @param {Buffer} buf - Buffer holding at least one complete frame at `offset`.
 * @param {number} offset - Byte offset of the frame's magic number.
 * @returns {number} Total frame size in bytes.
 * @throws {Error} When the magic number is absent or a block header is reserved.
 */
export function frameSize(buf, offset) {
  if (buf.readUInt32LE(offset) !== MAGIC) {
    throw new Error(`no zstd frame magic at offset ${offset}`)
  }
  let p = offset + 4
  const descriptor = buf.readUInt8(p)
  p += 1

  const fcsFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  const dictIdFlag = descriptor & 3

  if (!singleSegment) p += 1 // Window_Descriptor
  p += DICT_ID_SIZE[dictIdFlag]
  // Frame_Content_Size: flag 0 means 1 byte only in single-segment frames.
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag

  for (;;) {
    const header = buf.readUIntLE(p, 3)
    p += 3
    const lastBlock = header & 1
    const blockType = (header >> 1) & 3
    const blockSize = header >> 3
    if (blockType === 3) throw new Error(`reserved zstd block type at ${p - 3}`)
    // An RLE block stores its payload as a single repeated byte.
    p += blockType === 1 ? 1 : blockSize
    if (lastBlock) break
  }

  if (checksum) p += 4
  return p - offset
}

/**
 * Decompress a concatenation of zstd frames.
 *
 * @param {Buffer} buf - Raw file contents.
 * @returns {Buffer} Concatenated decompressed payload of every frame.
 */
/** 单次读取允许解压出的上限（默认 512 MB）。 */
export const DEFAULT_MAX_OUTPUT = 512 * 1024 * 1024

export function decompressAll(buf, { maxOutput = DEFAULT_MAX_OUTPUT } = {}) {
  const parts = []
  let offset = 0
  let total = 0
  while (offset < buf.length) {
    const size = frameSize(buf, offset)
    const part = zstdDecompressSync(buf.subarray(offset, offset + size))
    total += part.length
    // 上限防护：会话日志本机生成、通常几 MB；压缩率极高的构造帧可以把内存打满
    // （"解压炸弹"）。超限直接报错，而不是让进程 OOM —— 调用方会把该会话标为读取失败。
    if (total > maxOutput) {
      throw new Error(
        `decompressed size exceeds the ${Math.round(maxOutput / (1024 * 1024))} MB cap; refusing to continue`,
      )
    }
    parts.push(part)
    offset += size
  }
  return Buffer.concat(parts)
}

/**
 * Read a DSH session log into event records.
 *
 * A line that fails to parse is skipped rather than failing the whole read:
 * a torn trailing frame should not hide the rest of a session's history.
 *
 * @param {string} file - Absolute path to `session.v3.jsonl.zstd`.
 * @param {{ readFileSync: (p: string) => Buffer }} fsLike - Injectable reader.
 * @returns {object[]} Parsed event objects, in log order.
 */
export function readSessionEvents(file, fsLike) {
  const text = decompressAll(fsLike.readFileSync(file)).toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // Ignore a malformed line; the fold below tolerates missing events.
    }
  }
  return events
}
