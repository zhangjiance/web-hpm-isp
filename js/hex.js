/**
 * Intel HEX parser.
 *
 * Adapted from blackmagic-utils/parsers/hex-parser.js. Data records are sorted
 * by address and merged into contiguous segments. Small gaps (up to 256 bytes)
 * are filled with 0xFF, matching the erased state of NOR flash; larger gaps
 * start a new segment so sparse images stay sparse.
 */

/** Fill gaps up to this many bytes with 0xFF instead of splitting segments. */
const MAX_GAP_TO_FILL = 256;

function parseHexByte(text, lineNo) {
  const value = Number.parseInt(text, 16);
  if (Number.isNaN(value) || value < 0 || value > 0xff) {
    throw new Error(`HEX parse error at line ${lineNo}: invalid byte '${text}'`);
  }
  return value;
}

/**
 * Parse Intel HEX text into write segments.
 *
 * @param {string} text
 * @returns {{ address: number, data: Uint8Array }[]}
 */
export function parseHex(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error('HEX file is empty');
  }

  let upper = 0;
  const records = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    if (!line.startsWith(':')) {
      throw new Error(`HEX parse error at line ${lineNo}: missing ':'`);
    }

    const payload = line.slice(1);
    if (payload.length < 10 || payload.length % 2 !== 0) {
      throw new Error(`HEX parse error at line ${lineNo}: malformed record`);
    }

    const record = [];
    for (let p = 0; p < payload.length; p += 2) {
      record.push(parseHexByte(payload.slice(p, p + 2), lineNo));
    }

    const count = record[0];
    const addr = (record[1] << 8) | record[2];
    const type = record[3];
    const data = record.slice(4, 4 + count);
    const checksum = record[4 + count];

    if (record.length !== count + 5) {
      throw new Error(`HEX parse error at line ${lineNo}: byte count mismatch`);
    }

    const sum = record.slice(0, record.length - 1).reduce((a, b) => (a + b) & 0xff, 0);
    const expected = (~sum + 1) & 0xff;
    if (expected !== checksum) {
      throw new Error(`HEX parse error at line ${lineNo}: checksum mismatch`);
    }

    if (type === 0x00) {
      if (data.length > 0) {
        records.push({ address: (upper + addr) >>> 0, data });
      }
    } else if (type === 0x01) {
      break;
    } else if (type === 0x02) {
      if (data.length !== 2) {
        throw new Error(`HEX parse error at line ${lineNo}: invalid type 02 record`);
      }
      upper = (((data[0] << 8) | data[1]) << 4) >>> 0;
    } else if (type === 0x04) {
      if (data.length !== 2) {
        throw new Error(`HEX parse error at line ${lineNo}: invalid type 04 record`);
      }
      upper = (((data[0] << 8) | data[1]) << 16) >>> 0;
    }
    // Type 03/05 (start address) records carry no data; ignore them.
  }

  if (records.length === 0) {
    throw new Error('HEX file does not contain data records');
  }

  records.sort((a, b) => a.address - b.address);

  const segments = [];
  let base = records[0].address;
  let chunk = Array.from(records[0].data);

  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    const chunkEnd = base + chunk.length;
    const gap = record.address - chunkEnd;

    if (gap > 0) {
      if (gap <= MAX_GAP_TO_FILL) {
        for (let j = 0; j < gap; j++) {
          chunk.push(0xff);
        }
        for (let j = 0; j < record.data.length; j++) {
          chunk.push(record.data[j]);
        }
      } else {
        segments.push({ address: base >>> 0, data: Uint8Array.from(chunk) });
        base = record.address;
        chunk = Array.from(record.data);
      }
      continue;
    }

    // Contiguous or overlapping record: merge it into the current chunk.
    // Later records win for overlapping bytes, matching the previous
    // address-map implementation.
    const offset = record.address - base;
    const end = offset + record.data.length;
    if (end > chunk.length) {
      while (chunk.length < end) chunk.push(0xff);
    }
    for (let j = 0; j < record.data.length; j++) {
      chunk[offset + j] = record.data[j];
    }
  }

  segments.push({ address: base >>> 0, data: Uint8Array.from(chunk) });
  return segments;
}
