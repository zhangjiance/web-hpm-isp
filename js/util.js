export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class TransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransportError';
  }
}

export class RomError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'RomError';
    this.status = status;
  }
}

export class AbortError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hex(value, width = 0) {
  const text = Number(value >>> 0).toString(16).toUpperCase();
  return width > 0 ? text.padStart(width, '0') : text;
}

export function hex0x(value, width = 0) {
  return `0x${hex(value, width)}`;
}

export function bytesHex(data, maxBytes = 64) {
  const count = Math.min(data.length, maxBytes);
  let text = '';
  for (let i = 0; i < count; i++) {
    if (i > 0) text += ' ';
    text += hex(data[i], 2);
  }
  if (data.length > count) text += ` ... (${data.length}B)`;
  return text;
}

export function parseNumber(text) {
  if (typeof text === 'number') {
    if (!Number.isFinite(text) || text < 0) throw new Error('Invalid number');
    return Math.trunc(text);
  }
  const trimmed = String(text).trim();
  if (!trimmed) throw new Error('Number is empty');
  let value;
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    value = Number.parseInt(trimmed.slice(2), 16);
  } else if (/^[0-9]+$/.test(trimmed)) {
    value = Number.parseInt(trimmed, 10);
  } else {
    throw new Error(`Cannot parse number: ${text}`);
  }
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid number: ${text}`);
  return value;
}

export function parseU32(text) {
  const value = parseNumber(text);
  if (value > 0xffffffff) throw new Error(`Number exceeds 32 bits: ${text}`);
  return value >>> 0;
}

export function parseWordList(text) {
  const parts = String(text)
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('Configuration words are empty');
  return parts.map(parseU32);
}

export function wordsToBytes(words) {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word >>> 0, true));
  return bytes;
}

export function bytesToWords(bytes) {
  if (bytes.length % 4 !== 0) throw new Error('Byte count is not a multiple of 4');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = [];
  for (let offset = 0; offset < bytes.length; offset += 4) {
    words.push(view.getUint32(offset, true));
  }
  return words;
}

export function formatBytesCount(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

export function isSecureContextOk() {
  return typeof window !== 'undefined' && window.isSecureContext;
}
