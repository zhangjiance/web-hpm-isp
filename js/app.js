import { MEM } from './protocol.js';
import { RomClient } from './rom-client.js';
import { HidTransport, SerialTransport } from './transports.js';
import { detectImageLayout, parseImage, readFileBytes, configWordsToText } from './image.js';
import {
  AbortError,
  RomError,
  TimeoutError,
  TransportError,
  bytesHex,
  formatBytesCount,
  hex0x,
  isSecureContextOk,
  parseNumber,
  parseU32,
  parseWordList,
  wordsToBytes,
} from './util.js';

// Command ID 0x0A (verify-checksum) is advertised by bl_fw but not by the
// bare boot ROM. It is a more reliable "firmware already loaded" signal than
// Load Image support, because bl_fw still advertises load-image.
const BOOTLOADER_VERIFY_CHECKSUM_BIT = 1 << 10;
const BOOTLOADER_VERSION_PREFIX = 0x46; // ASCII 'F' in the encoded ROM version
const MIN_SOC_REVISIONS = {
  HPM6700_HPM6400: [1, 1, 0],
};

// Bit names used by the official GUI for Query RTE 5's command mask.
const ROM_SUPPORTED_COMMANDS = [
  [1 << 1, 'query-rte'],
  [1 << 2, 'config-memory'],
  [1 << 3, 'write-memory'],
  [1 << 4, 'read-memory'],
  [1 << 5, 'load-image'],
  [1 << 6, 'load-blfw'],
  [1 << 7, 'erase-region'],
  [1 << 8, 'erase-chip'],
  [1 << 9, 'reset'],
  [1 << 10, 'verify-checksum'],
];

// HID product IDs from the official GUI configuration; PID is paired with
// the SoC series. Keep this in sync with SOC_FIRMWARE.
const SOC_HID_PID = {
  HPM6700_HPM6400: 0x0001,
  HPM6300: 0x0002,
  HPM6200: 0x0003,
  HPM6800: 0x0004,
  HPM5300: 0x0005,
  HPM6E00: 0x0006,
  HPM6P00: 0x0007,
  HPM5E00: 0x0008,
  HPM5100: 0x0009,
};

const SOC_FIRMWARE = {
  HPM5100: 'hpm5100_blfw_unsigned.bin',
  HPM5300: 'hpm5300_blfw_unsigned.bin',
  HPM5E00: 'hpm5e00_blfw_unsigned.bin',
  HPM6200: 'hpm6200_blfw_unsigned.bin',
  HPM6300: 'hpm6300_blfw_unsigned.bin',
  HPM6700_HPM6400: 'hpm6700_hpm6400_blfw_unsigned.bin',
  HPM6800: 'hpm6800_blfw_unsigned.bin',
  HPM6E00: 'hpm6e00_blfw_unsigned.bin',
  HPM6P00: 'hpm6p00_blfw_unsigned.bin',
};

const $ = (id) => document.getElementById(id);

const els = {
  hpmApp: $('hpmApp'),
  browserBadge: $('browserBadge'),
  warningBanner: $('warningBanner'),
  transportSelect: $('transportSelect'),
  baudField: $('baudField'),
  hidOptions: $('hidOptions'),
  serialBaud: $('serialBaud'),
  hidAllDevices: $('hidAllDevices'),
  connectBtn: $('connectBtn'),
  hidReconnectModal: $('hidReconnectModal'),
  hidReconnectHint: $('hidReconnectHint'),
  hidReconnectModalBtn: $('hidReconnectModalBtn'),
  hidReconnectCancelBtn: $('hidReconnectCancelBtn'),
  hidReconnectCloseBtn: $('hidReconnectCloseBtn'),
  configGearBtn: $('configGearBtn'),
  flashConfigModal: $('flashConfigModal'),
  flashConfigCloseBtn: $('flashConfigCloseBtn'),
  flashConfigApplyBtn: $('flashConfigApplyBtn'),
  flashConfigCancelBtn: $('flashConfigCancelBtn'),
  flashConfigPreset: $('flashConfigPreset'),
  flashConfigPreview: $('flashConfigPreview'),
  cfgCustomEnabled: $('cfgCustomEnabled'),
  cfgProbe: $('cfgProbe'),
  cfgReadLines: $('cfgReadLines'),
  cfgConfigLines: $('cfgConfigLines'),
  cfgQe: $('cfgQe'),
  cfgDummy: $('cfgDummy'),
  cfgMisc: $('cfgMisc'),
  cfgFreq: $('cfgFreq'),
  cfgIoVoltage: $('cfgIoVoltage'),
  cfgPinGroup: $('cfgPinGroup'),
  cfgConnection: $('cfgConnection'),
  cfgDrive: $('cfgDrive'),
  cfgFlashSize: $('cfgFlashSize'),
  connState: $('connState'),
  connDetail: $('connDetail'),
  connectHint: $('connectHint'),
  socSelect: $('socSelect'),
  address: $('address'),
  configWords: $('configWords'),
  imageType: $('imageType'),
  imageDropZone: $('imageDropZone'),
  imageFile: $('imageFile'),
  imageFileName: $('imageFileName'),
  verifyAfter: $('verifyAfter'),
  resetAfter: $('resetAfter'),
  progressSection: $('progressSection'),
  progressBar: $('progressBar'),
  progressText: $('progressText'),
  percentText: $('percentText'),
  flashBtn: $('flashBtn'),
  readFlashBtn: $('readFlashBtn'),
  eraseChipBtn: $('eraseChipBtn'),
  cancelBtn: $('cancelBtn'),
  readFlashModal: $('readFlashModal'),
  readFlashCloseBtn: $('readFlashCloseBtn'),
  readDetectInfo: $('readDetectInfo'),
  readDetectBtn: $('readDetectBtn'),
  readAddress: $('readAddress'),
  readLength: $('readLength'),
  readStartBtn: $('readStartBtn'),
  readCancelBtn: $('readCancelBtn'),
  eraseChipModal: $('eraseChipModal'),
  eraseChipCloseBtn: $('eraseChipCloseBtn'),
  eraseTarget: $('eraseTarget'),
  eraseDetectInfo: $('eraseDetectInfo'),
  eraseDetectBtn: $('eraseDetectBtn'),
  eraseAddress: $('eraseAddress'),
  eraseLength: $('eraseLength'),
  eraseRangeHint: $('eraseRangeHint'),
  eraseStartBtn: $('eraseStartBtn'),
  eraseCancelBtn: $('eraseCancelBtn'),
  logSuccessTitle: $('logSuccessTitle'),
  log: $('log'),
  logSuccess: $('logSuccess'),
  logSuccessDetail: $('logSuccessDetail'),
  logSuccessClose: $('logSuccessClose'),
  debugLog: $('debugLog'),
  clearLogBtn: $('clearLogBtn'),
};

let detectedXpi = null;

const state = {
  transport: null,
  client: null,
  imageBuffer: null,
  image: null,
  busy: false,
  connecting: false,
  bootloaderReady: false,
  cancelRequested: false,
  reconnecting: false,
  flashSucceeded: false,
  verifySupported: true,
  firmwareCache: new Map(),
  logCount: 0,
};

function makeClient(transport) {
  return new RomClient(transport, {
    log,
    debug: els.debugLog.checked,
    timeout: 10000,
    shouldCancel: () => state.cancelRequested,
  });
}

function log(level, message) {
  const now = new Date();
  const time = now.toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  const timeEl = document.createElement('span');
  timeEl.className = 'log-time';
  timeEl.textContent = time;
  const levelEl = document.createElement('span');
  levelEl.className = 'log-level';
  levelEl.textContent = level.toUpperCase();
  const msgEl = document.createElement('span');
  msgEl.className = 'log-msg';
  msgEl.textContent = message;
  line.append(timeEl, levelEl, msgEl);
  els.log.appendChild(line);
  state.logCount += 1;
  if (state.logCount > 1500) {
    els.log.firstElementChild?.remove();
    state.logCount -= 1;
  }
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatusDetail(text, kind = '') {
  if (!els.connDetail) return;
  els.connDetail.textContent = text;
  els.connDetail.title = text;
  els.connDetail.className = `hpm-status-detail${kind ? ` ${kind}` : ''}`;
}

function setConnectingState(text) {
  state.connecting = true;
  hideLogSuccess();
  setStatusDetail(text, '');
  updateUi();
}

function showLogSuccess(title, detail) {
  if (!els.logSuccess) return;
  if (els.logSuccessTitle) els.logSuccessTitle.textContent = title || 'Success';
  if (els.logSuccessDetail) els.logSuccessDetail.textContent = detail || '';
  els.logSuccess.hidden = false;
  els.hpmApp?.classList.add('is-success');
}

function hideLogSuccess() {
  if (els.logSuccess) els.logSuccess.hidden = true;
  els.hpmApp?.classList.remove('is-success');
}

function setImageFileName(name) {
  if (!els.imageFileName) return;
  els.imageFileName.textContent = name || 'No file selected';
  els.imageFileName.classList.toggle('has-file', !!name);
  els.imageDropZone?.classList.toggle('has-file', !!name);
}

function setProgress(percent, text, phase = 'write') {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  els.progressBar.style.width = `${value}%`;
  els.percentText.textContent = `${value}%`;
  if (text) els.progressText.textContent = text;
  els.progressSection?.classList.toggle('is-verify', phase === 'verify');
}

function setBusy(busy, options = {}) {
  state.busy = busy;
  if (busy) hideLogSuccess();
  if (els.progressSection) {
    els.progressSection.hidden = !busy;
    if (busy) els.progressSection.classList.remove('is-verify');
    els.progressSection.classList.toggle(
      'is-indeterminate',
      !!(busy && options.indeterminate),
    );
  }
  if (els.cancelBtn) {
    els.cancelBtn.hidden = !busy || options.cancellable === false;
  }
  updateUi();
}

function setIndeterminateProgress(text) {
  if (els.progressText) els.progressText.textContent = text;
  if (els.percentText) els.percentText.textContent = '…';
  if (els.progressBar) els.progressBar.style.width = '35%';
}

function showHidReconnectModal() {
  if (!els.hidReconnectModal) return;
  if (els.hidReconnectHint) {
    const productId = els.hidAllDevices.checked
      ? null
      : SOC_HID_PID[els.socSelect.value];
    if (productId !== null && productId !== undefined) {
      els.hidReconnectHint.textContent =
        `Select the device whose product name is Boot Firmware Open ` +
        `(VID 0x34b7, PID 0x${productId.toString(16).padStart(4, '0')}). ` +
        `If it is not listed yet, wait 1-2 seconds and try again.`;
    } else {
      els.hidReconnectHint.textContent =
        'Select the device whose product name is Boot Firmware Open. ' +
        'If it is not listed yet, wait 1-2 seconds and try again.';
    }
  }
  els.hidReconnectModal.hidden = false;
  els.hidReconnectModalBtn?.focus();
}

function hideHidReconnectModal() {
  if (!els.hidReconnectModal) return;
  els.hidReconnectModal.hidden = true;
}

function getTransportType() {
  return els.transportSelect?.value || 'serial';
}

function getImageType() {
  return els.imageType?.value === 'user' ? 'user' : 'boot';
}

function imageTypeLabel() {
  return getImageType() === 'boot' ? 'Boot Image' : 'User Data';
}

function getHidFilters() {
  if (els.hidAllDevices.checked) return [];
  const productId = SOC_HID_PID[els.socSelect.value];
  return productId === undefined
    ? [{ vendorId: 0x34b7 }]
    : [{ vendorId: 0x34b7, productId }];
}

function updateUi() {
  const isHid = getTransportType() === 'hid';
  const connected = !!state.transport;
  const locked = state.busy || connected || state.connecting;

  els.hpmApp?.classList.toggle('is-connecting', state.connecting);
  els.hpmApp?.classList.toggle('is-connected', connected && !state.connecting);
  els.hpmApp?.classList.toggle('is-busy', state.busy);
  els.connState.classList.toggle('is-connecting', state.connecting);
  els.connState.classList.toggle('is-connected', connected && !state.connecting);

  // UART needs a baud rate; HID needs the optional broad endpoint filter.
  els.baudField.hidden = isHid;
  els.hidOptions.hidden = !isHid;

  els.connectBtn.disabled = state.busy || state.connecting || !els.socSelect.value;
  els.connectBtn.textContent = state.connecting
    ? 'Connecting...'
    : connected
      ? 'Disconnect'
      : 'Connect';
  els.connectBtn.className = connected && !state.connecting ? 'danger' : 'primary';
  els.transportSelect.disabled = locked;
  els.socSelect.disabled = locked;
  els.serialBaud.disabled = locked;
  els.hidAllDevices.disabled = locked;
  els.flashBtn.disabled = state.busy || state.connecting || !connected || !state.image;
  els.flashBtn.title = state.busy
    ? 'Another operation is in progress'
    : state.connecting
      ? 'Connecting to device...'
      : !connected
        ? 'Connect a device first'
        : !state.image
          ? 'Select an image first'
          : 'Program the selected image';
  els.readFlashBtn.disabled = state.busy || state.connecting || !connected;
  els.readFlashBtn.title = state.busy
    ? 'Another operation is in progress'
    : state.connecting
      ? 'Connecting to device...'
      : !connected
        ? 'Connect a device first'
        : 'Read XPI0 NOR flash to a .bin file';
  els.eraseChipBtn.disabled = state.busy || state.connecting || !connected;
  els.eraseChipBtn.title = state.busy
    ? 'Another operation is in progress'
    : state.connecting
      ? 'Connecting to device...'
      : !connected
        ? 'Connect a device first'
        : 'Erase XPI0 NOR (full chip or a custom range)';
  els.cancelBtn.disabled = !state.busy;

  if (els.verifyAfter) {
    els.verifyAfter.disabled = false;
    els.verifyAfter.title = state.verifySupported
      ? 'Verify after write'
      : 'Hardware verify is unsupported; read-back verification will be used';
  }

  if (els.connectHint) {
    els.connectHint.textContent =
      state.busy || state.connecting || connected
        ? ''
        : !els.socSelect.value
          ? 'Select a SoC to enable Connect.'
          : 'Click Connect to start.';
  }

  if (state.connecting) {
    els.connState.textContent = 'Connecting...';
    els.connState.style.color = 'var(--button-warning)';
  } else if (!connected) {
    els.connState.textContent = 'Disconnected';
    els.connState.style.color = '';
  } else if (state.transport.kind === 'serial') {
    els.connState.textContent = 'Connected UART';
    els.connState.style.color = 'var(--progress-fill)';
  } else {
    els.connState.textContent = 'Connected HID';
    els.connState.style.color = 'var(--progress-fill)';
  }
}

function connectDevice() {
  if (state.busy || state.transport || state.connecting) return;
  return getTransportType() === 'hid' ? connectHid() : connectSerial();
}

async function queryDeviceInfo(client) {
  try {
    const info = await client.getRomInfo(3000);
    log(
      'info',
      `ROM: version=${encodedVersionText(info.romVersion)} ` +
        `(0x${info.romVersion.toString(16)}) ` +
        `revision=${encodedVersionText(info.socRevision)} ` +
        `(0x${info.socRevision.toString(16)}) ` +
        `lifeCycle=${info.lifeCycle} features=0x${info.features.toString(16)}`,
    );
  } catch (error) {
    log('warn', `Failed to query ROM info (device may not be in ISP mode): ${error.message}`);
  }
  try {
    const mask = await client.getSupportedCommands(3000);
    log('info', `Supported command mask: ${hex0x(mask, 8)}`);
    const commands = ROM_SUPPORTED_COMMANDS
      .filter(([bit]) => (mask & bit) !== 0)
      .map(([, name]) => name);
    log(
      'info',
      `Supported commands:\n${commands.length ? commands.join('\n') : '(none)'}`,
    );
    const knownMask = ROM_SUPPORTED_COMMANDS.reduce((value, [bit]) => value | bit, 0);
    const unknownMask = mask & ~knownMask;
    if (unknownMask) {
      log('debug', `Unknown supported-command bits: ${hex0x(unknownMask, 8)}`);
    }
  } catch (error) {
    log('debug', `Failed to query supported commands: ${error.message}`);
  }
}

function encodedVersionParts(value) {
  return [
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function encodedVersionText(value) {
  const prefix = String.fromCharCode((value >>> 24) & 0xff);
  const [major, minor, patch] = encodedVersionParts(value);
  return `${prefix}${major}.${minor}.${patch}`;
}

function versionAtLeast(value, min) {
  const parts = encodedVersionParts(value);
  for (let index = 0; index < min.length; index += 1) {
    if (parts[index] > min[index]) return true;
    if (parts[index] < min[index]) return false;
  }
  return true;
}

async function detectBootloaderFirmware(client, timeoutMs = 2000) {
  let info = null;
  try {
    info = await client.getRomInfo(timeoutMs);
  } catch (error) {
    log('debug', `Cannot query ROM version while detecting bl_fw: ${error.message}`);
  }

  // The official GUI treats a ROM version starting with "F" as bl_fw and a
  // version starting with "V" as the bare boot ROM. The encoded version is
  // four bytes: prefix, major, minor, patch.
  if (info && ((info.romVersion >>> 24) & 0xff) === BOOTLOADER_VERSION_PREFIX) {
    return {
      known: true,
      active: true,
      reason: 'firmware-version',
      verifySupported: true,
      info,
      mask: null,
    };
  }

  const minSocRevision = MIN_SOC_REVISIONS[els.socSelect.value];
  if (info && minSocRevision && !versionAtLeast(info.socRevision, minSocRevision)) {
    log(
      'warn',
      `Current SoC revision ${encodedVersionText(info.socRevision)} is below the minimum ` +
        `${minSocRevision.join('.')}; using the bare ROM and skipping bl_fw load.`,
    );
    return {
      known: true,
      active: true,
      reason: 'min-soc-revision',
      verifySupported: false,
      info,
      mask: null,
    };
  }

  try {
    const mask = await client.getSupportedCommands(timeoutMs);
    return {
      known: true,
      active: (mask & BOOTLOADER_VERIFY_CHECKSUM_BIT) !== 0,
      reason: 'command-mask',
      verifySupported: (mask & BOOTLOADER_VERIFY_CHECKSUM_BIT) !== 0,
      info,
      mask,
    };
  } catch (error) {
    log('debug', `Cannot determine whether bl_fw is loaded: ${error.message}`);
    return { known: false, active: false, verifySupported: false, info, mask: null };
  }
}

async function connectSerial() {
  if (state.busy || state.transport || state.connecting) return;
  if (!els.socSelect.value) {
    log('error', 'Select a SoC series before connecting (used to load bl_fw)');
    setStatusDetail('Select a SoC series first', 'error');
    return;
  }
  let targetBaud;
  try {
    targetBaud = parseNumber(els.serialBaud.value);
    if (targetBaud <= 0) throw new Error('Baud rate must be greater than 0');
  } catch (error) {
    log('error', `Invalid baud rate: ${error.message}`);
    return;
  }

  let port;
  try {
    port = await SerialTransport.requestPort();
  } catch (error) {
    if (error?.name === 'NotFoundError') return;
    log('error', `Failed to select serial port: ${error.message}`);
    return;
  }

  // The ROM always starts at 115200. Probe there first, then switch the
  // active UART rate with configure-rte and reopen the same SerialPort.
  const transport = new SerialTransport(port, {
    baudRate: 115200,
    log,
    debug: els.debugLog.checked,
  });

  try {
    setConnectingState('Opening 115200 bps...');
    await transport.open();
    let client = makeClient(transport);
    let workingBaud = 115200;

    try {
      await client.getRomInfo(1500);
    } catch (error) {
      if (targetBaud === 115200) throw error;
      // The device may still be at the previously selected baud rate.
      setStatusDetail(`Opening ${targetBaud} bps...`, '');
      await transport.reopen(targetBaud);
      client = makeClient(transport);
      await client.getRomInfo(1500);
      workingBaud = targetBaud;
      log('info', `Device is already responding at ${targetBaud} bps`);
    }

    if (workingBaud !== targetBaud) {
      setStatusDetail(`Switching UART to ${targetBaud} bps...`, '');
      log('info', `Configuring UART baud rate: ${targetBaud}`);
      try {
        await client.configRte(targetBaud, 3000);
      } catch (error) {
        log('warn', `No response to baud switch; verifying at ${targetBaud}: ${error.message}`);
      }
      await transport.reopen(targetBaud);
      client = makeClient(transport);
      await client.getRomInfo(3000);
    }

    const bootloaderState = await detectBootloaderFirmware(client);
    const bootloaderAlreadyLoaded = bootloaderState.known && bootloaderState.active;

    if (bootloaderAlreadyLoaded) {
      // Reconnecting after a normal disconnect leaves bl_fw running in RAM.
      // Do not execute Load Image again; it is not valid after bl_fw starts.
      log('info', 'Bootloader firmware already loaded; skipping bl_fw load');
      setStatusDetail('Bootloader already running', '');
      if (targetBaud !== transport.baudRate) {
        client = await switchBootloaderBaud(transport, client, targetBaud);
      } else {
        setStatusDetail(`Bootloader · ${transport.baudRate} bps`, '');
      }
    } else {
      if (bootloaderState.known) {
        log('info', 'Bare ROM detected; loading bl_fw');
      } else {
        log('debug', 'Bootloader state unknown; loading bl_fw');
      }

      // bl_fw is a RAM image and does not depend on the user's Flash image or
      // configuration words.
      const firmware = await getFirmware(els.socSelect.value);
      setStatusDetail(`Loading bl_fw at ${targetBaud} bps...`, '');
      log('info', `Loading bl_fw at ${targetBaud} bps...`);
      let lastPercent = -1;
      await client.loadImage(firmware, (done, total) => {
        const percent = total > 0 ? Math.round((done / total) * 100) : 0;
        if (percent === 100 || percent >= lastPercent + 10) {
          lastPercent = percent;
          setStatusDetail(`Loading bl_fw... ${percent}%`, '');
        }
      });
      log('info', 'Firmware load complete; waiting for bootloader');

      await new Promise((resolve) => setTimeout(resolve, 600));

      // bl_fw starts its own UART at 115200. Connect there first, then ask the
      // bootloader to switch to the user-selected rate for programming.
      setStatusDetail('Waiting for bootloader at 115200 bps...', '');
      await transport.reopen(115200);
      client = makeClient(transport);
      await client.waitForBootloader(15000);

      if (targetBaud !== 115200) {
        client = await switchBootloaderBaud(transport, client, targetBaud);
      } else {
        setStatusDetail('Bootloader · 115200 bps', '');
      }
    }

    const activeBaud = transport.baudRate;
    state.transport = transport;
    state.client = client;
    state.bootloaderReady = true;
    state.verifySupported = bootloaderAlreadyLoaded
      ? bootloaderState.verifySupported !== false
      : true;
    if (!state.verifySupported) {
      log('warn', 'verify-checksum is unavailable; Verify will use read-back comparison.');
    }
    state.connecting = false;
    setStatusDetail(`Bootloader · ${activeBaud} bps`, '');
    log('success', `Bootloader connected at ${activeBaud} bps`);
    updateUi();
    await queryDeviceInfo(client);
  } catch (error) {
    log('error', `Serial connection failed: ${error.message}`);
    state.connecting = false;
    state.verifySupported = true;
    setStatusDetail(`Connection failed: ${error.message}`, 'error');
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
    updateUi();
  }
}

async function connectHid() {
  if (state.busy || state.transport || state.connecting) return;
  if (!els.socSelect.value) {
    log('error', 'Select a SoC series before connecting (used to load bl_fw)');
    setStatusDetail('Select a SoC series first', 'error');
    return;
  }
  let devices;
  try {
    devices = await HidTransport.requestDevice(getHidFilters());
  } catch (error) {
    if (error?.name === 'NotFoundError') return;
    log('error', `Failed to select HID device: ${error.message}`);
    return;
  }
  if (!devices || devices.length === 0) {
    log('warn', 'No HID device selected');
    return;
  }
  const device = devices[0];
  const transport = new HidTransport(device, {
    log,
    debug: els.debugLog.checked,
    onReconnectNeeded: () => {
      state.reconnecting = true;
      updateUi();
      showHidReconnectModal();
    },
  });

  try {
    setConnectingState('Opening HID device...');
    await transport.open();
    // Set the transport now so the re-enumeration dialog can reopen this
    // session while bl_fw is being loaded.
    state.transport = transport;
    state.client = makeClient(transport);
    state.bootloaderReady = false;
    updateUi();

    const hidName = transport.device?.productName || '';
    const namedAsBootloader = /boot\s*firmware|bootloader|firmware open/i.test(hidName);
    const bootloaderState = namedAsBootloader
      ? { known: true, active: true }
      : await detectBootloaderFirmware(state.client);

    if (bootloaderState.known && bootloaderState.active) {
      // Same HID PID is used by the ROM and bl_fw. The version prefix,
      // verify-checksum support, or the device name can identify bl_fw.
      if (namedAsBootloader) {
        log('info', `HID device name indicates bootloader: ${hidName}`);
      }
      log('info', 'HID bootloader firmware already loaded; skipping bl_fw load');
      setStatusDetail('Waiting for bootloader...', '');
      await state.client.waitForBootloader(5000);
      state.bootloaderReady = true;
      state.verifySupported = bootloaderState.verifySupported !== false;
      if (!state.verifySupported) {
        log('warn', 'verify-checksum is unavailable; Verify will use read-back comparison.');
      }
      state.connecting = false;
    } else {
      log('info', 'HID is running bare ROM; loading bl_fw');
      const firmware = await getFirmware(els.socSelect.value);
      setStatusDetail('Loading bl_fw over HID...', '');
      log('info', `Loading bl_fw over HID (${formatBytesCount(firmware.length)})...`);
      let lastPercent = -1;
      await state.client.loadImage(firmware, (done, total) => {
        const percent = total > 0 ? Math.round((done / total) * 100) : 0;
        if (percent === 100 || percent >= lastPercent + 10) {
          lastPercent = percent;
          setStatusDetail(`Loading bl_fw... ${percent}%`, '');
        }
      });

      log('info', 'Firmware load complete; waiting for HID re-enumeration');
      setStatusDetail('Waiting for HID re-enumeration...', '');
      state.reconnecting = true;
      updateUi();
      try {
        await transport.reconnectAfterReboot();
      } finally {
        hideHidReconnectModal();
        state.reconnecting = false;
        updateUi();
      }

      state.client = makeClient(transport);
      setStatusDetail('Waiting for bootloader...', '');
      await state.client.waitForBootloader(15000);
      state.bootloaderReady = true;
      state.verifySupported = true;
      state.connecting = false;
    }

    const activeDevice = transport.device || device;
    setStatusDetail(
      `${activeDevice.productName || 'HID device'} · ` +
        `0x${activeDevice.vendorId.toString(16)}:0x${activeDevice.productId.toString(16)}`,
    );
    log(
      'success',
      `HID bootloader connected: VID=0x${activeDevice.vendorId.toString(16)} ` +
        `PID=0x${activeDevice.productId.toString(16)}`,
    );
    updateUi();
    await queryDeviceInfo(state.client);
  } catch (error) {
    const cancelled = state.cancelRequested || error instanceof AbortError;
    if (cancelled) {
      log('warn', 'HID connection cancelled');
    } else {
      log('error', `HID connection failed: ${error.message}`);
    }
    state.connecting = false;
    state.reconnecting = false;
    state.cancelRequested = false;
    state.transport = null;
    state.client = null;
    state.bootloaderReady = false;
    state.verifySupported = true;
    hideHidReconnectModal();
    setStatusDetail(
      cancelled ? 'Connection cancelled' : `Connection failed: ${error.message}`,
      cancelled ? '' : 'error',
    );
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
    updateUi();
  }
}

async function reconnectHid() {
  const transport = state.transport;
  if (!transport || transport.kind !== 'hid') {
    await connectHid();
    return;
  }
  const expectedPid = els.hidAllDevices.checked
    ? undefined
    : SOC_HID_PID[els.socSelect.value];
  const filters = transport.isReconnecting
    ? [
        {
          vendorId: transport.vid,
          ...(expectedPid !== undefined ? { productId: expectedPid } : {}),
        },
      ]
    : [{ vendorId: transport.vid, productId: transport.pid }];
  let devices;
  try {
    devices = await HidTransport.requestDevice(filters);
  } catch (error) {
    if (error?.name === 'NotFoundError') return;
    log('error', `Failed to reselect HID device: ${error.message}`);
    return;
  }
  if (!devices || devices.length === 0) return;

  const device = devices[0];
  const wasReconnecting = transport.isReconnecting;
  try {
    await transport.useDevice(device);
    if (wasReconnecting) {
      hideHidReconnectModal();
      log('info', 'HID device selected; waiting for reconnection...');
    } else {
      hideHidReconnectModal();
      state.client = makeClient(transport);
      setStatusDetail(
        `${device.productName || 'HID device'} · ` +
          `0x${device.vendorId.toString(16)}:0x${device.productId.toString(16)}`,
      );
      updateUi();
      await queryDeviceInfo(state.client);
    }
  } catch (error) {
    log('error', `Failed to reopen HID device: ${error.message}`);
  }
}

async function disconnectDevice() {
  hideHidReconnectModal();
  closeReadFlashDialog();
  closeEraseChipDialog();
  if (!state.transport) return;
  const transport = state.transport;
  state.transport = null;
  state.client = null;
  state.bootloaderReady = false;
  state.verifySupported = true;
  try {
    await transport.close();
  } catch {
    /* ignore */
  }
  setStatusDetail('', '');
  log('info', 'Device disconnected');
  updateUi();
}

async function getFirmware(soc) {
  const name = SOC_FIRMWARE[soc];
  if (!name) throw new Error(`Unknown SoC: ${soc}`);
  if (state.firmwareCache.has(soc)) return state.firmwareCache.get(soc);
  log('info', `Loading firmware: firmware/${name}`);
  const response = await fetch(`firmware/${name}`);
  if (!response.ok) {
    throw new Error(`Cannot load firmware/${name}: HTTP ${response.status}`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  state.firmwareCache.set(soc, data);
  log('info', `Firmware loaded: ${formatBytesCount(data.length)}`);
  return data;
}

function refreshImage() {
  hideLogSuccess();
  if (!state.imageBuffer) {
    state.image = null;
    updateUi();
    return;
  }
  try {
    const isBootImage = getImageType() === 'boot';
    const image = parseImage(state.imageBuffer, {
      address: els.address.value.trim() ? parseU32(els.address.value) : undefined,
      configWordsText: els.configWords.value,
      detectLayout: isBootImage,
    });
    state.image = image;

    log('info', `File size: ${formatBytesCount(state.imageBuffer.length)}`);
    if (isBootImage) {
      if (image.detectedConfig) {
        log(
          'info',
          `Config block @0x${image.configOffset.toString(16)}, ` +
            `words: ${configWordsToText(image.configWords)}`,
        );
      } else {
        log('warn', 'No 0xFCF9xxxx config block; using manual words');
      }
      if (image.detectedBootHeader) {
        let line = `Boot Header @0x${image.bootHeaderOffset.toString(16)}`;
        if (image.appOffset !== null && image.appLoadAddress !== null) {
          line +=
            `, application data @0x${image.appOffset.toString(16)} -> ` +
            `0x${image.appLoadAddress.toString(16)}`;
        }
        log('info', line);
      }
    }
    log('info', `Write address: ${hex0x(image.address, 8)}`);
    if (image.addressOverridden) {
      log(
        'warn',
        `Manual write address differs from auto-detected ${hex0x(image.detectedAddress, 8)}`,
      );
    }
    log('info', `Write data: ${formatBytesCount(image.imageData.length)} (whole file)`);
  } catch (error) {
    state.image = null;
    log('error', `Image parse failed: ${error.message}`);
  }
  updateUi();
}

function onImageTypeChange() {
  const type = getImageType();
  if (type === 'boot' && state.imageBuffer) {
    const layout = detectImageLayout(state.imageBuffer);
    if (layout.config?.words) {
      els.configWords.value = configWordsToText(layout.config.words);
    }
    if (layout.baseAddress !== null && layout.baseAddress !== undefined) {
      els.address.value = `0x${layout.baseAddress.toString(16)}`;
    }
  }
  log('info', `Image type: ${imageTypeLabel()}`);
  refreshImage();
}

// Unique option[4] values from hpm_sdk/boards/*evk*/board.c:
//   HPM5100EVK, HPM5300EVK, HPM5301EVKLite, HPM5E00EVK, HPM6P00EVK
//   HPM6200EVK, HPM6300EVK, HPM6800EVK, HPM6E00EVK
//   HPM6750EVK2, HPM6750EVKMINI
const FLASH_CONFIG_PRESETS = {
  hpm5300evk: [0xfcf90002, 0x00000005, 0x00001000, 0x00000000],
  typical_a0: [0xfcf90001, 0x00000007, 0x00000000, 0x00000000],
  typical_b0: [0xfcf90002, 0x00000007, 0x00000100, 0x00000000],
  typical_a1: [0xfcf90002, 0x00000007, 0x00001000, 0x00000000],
  hpm6750evk: [0xfcf90002, 0x00000007, 0x0000000e, 0x00000000],
};

const CONFIG_FIELD_IDS = [
  'cfgProbe',
  'cfgReadLines',
  'cfgConfigLines',
  'cfgQe',
  'cfgDummy',
  'cfgMisc',
  'cfgFreq',
  'cfgIoVoltage',
  'cfgPinGroup',
  'cfgConnection',
  'cfgDrive',
  'cfgFlashSize',
];

function decodeFlashConfig(words) {
  const normalized = [...words, 0, 0, 0, 0].slice(0, 4).map((word) => word >>> 0);
  const header = normalized[0];
  const isConfigTag = ((header & 0xffff0000) >>> 0) === 0xfcf90000;
  let wordsCount = isConfigTag ? header & 0xf : 2;
  if (wordsCount < 1 || wordsCount > 3) wordsCount = 2;
  const option0 = normalized[1];
  const option1 = normalized[2];
  const option2 = normalized[3];
  return {
    wordsCount,
    probe: (option0 >>> 28) & 0xf,
    readLines: (option0 >>> 24) & 0xf,
    configLines: (option0 >>> 20) & 0xf,
    qe: (option0 >>> 16) & 0xf,
    dummy: (option0 >>> 8) & 0xff,
    misc: (option0 >>> 4) & 0xf,
    freq: option0 & 0xf,
    ioVoltage: (option1 >>> 16) & 0xf,
    pinGroup: (option1 >>> 12) & 0xf,
    connection: (option1 >>> 8) & 0xf,
    drive: option1 & 0xff,
    eraseCmd: (option2 >>> 12) & 0xf,
    sectorSize: (option2 >>> 8) & 0xf,
    flashSize: option2 & 0xff,
  };
}

function buildFlashConfigWords() {
  const probe = Number(els.cfgProbe.value) || 0;
  const readLines = Number(els.cfgReadLines.value) || 0;
  const configLines = Number(els.cfgConfigLines.value) || 0;
  const qe = Number(els.cfgQe.value) || 0;
  const dummy = Number(els.cfgDummy.value) || 0;
  const misc = Number(els.cfgMisc.value) || 0;
  const freq = Number(els.cfgFreq.value) || 0;
  const ioVoltage = Number(els.cfgIoVoltage.value) || 0;
  const pinGroup = Number(els.cfgPinGroup.value) || 0;
  const connection = Number(els.cfgConnection.value) || 0;
  const drive = Number(els.cfgDrive.value) || 0;
  const flashSize = Number(els.cfgFlashSize.value) || 0;

  const option0 =
    (((probe & 0xf) << 28) |
      ((readLines & 0xf) << 24) |
      ((configLines & 0xf) << 20) |
      ((qe & 0xf) << 16) |
      ((dummy & 0xff) << 8) |
      ((misc & 0xf) << 4) |
      (freq & 0xf)) >>>
    0;
  const option1 =
    (((ioVoltage & 0xf) << 16) |
      ((pinGroup & 0xf) << 12) |
      ((connection & 0xf) << 8) |
      (drive & 0xff)) >>>
    0;
  const option2 = flashSize & 0xff;

  // The vendor GUI only includes the option words that are needed.
  const wordsCount = option2 !== 0 ? 3 : option1 !== 0 ? 2 : 1;
  const header = (0xfcf90000 | wordsCount) >>> 0;
  return [header, option0, option1, option2];
}

function formatFlashConfig(words) {
  return words.map((word) => `0x${(word >>> 0).toString(16)}`).join(', ');
}

function setSelectValue(element, value) {
  const text = String(value);
  if (![...element.options].some((option) => option.value === text)) {
    const option = document.createElement('option');
    option.value = text;
    option.textContent = `${text} - custom`;
    element.appendChild(option);
  }
  element.value = text;
}

function setConfigFieldsEnabled(enabled) {
  els.cfgCustomEnabled.checked = enabled;
  els.flashConfigModal.classList.toggle('hpm-config-disabled', !enabled);
  for (const id of CONFIG_FIELD_IDS) {
    const field = els[id];
    if (field) field.disabled = !enabled;
  }
  els.flashConfigApplyBtn.disabled = !enabled;
}

function setFlashConfigForm(values) {
  setSelectValue(els.cfgProbe, values.probe);
  setSelectValue(els.cfgReadLines, values.readLines);
  setSelectValue(els.cfgConfigLines, values.configLines);
  setSelectValue(els.cfgQe, values.qe);
  setSelectValue(els.cfgDummy, values.dummy);
  setSelectValue(els.cfgMisc, values.misc);
  setSelectValue(els.cfgFreq, values.freq);
  setSelectValue(els.cfgIoVoltage, values.ioVoltage);
  setSelectValue(els.cfgPinGroup, values.pinGroup);
  setSelectValue(els.cfgConnection, values.connection);
  els.cfgDrive.value = String(values.drive);
  setSelectValue(els.cfgFlashSize, values.flashSize);
  setConfigFieldsEnabled(true);
  updateFlashConfigPreview();

  const current = formatFlashConfig(buildFlashConfigWords());
  const matched = Object.entries(FLASH_CONFIG_PRESETS).find(
    ([, words]) => formatFlashConfig(words) === current,
  );
  els.flashConfigPreset.value = matched ? matched[0] : 'custom';
}

function updateFlashConfigPreview() {
  els.flashConfigPreview.textContent = formatFlashConfig(buildFlashConfigWords());
}

function openFlashConfigDialog() {
  let words;
  try {
    words = parseWordList(els.configWords.value);
  } catch {
    words = FLASH_CONFIG_PRESETS.hpm5300evk;
  }
  setFlashConfigForm(decodeFlashConfig(words));
  els.flashConfigModal.hidden = false;
  els.cfgProbe.focus();
}

function closeFlashConfigDialog() {
  els.flashConfigModal.hidden = true;
}

function applyFlashConfig() {
  const text = formatFlashConfig(buildFlashConfigWords());
  els.configWords.value = text;
  closeFlashConfigDialog();
  refreshImage();
  log('info', `Flash configuration words updated: ${text}`);
}

async function loadImageFile(file) {
  hideLogSuccess();
  setImageFileName(file ? file.name : '');
  if (!file) {
    state.imageBuffer = null;
    state.image = null;
    updateUi();
    return;
  }
  try {
    state.imageBuffer = await readFileBytes(file);
    // Boot images carry the Flash configuration block and write address.
    // User data is written as-is at the address entered by the user.
    if (getImageType() === 'boot') {
      const layout = detectImageLayout(state.imageBuffer);
      if (layout.config?.words) {
        els.configWords.value = configWordsToText(layout.config.words);
      }
      if (layout.baseAddress !== null && layout.baseAddress !== undefined) {
        els.address.value = `0x${layout.baseAddress.toString(16)}`;
      }
    }
    log('info', `Image selected: ${file.name} (${imageTypeLabel()})`);
    refreshImage();
  } catch (error) {
    log('error', `Failed to read image: ${error.message}`);
  }
}

async function onImageFileChange() {
  await loadImageFile(els.imageFile.files?.[0]);
}

function initImageDropZone() {
  const zone = els.imageDropZone;
  if (!zone) return;
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  zone.addEventListener('dragenter', (event) => {
    stop(event);
    zone.classList.add('is-dragover');
  });
  zone.addEventListener('dragover', (event) => {
    stop(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    zone.classList.add('is-dragover');
  });
  zone.addEventListener('dragleave', (event) => {
    stop(event);
    if (!event.relatedTarget || !zone.contains(event.relatedTarget)) {
      zone.classList.remove('is-dragover');
    }
  });
  zone.addEventListener('drop', async (event) => {
    stop(event);
    zone.classList.remove('is-dragover');
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      els.imageFile.files = transfer.files;
    } catch {
      /* The input is only for display; the dropped file is still loaded. */
    }
    await loadImageFile(file);
  });
}

function cancelFlash() {
  hideHidReconnectModal();
  if (!state.busy && !state.connecting) return;
  state.cancelRequested = true;
  state.transport?.cancelReconnect?.();
  if (state.connecting) {
    log('warn', 'Connection cancelled');
    return;
  }
  log('warn', 'Cancel requested; stopping after the current packet');
}

async function switchBootloaderBaud(transport, client, baud) {
  if (transport.kind !== 'serial' || transport.baudRate === baud) return client;

  setStatusDetail(`Switching bootloader UART to ${baud} bps...`, '');
  log('info', `Switching bootloader UART to ${baud} bps...`);

  try {
    await client.configRte(baud, 3000);
  } catch (error) {
    // The bootloader may change its UART before sending the response.
    log(
      'warn',
      `No response to bootloader baud switch; verifying at ${baud} bps: ${error.message}`,
    );
  }

  try {
    await transport.reopen(baud);
    const next = makeClient(transport);
    await next.getRomInfo(3000);
    state.client = next;
    setStatusDetail(`Bootloader · ${baud} bps`, '');
    return next;
  } catch (error) {
    log(
      'warn',
      `Bootloader did not respond at ${baud} bps; falling back to 115200: ${error.message}`,
    );
    await transport.reopen(115200);
    const fallback = makeClient(transport);
    await fallback.getRomInfo(3000);
    state.client = fallback;
    setStatusDetail('Bootloader · 115200 bps', '');
    log('info', 'Bootloader continues at 115200 bps');
    return fallback;
  }
}

async function configureFlashAccess(client) {
  const words = parseWordList(els.configWords.value);
  if (words.length !== 4) {
    throw new Error('Flash Configuration Words must contain exactly four 32-bit words');
  }
  const configBytes = wordsToBytes(words);
  log('info', `Using Flash Configuration Words: ${configWordsToText(words)}`);
  await client.writeMemory(MEM.ILM, 0x200, configBytes, () => {}, 10000);
  await client.configMemory(MEM.XPI0_NOR, 0x200);
}

async function sha256Hex(data) {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return bytesHex(new Uint8Array(digest), 32);
  } catch {
    return null;
  }
}

function downloadBytes(data, filename) {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function describeXpiMemory(info) {
  const end = info.startAddress + info.memorySize;
  const sector = info.sectorSize ? formatBytesCount(info.sectorSize) : 'unknown';
  return (
    `XPI0 NOR: ${hex0x(info.startAddress, 8)}–${hex0x((end - 1) >>> 0, 8)} · ` +
    `${formatBytesCount(info.memorySize)} · sector ${sector}`
  );
}

async function detectXpiMemory(client) {
  if (!client) throw new Error('Connect a device first');
  let info;
  try {
    info = await client.getMemoryProperties(MEM.XPI0_NOR, 3000);
  } catch (firstError) {
    // Some bootloader builds only report memory properties after XPI0 is configured.
    await configureFlashAccess(client);
    info = await client.getMemoryProperties(MEM.XPI0_NOR, 3000);
  }
  if (!info.memorySize) {
    throw new Error('XPI0 NOR reported an empty memory size');
  }
  return info;
}

function applyReadDetection(info) {
  detectedXpi = info;
  const maxRead = Math.min(info.memorySize, 16 * 1024 * 1024);
  els.readAddress.value = `0x${info.startAddress.toString(16)}`;
  els.readLength.value = `0x${maxRead.toString(16)}`;
  els.readDetectInfo.className = 'hpm-detect-info is-ok';
  els.readDetectInfo.textContent =
    describeXpiMemory(info) +
    (maxRead < info.memorySize ? ' · read limited to 16 MiB' : '');
  els.readStartBtn.disabled = false;
}

async function runReadDetection() {
  if (!state.client) return;
  detectedXpi = null;
  els.readDetectBtn.disabled = true;
  els.readStartBtn.disabled = true;
  els.readDetectInfo.className = 'hpm-detect-info';
  els.readDetectInfo.textContent = 'Detecting XPI0 NOR via query-rte 4...';
  try {
    const info = await detectXpiMemory(state.client);
    applyReadDetection(info);
  } catch (error) {
    els.readDetectInfo.className = 'hpm-detect-info is-error';
    els.readDetectInfo.textContent =
      `Detection failed: ${error.message} · using 0x80000000 + 1 MiB`;
    els.readAddress.value = '0x80000000';
    els.readLength.value = '0x100000';
    els.readStartBtn.disabled = false;
    log('warn', `Flash size detection failed: ${error.message}`);
  } finally {
    els.readDetectBtn.disabled = false;
  }
}

function openReadFlashDialog() {
  if (!state.transport || state.busy) return;
  detectedXpi = null;
  els.readAddress.value = '0x80000000';
  els.readLength.value = '0x100000';
  els.readStartBtn.disabled = true;
  els.readFlashModal.hidden = false;
  els.readCancelBtn.focus();
  runReadDetection();
}

function closeReadFlashDialog() {
  els.readFlashModal.hidden = true;
}

function computeEraseRange() {
  const requestedStart = parseU32(els.eraseAddress.value);
  const requestedLength = parseU32(els.eraseLength.value);
  if (requestedLength === 0) {
    throw new Error('Erase length must be greater than zero');
  }
  if (requestedStart + requestedLength > 0x100000000) {
    throw new Error('Erase range exceeds the 32-bit address space');
  }

  const info = detectedXpi;
  const sectorSize = (info && info.sectorSize) || 0x1000;
  const flashStart = info ? info.startAddress : requestedStart;
  const flashEnd = info
    ? info.startAddress + info.memorySize
    : requestedStart + requestedLength;

  let start = Math.floor(requestedStart / sectorSize) * sectorSize;
  let end = Math.ceil((requestedStart + requestedLength) / sectorSize) * sectorSize;
  if (info) {
    if (start < flashStart) start = flashStart;
    if (end > flashEnd) end = flashEnd;
  }
  if (end <= start) {
    throw new Error('Erase range is outside the detected XPI0 NOR area');
  }

  const length = end - start;
  return {
    start: start >>> 0,
    length: length >>> 0,
    sectorSize,
    full: !!info && start === info.startAddress && length === info.memorySize,
    requestedStart,
    requestedLength,
  };
}

function updateEraseRangeHint() {
  try {
    const range = computeEraseRange();
    els.eraseStartBtn.disabled = false;
    els.eraseRangeHint.className = 'hpm-erase-range-hint';
    if (range.full) {
      els.eraseRangeHint.classList.add('is-full');
      els.eraseRangeHint.textContent =
        `Full chip erase: start ${hex0x(range.start, 8)}, ` +
        `length ${hex0x(range.length, 8)} (${formatBytesCount(range.length)}).`;
    } else {
      let text =
        `Aligned to ${formatBytesCount(range.sectorSize)} sectors: ` +
        `start ${hex0x(range.start, 8)}, length ${hex0x(range.length, 8)} ` +
        `(${formatBytesCount(range.length)}).`;
      if (
        range.start !== range.requestedStart ||
        range.length !== range.requestedLength
      ) {
        text +=
          ` Input ${hex0x(range.requestedStart, 8)} + ` +
          `${hex0x(range.requestedLength, 8)} was aligned/clamped.`;
      }
      if (!detectedXpi) {
        text += ' Flash size detection failed; using the manual range.';
      }
      els.eraseRangeHint.textContent = text;
    }
  } catch (error) {
    els.eraseStartBtn.disabled = true;
    els.eraseRangeHint.className = 'hpm-erase-range-hint is-error';
    els.eraseRangeHint.textContent = error.message;
  }
}

function applyEraseDetection(info) {
  detectedXpi = info;
  els.eraseAddress.value = `0x${info.startAddress.toString(16)}`;
  els.eraseLength.value = `0x${info.memorySize.toString(16)}`;
  els.eraseDetectInfo.className = 'hpm-detect-info is-ok';
  els.eraseDetectInfo.textContent = describeXpiMemory(info);
  updateEraseRangeHint();
}

async function runEraseDetection() {
  if (!state.client) return;
  detectedXpi = null;
  els.eraseDetectBtn.disabled = true;
  els.eraseStartBtn.disabled = true;
  els.eraseDetectInfo.className = 'hpm-detect-info';
  els.eraseDetectInfo.textContent = 'Detecting XPI0 NOR via query-rte 4...';
  try {
    const info = await detectXpiMemory(state.client);
    applyEraseDetection(info);
  } catch (error) {
    els.eraseDetectInfo.className = 'hpm-detect-info is-error';
    els.eraseDetectInfo.textContent =
      `Detection failed: ${error.message} · enter the range manually`;
    els.eraseAddress.value = '0x80000000';
    els.eraseLength.value = '0x100000';
    updateEraseRangeHint();
    log('warn', `Flash size detection failed: ${error.message}`);
  } finally {
    els.eraseDetectBtn.disabled = false;
  }
}

function openEraseChipDialog() {
  if (!state.transport || state.busy) return;
  detectedXpi = null;
  els.eraseAddress.value = '0x80000000';
  els.eraseLength.value = '0x100000';
  els.eraseStartBtn.disabled = true;
  els.eraseTarget.textContent = `XPI0 NOR · ${els.socSelect.value || 'Unknown SoC'}`;
  els.eraseDetectInfo.className = 'hpm-detect-info';
  els.eraseDetectInfo.textContent = 'Detecting XPI0 NOR...';
  els.eraseRangeHint.className = 'hpm-erase-range-hint';
  els.eraseRangeHint.textContent = '';
  els.eraseChipModal.hidden = false;
  els.eraseCancelBtn.focus();
  runEraseDetection();
}

function closeEraseChipDialog() {
  els.eraseChipModal.hidden = true;
}

async function startReadFlash() {
  if (state.busy || !state.transport) return;

  let address;
  let length;
  try {
    address = parseU32(els.readAddress.value);
    length = parseU32(els.readLength.value);
    if (length === 0) throw new Error('Read length must be greater than zero');
    if (length > 16 * 1024 * 1024) {
      throw new Error('Read length is limited to 16 MiB in the browser tool');
    }
    if (address + length > 0x100000000) {
      throw new Error('Read range exceeds the 32-bit address space');
    }
  } catch (error) {
    log('error', `Invalid read range: ${error.message}`);
    return;
  }

  closeReadFlashDialog();
  state.cancelRequested = false;
  setBusy(true);
  setProgress(0, 'Preparing read...');

  try {
    const client = state.client || makeClient(state.transport);
    log(
      'info',
      `Reading ${formatBytesCount(length)} from ${hex0x(address, 8)} (XPI0 NOR)...`,
    );
    await configureFlashAccess(client);
    setProgress(1, 'Reading flash...');
    const data = await client.readMemory(
      MEM.XPI0_NOR,
      address,
      length,
      (done, total) => {
        setProgress(
          1 + (done / total) * 99,
          `Reading: ${formatBytesCount(done)} / ${formatBytesCount(total)}`,
        );
      },
      30000,
    );
    setProgress(100, 'Read complete');

    const digest = await sha256Hex(data);
    if (digest) log('info', `Read SHA-256: ${digest}`);
    const soc = (els.socSelect.value || 'hpm').toLowerCase();
    const filename =
      `${soc}_flash_0x${address.toString(16)}_0x${length.toString(16)}.bin`;
    downloadBytes(data, filename);
    log(
      'success',
      `Read complete: ${formatBytesCount(data.length)} from ${hex0x(address, 8)}`,
    );
    showLogSuccess(
      'Read complete',
      `${formatBytesCount(data.length)} read from ${hex0x(address, 8)}.`,
    );
  } catch (error) {
    if (state.cancelRequested || error instanceof AbortError) {
      log('warn', 'Read cancelled');
      setProgress(0, 'Cancelled');
    } else {
      log('error', `Read failed: ${error.message}`);
      if (error instanceof RomError && error.status !== null) {
        log('error', `ROM status: 0x${error.status.toString(16)}`);
      }
      setProgress(0, 'Read failed');
    }
  } finally {
    state.cancelRequested = false;
    setBusy(false);
  }
}

async function startEraseChip() {
  if (state.busy || !state.transport) return;

  let range;
  try {
    range = computeEraseRange();
  } catch (error) {
    log('error', `Invalid erase range: ${error.message}`);
    return;
  }

  closeEraseChipDialog();
  state.cancelRequested = false;
  setBusy(true, { cancellable: false, indeterminate: true });
  setIndeterminateProgress(
    range.full ? 'Erasing entire XPI0 NOR...' : 'Erasing selected XPI0 NOR range...',
  );

  try {
    const client = state.client || makeClient(state.transport);
    log(
      'warn',
      range.full
        ? `Erasing entire XPI0 NOR flash (${els.socSelect.value || 'unknown SoC'})...`
        : `Erasing XPI0 NOR ${hex0x(range.start, 8)} + ${hex0x(range.length, 8)} ` +
          `(${formatBytesCount(range.length)})...`,
    );
    await configureFlashAccess(client);
    const started = Date.now();
    if (range.full) {
      await client.eraseAll(MEM.XPI0_NOR, 180000);
    } else {
      await client.eraseRegion(MEM.XPI0_NOR, range.start, range.length, 180000);
    }
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    setProgress(100, 'Erase complete');
    log('success', `Erase complete (${elapsed}s)`);
    showLogSuccess(
      'Erase complete',
      range.full
        ? 'Entire XPI0 NOR flash has been erased.'
        : `${formatBytesCount(range.length)} erased from ${hex0x(range.start, 8)}.`,
    );
  } catch (error) {
    log('error', `Erase failed: ${error.message}`);
    if (error instanceof RomError && error.status !== null) {
      log('error', `ROM status: 0x${error.status.toString(16)}`);
    }
    setProgress(0, 'Erase failed');
  } finally {
    state.cancelRequested = false;
    setBusy(false);
  }
}

async function flash() {
  if (state.busy) return;
  if (!state.transport) {
    log('error', 'Connect a device first');
    return;
  }
  if (!state.image) {
    log('error', 'Select a valid image first');
    return;
  }
  if (!els.socSelect.value) {
    log('error', 'Select the SoC series before programming (used to load bl_fw)');
    return;
  }

  state.cancelRequested = false;
  state.flashSucceeded = false;
  hideLogSuccess();
  setBusy(true);
  setProgress(0, 'Preparing...');
  let client = state.client || makeClient(state.transport);
  const transport = state.transport;
  const image = state.image;

  try {
    log('info', '========== Programming started ==========');

    // 1. Probe the device.
    setProgress(1, 'Querying device...');
    await queryDeviceInfo(client);

    // Both transports normally load bl_fw at connect time. This is a
    // fallback for a HID session that lost its bootloader flag.
    let needLoad = false;
    if (transport.kind === 'hid' && !state.bootloaderReady) {
      const bootloaderState = await detectBootloaderFirmware(client, 3000);
      if (bootloaderState.known && bootloaderState.active) {
        state.bootloaderReady = true;
        state.verifySupported = bootloaderState.verifySupported !== false;
        log('info', 'HID bootloader firmware already loaded; skipping bl_fw load');
      } else {
        needLoad = true;
      }
    }

    if (needLoad) {
      const firmware = await getFirmware(els.socSelect.value);
      transport.resetInput?.();
      setProgress(2, `Loading bl_fw (${formatBytesCount(firmware.length)})...`);
      await client.loadImage(firmware, (done, total) => {
        setProgress(2 + (done / total) * 18, `Loading bl_fw: ${done}/${total}`);
      });

      setProgress(20, 'Waiting for USB re-enumeration...');
      state.reconnecting = true;
      updateUi();
      try {
        await transport.reconnectAfterReboot();
      } finally {
        hideHidReconnectModal();
        state.reconnecting = false;
        updateUi();
      }
      client = makeClient(transport);
      state.client = client;
      log('info', 'HID device reopened; continuing');

      setProgress(21, 'Waiting for bootloader...');
      await client.waitForBootloader(15000);
      state.bootloaderReady = true;
      state.verifySupported = true;
    } else if (transport.kind === 'serial') {
      log('info', `Bootloader is ready; starting programming at ${transport.baudRate} bps`);
    } else {
      log('info', 'Skipping bl_fw load');
    }

    // 3. Configure XPI NOR. The device config block is placed at ILM 0x200.
    setProgress(23, 'Writing Flash configuration words...');
    await client.writeMemory(MEM.ILM, 0x200, image.configBytes, () => {}, 10000);
    setProgress(25, 'Configuring XPI NOR...');
    await client.configMemory(MEM.XPI0_NOR, 0x200);

    // 4. Write the image.
    setProgress(26, 'Writing image...');
    await client.writeMemory(
      MEM.XPI0_NOR,
      image.address,
      image.imageData,
      (done, total) => {
        setProgress(26 + (done / total) * 64, `Writing image: ${done}/${total}`);
      },
      30000,
    );

    // 5. Verify. Use the ROM verify command when available; otherwise read
    // the flash back and compare it byte-for-byte in the browser.
    if (els.verifyAfter.checked) {
      if (state.verifySupported) {
        setProgress(92, 'Verifying SHA-256...', 'verify');
        await client.verifyChecksum(MEM.XPI0_NOR, image.address, image.imageData, 60000);
      } else {
        log(
          'info',
          'verify-checksum is unavailable; reading back the written flash for verification...',
        );
        setProgress(92, 'Reading back for verification...', 'verify');
        const readback = await client.readMemory(
          MEM.XPI0_NOR,
          image.address,
          image.imageData.length,
          (done, total) => {
            setProgress(
              92 + (done / total) * 6,
              `Verifying read-back: ${formatBytesCount(done)} / ${formatBytesCount(total)}`,
              'verify',
            );
          },
          60000,
        );
        const expectedDigest = await sha256Hex(image.imageData);
        const readbackDigest = await sha256Hex(readback);
        if (expectedDigest && readbackDigest && expectedDigest === readbackDigest) {
          log('info', `Read-back SHA-256: ${readbackDigest}`);
          setProgress(98, 'Read-back verification passed', 'verify');
          log('success', 'Read-back verification passed');
        } else {
          // Hash mismatch (or hashing unavailable): locate the first byte
          // difference so the user knows where programming failed.
          let mismatch = -1;
          for (let index = 0; index < readback.length; index += 1) {
            if (readback[index] !== image.imageData[index]) {
              mismatch = index;
              break;
            }
          }
          if (mismatch >= 0) {
            throw new Error(
              `Read-back verification failed at ${hex0x(image.address + mismatch, 8)} ` +
                `(expected 0x${image.imageData[mismatch].toString(16).padStart(2, '0')}, ` +
                `got 0x${readback[mismatch].toString(16).padStart(2, '0')})`,
            );
          }
          if (expectedDigest && readbackDigest) {
            throw new Error(
              `Read-back SHA-256 mismatch (expected ${expectedDigest}, got ${readbackDigest})`,
            );
          }
          // SHA-256 is unavailable but the byte comparison passed.
          setProgress(98, 'Read-back verification passed', 'verify');
          log('success', 'Read-back verification passed (byte comparison)');
        }
      }
    }

    // 6. Reset.
    if (els.resetAfter.checked) {
      setProgress(98, 'Resetting device...');
      try {
        await client.reset(0);
      } catch (error) {
        log('warn', `No response to reset (device may already have reset): ${error.message}`);
      }
    }

    state.flashSucceeded = true;
    setProgress(100, 'Programming complete');
    log('success', '========== Programming complete ==========');
    showLogSuccess(
      'Programming complete',
      els.verifyAfter.checked
        ? state.verifySupported
          ? 'Image written and verified successfully.'
          : 'Image written and read-back verified successfully.'
        : 'Image written successfully.',
    );
  } catch (error) {
    if (state.cancelRequested || error instanceof AbortError) {
      log('warn', 'Programming cancelled');
      setProgress(0, 'Cancelled');
    } else {
      log('error', `Programming failed: ${error.message}`);
      if (error instanceof RomError && error.status !== null) {
        log('error', `ROM status: 0x${error.status.toString(16)}`);
      }
      if (els.debugLog.checked && error.stack) {
        log('debug', error.stack);
      }
      setProgress(0, 'Programming failed');
    }
  } finally {
    state.reconnecting = false;
    state.cancelRequested = false;
    setBusy(false);
  }
}

function checkBrowserSupport() {
  const hasSerial = !!navigator.serial;
  const hasHid = !!navigator.hid;
  const secure = isSecureContextOk();
  const messages = [];

  if (!hasSerial && !hasHid) {
    messages.push(
      'This browser does not support Web Serial / WebHID. Use desktop Chrome, Edge, or Opera.',
    );
  } else if (!hasSerial) {
    messages.push('Web Serial is not supported; UART programming is unavailable.');
  } else if (!hasHid) {
    messages.push('WebHID is not supported; USB-HID programming is unavailable.');
  }
  if (!secure) {
    messages.push(
      'This page is not a secure context. Open it via https:// or http://localhost, not by double-clicking the HTML file.',
    );
  }
  if (location.protocol === 'file:') {
    messages.push('file:// access detected. Serve the folder with a local HTTP server and open it via localhost.');
  }

  if (messages.length > 0) {
    els.warningBanner.hidden = false;
    els.warningBanner.textContent = messages.join(' ');
    els.browserBadge.textContent = 'Browser limited';
    els.browserBadge.className = 'badge bad';
  } else {
    els.browserBadge.textContent = 'Web Serial + WebHID available';
    els.browserBadge.className = 'badge ok';
  }
}

function init() {
  checkBrowserSupport();

  els.transportSelect.addEventListener('change', () => {
    if (state.transport) {
      log('warn', 'Changing the interface does not disconnect the current device; click Disconnect first');
    } else if (!state.connecting) {
      setStatusDetail('', '');
    }
    updateUi();
  });

  els.connectBtn.addEventListener('click', () => {
    if (state.transport) return disconnectDevice();
    return connectDevice();
  });
  els.hidReconnectModalBtn.addEventListener('click', reconnectHid);
  els.hidReconnectCancelBtn.addEventListener('click', cancelFlash);
  els.hidReconnectCloseBtn.addEventListener('click', cancelFlash);

  els.configGearBtn.addEventListener('click', (event) => {
    event.preventDefault();
    openFlashConfigDialog();
  });
  els.flashConfigCloseBtn.addEventListener('click', closeFlashConfigDialog);
  els.flashConfigCancelBtn.addEventListener('click', closeFlashConfigDialog);
  els.flashConfigApplyBtn.addEventListener('click', applyFlashConfig);
  els.flashConfigModal.addEventListener('click', (event) => {
    if (event.target === els.flashConfigModal) closeFlashConfigDialog();
  });
  els.flashConfigPreset.addEventListener('change', () => {
    const preset = FLASH_CONFIG_PRESETS[els.flashConfigPreset.value];
    if (preset) setFlashConfigForm(decodeFlashConfig(preset));
  });
  els.cfgCustomEnabled.addEventListener('change', () => {
    setConfigFieldsEnabled(els.cfgCustomEnabled.checked);
    if (els.cfgCustomEnabled.checked) updateFlashConfigPreview();
  });
  for (const id of CONFIG_FIELD_IDS) {
    const field = els[id];
    if (!field) continue;
    const markCustom = () => {
      els.flashConfigPreset.value = 'custom';
      updateFlashConfigPreview();
    };
    field.addEventListener('change', markCustom);
    if (field.type === 'number') field.addEventListener('input', markCustom);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (els.flashConfigModal && !els.flashConfigModal.hidden) {
      closeFlashConfigDialog();
    } else if (els.readFlashModal && !els.readFlashModal.hidden) {
      closeReadFlashDialog();
    } else if (els.eraseChipModal && !els.eraseChipModal.hidden) {
      closeEraseChipDialog();
    }
  });

  els.imageType.addEventListener('change', onImageTypeChange);
  els.imageFile.addEventListener('change', onImageFileChange);
  initImageDropZone();
  els.socSelect.addEventListener('change', updateUi);
  els.configWords.addEventListener('change', refreshImage);
  els.address.addEventListener('change', refreshImage);

  els.debugLog.addEventListener('change', () => {
    if (state.transport) state.transport.debug = els.debugLog.checked;
    if (state.client) state.client.debug = els.debugLog.checked;
  });

  els.readFlashBtn.addEventListener('click', openReadFlashDialog);
  els.eraseChipBtn.addEventListener('click', openEraseChipDialog);
  els.readFlashCloseBtn.addEventListener('click', closeReadFlashDialog);
  els.readCancelBtn.addEventListener('click', closeReadFlashDialog);
  els.readDetectBtn.addEventListener('click', runReadDetection);
  els.readStartBtn.addEventListener('click', startReadFlash);
  els.readFlashModal.addEventListener('click', (event) => {
    if (event.target === els.readFlashModal) closeReadFlashDialog();
  });
  els.eraseChipCloseBtn.addEventListener('click', closeEraseChipDialog);
  els.eraseCancelBtn.addEventListener('click', closeEraseChipDialog);
  els.eraseDetectBtn.addEventListener('click', runEraseDetection);
  els.eraseAddress.addEventListener('input', updateEraseRangeHint);
  els.eraseLength.addEventListener('input', updateEraseRangeHint);
  els.eraseStartBtn.addEventListener('click', startEraseChip);
  els.eraseChipModal.addEventListener('click', (event) => {
    if (event.target === els.eraseChipModal) closeEraseChipDialog();
  });
  els.flashBtn.addEventListener('click', flash);
  els.cancelBtn.addEventListener('click', cancelFlash);
  els.clearLogBtn.addEventListener('click', () => {
    els.log.textContent = '';
    state.logCount = 0;
    hideLogSuccess();
  });
  els.logSuccessClose.addEventListener('click', hideLogSuccess);

  if (navigator.hid) {
    navigator.hid.addEventListener('disconnect', (event) => {
      if (state.transport?.kind === 'hid' && state.transport.device === event.device) {
        if (state.busy || state.connecting || state.reconnecting) {
          log('debug', 'HID disconnected during an active operation; waiting for re-enumeration');
          return;
        }
        if (state.flashSucceeded) {
          log('info', 'HID disconnected after reset/re-enumeration (normal)');
        } else {
          log('warn', 'HID device disconnected');
        }
        state.transport = null;
        state.client = null;
        state.bootloaderReady = false;
        state.verifySupported = true;
        setStatusDetail('', '');
        updateUi();
      }
    });
  }

  if (navigator.serial) {
    navigator.serial.addEventListener('disconnect', (event) => {
      if (state.transport?.kind === 'serial' && state.transport.port === event.target) {
        if (state.connecting || state.reconnecting) {
          log('debug', 'Serial disconnected while connecting; ignoring');
          return;
        }
        log('warn', 'Serial device disconnected');
        if (!state.busy) {
          state.transport = null;
          state.client = null;
          state.bootloaderReady = false;
          state.verifySupported = true;
          setStatusDetail('', '');
          updateUi();
        }
      }
    });
  }

  updateUi();
  log('info', 'HPM ISP Flasher ready');
  log(
    'info',
    'Make sure the device is in ISP/serial download mode and close other tools that may be using it (e.g. hpm_manufacturing_gui).',
  );
}

init();
