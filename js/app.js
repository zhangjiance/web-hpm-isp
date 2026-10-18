import { MEM } from './protocol.js';
import { RomClient } from './rom-client.js';
import { HidTransport, SerialTransport } from './transports.js';
import { detectImageLayout, parseImage, readFileBytes, configWordsToText } from './image.js';
import {
  AbortError,
  RomError,
  TimeoutError,
  TransportError,
  formatBytesCount,
  hex0x,
  isSecureContextOk,
  parseNumber,
  parseU32,
  parseWordList,
} from './util.js';

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
  browserBadge: $('browserBadge'),
  warningBanner: $('warningBanner'),
  transportSelect: $('transportSelect'),
  baudField: $('baudField'),
  hidOptions: $('hidOptions'),
  serialBaud: $('serialBaud'),
  hidAllDevices: $('hidAllDevices'),
  connectBtn: $('connectBtn'),
  hidReconnectModal: $('hidReconnectModal'),
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
  cancelBtn: $('cancelBtn'),
  log: $('log'),
  logSuccess: $('logSuccess'),
  logSuccessDetail: $('logSuccessDetail'),
  logSuccessClose: $('logSuccessClose'),
  debugLog: $('debugLog'),
  clearLogBtn: $('clearLogBtn'),
};

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

function showLogSuccess(detail) {
  if (!els.logSuccess) return;
  if (els.logSuccessDetail) els.logSuccessDetail.textContent = detail || '';
  els.logSuccess.hidden = false;
}

function hideLogSuccess() {
  if (els.logSuccess) els.logSuccess.hidden = true;
}

function setImageFileName(name) {
  if (!els.imageFileName) return;
  els.imageFileName.textContent = name || 'No file selected';
  els.imageFileName.classList.toggle('has-file', !!name);
}

function setProgress(percent, text) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  els.progressBar.style.width = `${value}%`;
  els.percentText.textContent = `${value}%`;
  if (text) els.progressText.textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  if (els.progressSection) els.progressSection.hidden = !busy;
  if (els.cancelBtn) els.cancelBtn.hidden = !busy;
  updateUi();
}

function showHidReconnectModal() {
  if (!els.hidReconnectModal) return;
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
  return [{ vendorId: 0x34b7 }];
}

function updateUi() {
  const isHid = getTransportType() === 'hid';
  const connected = !!state.transport;
  const locked = state.busy || connected || state.connecting;

  // UART needs a baud rate; HID needs the optional broad endpoint filter.
  els.baudField.hidden = isHid;
  els.hidOptions.hidden = !isHid;

  els.connectBtn.disabled = state.busy || state.connecting || !els.socSelect.value;
  els.connectBtn.textContent = state.connecting
    ? 'Connecting...'
    : connected
      ? 'Disconnect'
      : 'Connect';
  els.connectBtn.className = connected ? 'danger' : 'primary';
  els.transportSelect.disabled = locked;
  els.socSelect.disabled = locked;
  els.serialBaud.disabled = locked;
  els.hidAllDevices.disabled = locked;
  els.flashBtn.disabled = state.busy || !connected || !state.image;
  els.flashBtn.title = state.busy
    ? 'Programming in progress'
    : state.connecting
      ? 'Connecting to device...'
      : !connected
        ? 'Connect a device first'
        : !state.image
          ? 'Select an image first'
          : 'Program the selected image';
  els.cancelBtn.disabled = !state.busy;

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
      `ROM: version=0x${info.romVersion.toString(16)} ` +
        `revision=0x${info.socRevision.toString(16)} ` +
        `lifeCycle=${info.lifeCycle} features=0x${info.features.toString(16)}`,
    );
  } catch (error) {
    log('warn', `Failed to query ROM info (device may not be in ISP mode): ${error.message}`);
  }
  try {
    const mask = await client.getSupportedCommands(3000);
    log('info', `Supported command mask: ${hex0x(mask, 8)}`);
  } catch (error) {
    log('debug', `Failed to query supported commands: ${error.message}`);
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

    // Load bl_fw immediately: it is a RAM image and does not depend on the
    // user's Flash image or configuration words.
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

    const activeBaud = transport.baudRate;
    state.transport = transport;
    state.client = client;
    state.bootloaderReady = true;
    state.connecting = false;
    setStatusDetail(`Bootloader · ${activeBaud} bps`, '');
    log('success', `Bootloader connected at ${activeBaud} bps`);
    updateUi();
    await queryDeviceInfo(client);
  } catch (error) {
    log('error', `Serial connection failed: ${error.message}`);
    state.connecting = false;
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
    state.transport = transport;
    state.client = makeClient(transport);
    state.bootloaderReady = false;
    state.connecting = false;
    setStatusDetail(
      `${device.productName || 'HID device'} · ` +
        `0x${device.vendorId.toString(16)}:0x${device.productId.toString(16)}`,
    );
    log('success', `HID connected: VID=0x${device.vendorId.toString(16)} PID=0x${device.productId.toString(16)}`);
    updateUi();
    await queryDeviceInfo(state.client);
  } catch (error) {
    log('error', `HID connection failed: ${error.message}`);
    state.connecting = false;
    setStatusDetail(`Connection failed: ${error.message}`, 'error');
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
  const filters = transport.isReconnecting
    ? [{ vendorId: transport.vid }]
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
  if (!state.transport) return;
  const transport = state.transport;
  state.transport = null;
  state.client = null;
  state.bootloaderReady = false;
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
  if (!state.busy) return;
  state.cancelRequested = true;
  state.transport?.cancelReconnect?.();
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

    // Serial connections already loaded bl_fw at connect time. USB-HID still
    // loads it here because the device re-enumerates and needs user permission.
    let needLoad = false;
    if (transport.kind === 'hid' && !state.bootloaderReady) {
      needLoad = true;
      try {
        const mask = await client.getSupportedCommands(3000);
        if ((mask & (1 << 6)) === 0) {
          needLoad = false;
          log('info', 'Device does not support Load Image; assuming bl_fw is already loaded');
        }
      } catch (error) {
        log('warn', `Cannot query supported commands; trying to load bl_fw: ${error.message}`);
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

    // 5. Verify.
    if (els.verifyAfter.checked) {
      setProgress(92, 'Verifying SHA-256...');
      await client.verifyChecksum(MEM.XPI0_NOR, image.address, image.imageData, 60000);
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
      els.verifyAfter.checked
        ? 'Image written and verified successfully.'
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
    if (event.key === 'Escape' && els.flashConfigModal && !els.flashConfigModal.hidden) {
      closeFlashConfigDialog();
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
        if (state.busy) {
          log('debug', 'HID disconnected during programming; waiting for re-enumeration');
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
        setStatusDetail('', '');
        updateUi();
      }
    });
  }

  if (navigator.serial) {
    navigator.serial.addEventListener('disconnect', (event) => {
      if (state.transport?.kind === 'serial' && state.transport.port === event.target) {
        log('warn', 'Serial device disconnected');
        if (!state.busy) {
          state.transport = null;
          state.client = null;
          state.bootloaderReady = false;
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
