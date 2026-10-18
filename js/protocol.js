import { crc16 } from './crc16.js';

/** ROM command identifiers. */
export const CMD = Object.freeze({
  QUERY_RTE: 0x01,
  CONFIG_RTE: 0x02,
  CONFIG_MEMORY: 0x03,
  WRITE_MEMORY: 0x04,
  READ_MEMORY: 0x05,
  LOAD_IMAGE: 0x06,
  ERASE: 0x07,
  RESET: 0x08,
  GENERATE_KEYBLOB: 0x09,
  VERIFY_CHECKSUM: 0x0a,
});

/** Memory identifiers used by the ROM / bootloader. */
export const MEM = Object.freeze({
  ILM: 0x00000,
  DLM: 0x00001,
  XPI0_NOR: 0x10000,
  XPI1_NOR: 0x10001,
  OTP: 0x20000,
  SDXC0: 0x30000,
  SDXC1: 0x30001,
});

export const MAX_PACKAGE_SIZE = 512;
export const LOAD_IMAGE_CHUNK = 508;
export const WRITE_FIRST_CHUNK = 496;
export const WRITE_NEXT_CHUNK = 508;

export function writeU32(target, offset, value) {
  target[offset + 0] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

export function readU32(source, offset) {
  return (
    (source[offset + 0] |
      (source[offset + 1] << 8) |
      (source[offset + 2] << 16) |
      (source[offset + 3] << 24)) >>>
    0
  );
}

function commandHeader(cmd, words, byte2 = 0) {
  return new Uint8Array([cmd & 0xff, words & 0xff, byte2 & 0xff, 0]);
}

export function buildQueryRte(rteId, argument = 0) {
  const hasArgument = rteId === 4;
  const payload = new Uint8Array(hasArgument ? 12 : 8);
  payload.set(commandHeader(CMD.QUERY_RTE, hasArgument ? 2 : 1));
  writeU32(payload, 4, rteId);
  if (hasArgument) {
    writeU32(payload, 8, argument);
  }
  return payload;
}

export function buildConfigRte(speed, options = {}) {
  const words = options.words ?? 3;
  const peripheralMask = options.peripheralMask ?? 1; // UART
  if (words < 1 || words > 6) {
    throw new Error('Invalid RTE parameter word count');
  }
  const payload = new Uint8Array(8 + words * 4);
  payload.set(commandHeader(CMD.CONFIG_RTE, words + 1));
  writeU32(payload, 4, 1); // RTE id 1: active interface parameters
  writeU32(payload, 8, words & 0xff); // general info: parameter word count
  if (words >= 2) writeU32(payload, 12, peripheralMask);
  if (words >= 3) writeU32(payload, 16, speed >>> 0);
  return payload;
}

export function buildConfigMemory(memoryId, address) {
  const payload = new Uint8Array(12);
  // Header observed in rom_client: 03 02 02 00.
  payload.set([0x03, 0x02, 0x02, 0x00]);
  writeU32(payload, 4, memoryId);
  writeU32(payload, 8, address);
  return payload;
}

export function buildWriteMemoryFirst(address, totalLength, memoryId, chunk) {
  const payload = new Uint8Array(16 + chunk.length);
  payload.set(commandHeader(CMD.WRITE_MEMORY, 3));
  writeU32(payload, 4, address);
  writeU32(payload, 8, totalLength);
  writeU32(payload, 12, memoryId);
  payload.set(chunk, 16);
  return payload;
}

export function buildWriteMemoryContinuation(chunk) {
  const payload = new Uint8Array(4 + chunk.length);
  // Header observed from rom_client: cmd=4, words=0, byte2=1, byte3=0.
  payload.set(commandHeader(CMD.WRITE_MEMORY, 0, 1));
  payload.set(chunk, 4);
  return payload;
}

export function buildReadMemory(memoryId, address, length) {
  const payload = new Uint8Array(16);
  payload.set(commandHeader(CMD.READ_MEMORY, 3));
  writeU32(payload, 4, address);
  writeU32(payload, 8, length);
  writeU32(payload, 12, memoryId);
  return payload;
}

export function buildLoadImageChunk(chunk) {
  const payload = new Uint8Array(4 + chunk.length);
  // Header observed from rom_client: cmd=6, words=0, byte2=1, byte3=0.
  payload.set(commandHeader(CMD.LOAD_IMAGE, 0, 1));
  payload.set(chunk, 4);
  return payload;
}

export function buildEraseRegion(memoryId, address, length) {
  const payload = new Uint8Array(20);
  payload.set(commandHeader(CMD.ERASE, 4));
  writeU32(payload, 4, 0); // sub-command 0: erase range
  writeU32(payload, 8, memoryId);
  writeU32(payload, 12, address);
  writeU32(payload, 16, length);
  return payload;
}

export function buildEraseAll(memoryId) {
  const payload = new Uint8Array(12);
  payload.set(commandHeader(CMD.ERASE, 2));
  writeU32(payload, 4, 1); // sub-command 1: erase whole device
  writeU32(payload, 8, memoryId);
  return payload;
}

export function buildReset(resetType = 0) {
  const payload = new Uint8Array(8);
  payload.set(commandHeader(CMD.RESET, 1));
  writeU32(payload, 4, resetType);
  return payload;
}

export function buildVerifyChecksum(address, length, memoryId, sha256) {
  if (sha256.length !== 32) {
    throw new Error('SHA-256 must be 32 bytes');
  }
  const payload = new Uint8Array(56);
  payload.set(commandHeader(CMD.VERIFY_CHECKSUM, 13));
  writeU32(payload, 4, address);
  writeU32(payload, 8, length);
  writeU32(payload, 12, memoryId);
  writeU32(payload, 16, 1); // algorithm / flags observed in rom_client
  writeU32(payload, 20, 32); // digest length
  payload.set(sha256, 24);
  return payload;
}

/** Build a complete UART frame: 5A A5 <len> <payload> <crc16>. */
export function buildSerialFrame(payload) {
  if (payload.length > 0xffff) {
    throw new Error('Serial packet length exceeds 65535');
  }
  const frame = new Uint8Array(4 + payload.length + 2);
  frame[0] = 0x5a;
  frame[1] = 0xa5;
  frame[2] = payload.length & 0xff;
  frame[3] = (payload.length >>> 8) & 0xff;
  frame.set(payload, 4);
  const crc = crc16(frame.subarray(0, 4 + payload.length));
  frame[4 + payload.length] = crc & 0xff;
  frame[5 + payload.length] = (crc >>> 8) & 0xff;
  return frame;
}

/** Build HID report data: A5 <len> <payload>. Report ID is added by WebHID. */
export function buildHidReport(payload) {
  if (payload.length > 0xffff) {
    throw new Error('HID packet length exceeds 65535');
  }
  const report = new Uint8Array(3 + payload.length);
  report[0] = 0xa5;
  report[1] = payload.length & 0xff;
  report[2] = (payload.length >>> 8) & 0xff;
  report.set(payload, 3);
  return report;
}

/** Parse a response payload: [4-byte header][status u32][data...]. */
export function parseResponse(payload) {
  if (payload.length < 8) {
    throw new Error(`Invalid response length: ${payload.length}`);
  }
  const status = readU32(payload, 4);
  return { status, data: payload.slice(8), payload };
}

export function statusMessage(status) {
  const messages = {
    0: 'Success',
    1: 'Command failed',
    2: 'Invalid argument',
    3: 'Out of range',
    4: 'Command timed out',
    1001000: 'Memory command not supported',
    1001001: 'Invalid memory range',
    1001002: 'Memory write failed',
    1001003: 'Memory write verify failed',
    1001004: 'Erase failed',
    1001005: 'Erase verify failed',
    1001006: 'Memory configuration failed',
    1001007: 'Memory read failed',
    1001008: 'Memory read not allowed',
    1001009: 'Memory accessed before configuration',
    1001010: 'Start address is unaligned',
    1001011: 'Invalid memory ID',
    1001013: 'Memory checksum mismatch',
    1001014: 'Memory write not allowed',
    1002000: 'Command not supported',
    1002001: 'Invalid command argument',
    1002002: 'RTE property is read-only',
  };
  return messages[status] || `Unknown status (${status})`;
}
