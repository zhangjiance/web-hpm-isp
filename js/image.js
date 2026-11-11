import { parseWordList, wordsToBytes } from './util.js';
import { readU32 } from './protocol.js';
import { parseHex } from './hex.js';

/** Tags 0xFCF90001 / 0xFCF90002 / ... share the high 16 bits. */
export const CONFIG_TAG_MASK = 0xffff0000;
export const CONFIG_TAG_HIGH = 0xfcf90000;

/** The .nor_cfg_option section is placed at FLASH + 0x400 by the HPM SDK. */
export const FLASH_CONFIG_ADDRESS = 0x80000400;

/** In the SDK linker layout the boot header is 0xC00 bytes after the config block. */
export const BOOT_HEADER_DELTA = 0xc00;

/** Boot header starts with byte 0xBF, version 0x10; first 16 bits are 0x10BF. */
export const BOOT_HEADER_TAG_LOW = 0x10bf;

export const DEFAULT_FLASH_ADDRESS = 0x80000400;
export const DEFAULT_FLASH_CONFIG = '0xfcf90001, 0x5, 0x0, 0x0';

/** Offsets the manufacturing tool checks for config / boot-header markers. */
const SCAN_OFFSETS = [0x0000, 0x0400, 0x0800, 0x0c00, 0x1000, 0x1400, 0x1800, 0x1c00, 0x2000];

export function isConfigTag(tag) {
  return ((tag & CONFIG_TAG_MASK) >>> 0) === CONFIG_TAG_HIGH;
}

/**
 * Read a 0xFCF9xxxx configuration block at a known offset.
 *
 * The low 16 bits of the tag (the "word number" in the manufacturing tool)
 * indicate how many extra 32-bit words follow the tag. The tool always pads
 * the result to 4 words, so we do the same.
 */
function readConfigAt(data, offset) {
  if (!data || offset < 0 || offset + 4 > data.length) return null;
  const tag = readU32(data, offset);
  if (!isConfigTag(tag)) return null;
  const wordCount = tag & 0xffff;
  const words = [];
  const count = Math.min(1 + wordCount, 16);
  for (let index = 0; index < count; index++) {
    const wordOffset = offset + index * 4;
    if (wordOffset + 4 > data.length) break;
    words.push(readU32(data, wordOffset));
  }
  while (words.length < 4) words.push(0);
  return {
    offset,
    tag,
    wordCount,
    words: words.slice(0, 4),
  };
}

/**
 * Detect a 0xFCF9xxxx configuration block near the start of an image.
 */
export function findConfigBlock(data) {
  if (!data || data.length < 4) return null;
  for (const offset of SCAN_OFFSETS) {
    if (offset + 4 > data.length) break;
    const config = readConfigAt(data, offset);
    if (config) return config;
  }
  return null;
}

/**
 * Detect and parse an HPM boot header (boot_header_t from hpm_bootheader.h).
 *
 * Layout:
 *   0x00: tag=0xBF, version, length
 *   0x04: flags
 *   0x08: sw_version, fuse_version, fw_count
 *   0x0C: dc_block_offset, sig_block_offset
 *   0x10: fw_info_table_t[fw_count], each 0x80 bytes
 */
export function findBootHeader(data, configOffset = null) {
  if (!data || data.length < 0x20) return null;

  const candidates = [];
  if (configOffset !== null) candidates.push(configOffset + BOOT_HEADER_DELTA);
  candidates.push(...SCAN_OFFSETS);
  const seen = new Set();

  for (const offset of candidates) {
    if (!Number.isFinite(offset) || offset < 0 || offset + 0x20 > data.length) continue;
    if (seen.has(offset)) continue;
    seen.add(offset);
    if (data[offset] !== 0xbf || (readU32(data, offset) & 0xffff) !== BOOT_HEADER_TAG_LOW) {
      continue;
    }

    const version = data[offset + 1];
    const length = data[offset + 2] | (data[offset + 3] << 8);
    const flags = readU32(data, offset + 4);
    const swVersion = data[offset + 8] | (data[offset + 9] << 8);
    const fuseVersion = data[offset + 0x0a];
    const fwCount = data[offset + 0x0b];
    const dcBlockOffset = data[offset + 0x0c] | (data[offset + 0x0d] << 8);
    const sigBlockOffset = data[offset + 0x0e] | (data[offset + 0x0f] << 8);

    const fwInfo = [];
    const maxFw = Math.min(fwCount, 2);
    for (let index = 0; index < maxFw; index++) {
      const base = offset + 0x10 + index * 0x80;
      if (base + 0x20 > data.length) break;
      fwInfo.push({
        offset: readU32(data, base + 0x00),
        size: readU32(data, base + 0x04),
        flags: readU32(data, base + 0x08),
        loadAddress: readU32(data, base + 0x10),
        entryPoint: readU32(data, base + 0x18),
      });
    }

    return {
      offset,
      version,
      length,
      flags,
      swVersion,
      fuseVersion,
      fwCount,
      dcBlockOffset,
      sigBlockOffset,
      fwInfo,
    };
  }
  return null;
}

/**
 * Determine the image layout.
 *
 * The file is written as-is at `baseAddress`. It normally starts with the
 * .nor_cfg_option block (0x80000400 in the HPM SDK linker layout). If the file
 * includes the preceding 0x400-byte padding, the config block is found at
 * 0x400 and the base becomes 0x80000000.
 */
export function detectImageLayout(data) {
  const config = findConfigBlock(data);
  const configOffset = config ? config.offset : null;
  const bootHeader = findBootHeader(data, configOffset);

  let baseAddress = null;
  let appOffset = null;
  let appLoadAddress = null;
  let appSize = null;

  if (bootHeader && bootHeader.fwInfo.length > 0) {
    const firmware = bootHeader.fwInfo[0];
    appOffset = bootHeader.offset + firmware.offset;
    appLoadAddress = firmware.loadAddress;
    appSize = firmware.size;
    if (appLoadAddress >= appOffset) {
      const computed = (appLoadAddress - appOffset) >>> 0;
      // Only trust a plausible XPI0/XPI1 mapping.
      if (computed >= 0x80000000 && computed < 0x90000000) {
        baseAddress = computed;
      }
    }
  }

  if (baseAddress === null && configOffset !== null) {
    baseAddress = (FLASH_CONFIG_ADDRESS - configOffset) >>> 0;
  }

  return {
    config,
    bootHeader,
    configOffset,
    baseAddress,
    appOffset,
    appLoadAddress,
    appSize,
  };
}

/** Intel HEX files carry their own load addresses. */
export function isHexFileName(name) {
  return /\.(hex|ihex|ihx)$/i.test(String(name || ''));
}

/**
 * Find the 0xFCF9xxxx configuration block inside parsed HEX segments.
 *
 * Prefer the SDK's standard config address when a segment covers it; otherwise
 * scan the start of each segment.
 */
function findConfigInSegments(segments) {
  for (const segment of segments) {
    const relative = FLASH_CONFIG_ADDRESS - segment.address;
    if (relative < 0 || relative + 4 > segment.data.length) continue;
    const config = readConfigAt(segment.data, relative);
    if (config) {
      return {
        segment,
        relative,
        address: FLASH_CONFIG_ADDRESS,
        config,
      };
    }
  }

  for (const segment of segments) {
    const config = findConfigBlock(segment.data);
    if (config) {
      return {
        segment,
        relative: config.offset,
        address: (segment.address + config.offset) >>> 0,
        config,
      };
    }
  }
  return null;
}

/**
 * Determine the layout of parsed HEX segments.
 *
 * Unlike a raw BIN, the load addresses come from the HEX records, so the
 * lowest segment address is the natural base address.
 */
export function detectHexImageLayout(segments) {
  const baseAddress =
    segments.length > 0
      ? segments.reduce((lowest, segment) => Math.min(lowest, segment.address), 0xffffffff)
      : null;
  const configHit = findConfigInSegments(segments);
  const config = configHit ? configHit.config : null;
  const configOffset = configHit ? configHit.address : null;

  let bootHeader = null;
  let bootHeaderOffset = null;
  for (const segment of segments) {
    const relativeConfigOffset =
      configHit && configHit.segment === segment ? configHit.relative : null;
    const header = findBootHeader(segment.data, relativeConfigOffset);
    if (header) {
      bootHeader = header;
      bootHeaderOffset = (segment.address + header.offset) >>> 0;
      break;
    }
  }

  let appOffset = null;
  let appLoadAddress = null;
  let appSize = null;
  if (bootHeader && bootHeader.fwInfo.length > 0) {
    const firmware = bootHeader.fwInfo[0];
    appOffset = (bootHeaderOffset + firmware.offset) >>> 0;
    appLoadAddress = firmware.loadAddress;
    appSize = firmware.size;
  }

  return {
    config,
    bootHeader,
    configOffset,
    baseAddress,
    bootHeaderOffset,
    appOffset,
    appLoadAddress,
    appSize,
  };
}

/**
 * Parse Intel HEX text for the flasher.
 *
 * The write address shown in the UI is the lowest segment address. If the
 * user edits it, every segment is shifted by the same delta, which also makes
 * relative-address HEX files usable.
 */
export function parseHexImage(text, options = {}) {
  const parsed = parseHex(text);
  if (parsed.length === 0) throw new Error('HEX file does not contain data records');

  const detectedAddress = parsed[0].address;
  const requestedAddress = options.address;
  const address =
    requestedAddress === undefined || requestedAddress === null
      ? detectedAddress
      : requestedAddress >>> 0;
  const delta = address - detectedAddress;

  const segments = parsed.map((segment) => {
    const shifted = segment.address + delta;
    if (!Number.isSafeInteger(shifted) || shifted < 0 || shifted > 0xffffffff) {
      throw new Error('HEX address rebase exceeds the 32-bit address space');
    }
    return { address: shifted >>> 0, data: segment.data };
  });

  const detectLayout = options.detectLayout !== false;
  const layout = detectLayout ? detectHexImageLayout(segments) : null;
  const manualWords = options.configWordsText
    ? parseWordList(options.configWordsText)
    : null;
  const configWords =
    manualWords && manualWords.length > 0
      ? manualWords
      : layout?.config?.words || parseWordList(DEFAULT_FLASH_CONFIG);
  const size = segments.reduce((sum, segment) => sum + segment.data.length, 0);

  return {
    format: 'hex',
    original: text,
    segments,
    imageData: null,
    size,
    address,
    detectedAddress,
    addressOverridden: address !== detectedAddress,
    configWords,
    configBytes: wordsToBytes(configWords),
    detectedConfig: detectLayout && !!layout?.config,
    configOffset: detectLayout ? layout?.configOffset ?? null : null,
    detectedBootHeader: detectLayout && !!layout?.bootHeader,
    bootHeaderOffset: detectLayout ? layout?.bootHeaderOffset ?? null : null,
    bootHeader: detectLayout ? layout?.bootHeader ?? null : null,
    appOffset: detectLayout ? layout?.appOffset ?? null : null,
    appLoadAddress: detectLayout ? layout?.appLoadAddress ?? null : null,
    appSize: detectLayout ? layout?.appSize ?? null : null,
  };
}

/**
 * Parse an image for the flasher.
 *
 * The whole file is written at `address`; the configuration block is part of
 * the image and must not be stripped. `configWords` are the words written to
 * ILM 0x200 for the Config Memory command.
 */
export function parseImage(data, options = {}) {
  if (!data || data.length === 0) {
    throw new Error('Image data is empty');
  }

  const detectLayout = options.detectLayout !== false;
  const layout = detectLayout ? detectImageLayout(data) : null;
  const manualWords = options.configWordsText
    ? parseWordList(options.configWordsText)
    : null;
  const configWords =
    manualWords && manualWords.length > 0
      ? manualWords
      : layout?.config?.words || parseWordList(DEFAULT_FLASH_CONFIG);

  const detectedAddress = detectLayout
    ? layout?.baseAddress ?? DEFAULT_FLASH_ADDRESS
    : DEFAULT_FLASH_ADDRESS;
  const address = options.address ?? detectedAddress;
  const imageData = data.slice();

  return {
    format: 'bin',
    original: data,
    segments: [{ address: address >>> 0, data: imageData }],
    imageData,
    size: imageData.length,
    address: address >>> 0,
    detectedAddress,
    addressOverridden:
      detectLayout && (address >>> 0) !== (detectedAddress >>> 0),
    configWords,
    configBytes: wordsToBytes(configWords),
    detectedConfig: detectLayout && !!layout?.config,
    configOffset: detectLayout ? layout?.configOffset ?? null : null,
    detectedBootHeader: detectLayout && !!layout?.bootHeader,
    bootHeaderOffset: detectLayout ? layout?.bootHeader?.offset ?? null : null,
    bootHeader: detectLayout ? layout?.bootHeader ?? null : null,
    appOffset: detectLayout ? layout?.appOffset ?? null : null,
    appLoadAddress: detectLayout ? layout?.appLoadAddress ?? null : null,
    appSize: detectLayout ? layout?.appSize ?? null : null,
  };
}

export async function readFileBytes(file) {
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

export function configWordsToText(words) {
  return words.map((word) => `0x${(word >>> 0).toString(16)}`).join(', ');
}
