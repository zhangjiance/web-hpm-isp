import { parseWordList, wordsToBytes } from './util.js';
import { readU32 } from './protocol.js';

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
 * Detect a 0xFCF9xxxx configuration block.
 *
 * The low 16 bits of the tag (the "word number" in the manufacturing tool)
 * indicate how many extra 32-bit words follow the tag. The tool always pads
 * the result to 4 words, so we do the same.
 */
export function findConfigBlock(data) {
  if (!data || data.length < 4) return null;
  for (const offset of SCAN_OFFSETS) {
    if (offset + 4 > data.length) break;
    const tag = readU32(data, offset);
    if (!isConfigTag(tag)) continue;
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

  return {
    original: data,
    imageData: data.slice(),
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
