import { crc16 } from './crc16.js';
import { buildHidReport, buildSerialFrame, MAX_PACKAGE_SIZE } from './protocol.js';
import { bytesHex, concatBytes, delay, AbortError, TimeoutError, TransportError } from './util.js';

/**
 * A small byte queue with a timeout-aware readExactly().
 * Used by the UART transport because Web Serial is stream based.
 */
export class ByteQueue {
  constructor() {
    this.data = new Uint8Array(0);
    this.waiters = new Set();
    this.closed = false;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.data = concatBytes(this.data, chunk);
    this._wake();
  }

  clear() {
    this.data = new Uint8Array(0);
  }

  close() {
    this.closed = true;
    this._wake();
  }

  _wake() {
    for (const wake of [...this.waiters]) wake();
    this.waiters.clear();
  }

  async readExactly(count, timeoutMs, label = 'data') {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.data.length >= count) {
        const result = this.data.slice(0, count);
        this.data = this.data.slice(count);
        return result;
      }
      if (this.closed) {
        throw new TransportError('Transport closed');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new TimeoutError(`Timed out waiting for ${label} (${timeoutMs} ms)`);
      }
      await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          this.waiters.delete(wake);
          resolve();
        }, remaining);
        const wake = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      });
    }
  }
}

/** Queue of HID input reports. */
export class ReportQueue {
  constructor() {
    this.items = [];
    this.waiters = new Set();
    this.closed = false;
  }

  push(item) {
    this.items.push(item);
    this._wake();
  }

  clear() {
    this.items = [];
  }

  close() {
    this.closed = true;
    this._wake();
  }

  _wake() {
    for (const wake of [...this.waiters]) wake();
    this.waiters.clear();
  }

  async read(timeoutMs, label = 'HID report') {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.items.length > 0) {
        return this.items.shift();
      }
      if (this.closed) {
        throw new TransportError('HID device closed');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new TimeoutError(`Timed out waiting for ${label} (${timeoutMs} ms)`);
      }
      await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          this.waiters.delete(wake);
          resolve();
        }, remaining);
        const wake = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      });
    }
  }
}

function ackStatusFromByte(value) {
  if (value === 0xa1) return 0;
  if (value === 0xa2) return 1;
  if (value === 0xa3) return 2;
  return -1;
}

/**
 * Web Serial transport.
 *
 * Frame: 5A A5 <len_lo> <len_hi> <payload> <crc_lo> <crc_hi>
 * Device ACK: 5A A1 / 5A A2 / 5A A3
 */
export class SerialTransport {
  static async requestPort() {
    if (!navigator.serial) throw new Error('Web Serial is not supported in this browser');
    return navigator.serial.requestPort();
  }

  constructor(port, options = {}) {
    this.port = port;
    this.baudRate = options.baudRate || 115200;
    this.log = options.log || (() => {});
    this.debug = options.debug || false;
    this.queue = new ByteQueue();
    this.reader = null;
    this.writer = null;
    this.readLoopPromise = null;
    this.closing = false;
    this.kind = 'serial';
  }

  async open() {
    this.closing = false;
    await this.port.open({
      baudRate: this.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readLoopPromise = this._readLoop();
    // Discard any stale bytes left by a previous session.
    await delay(150);
    this.queue.clear();
    this.log('info', `Serial port opened at ${this.baudRate} bps`);
  }

  async reopen(baudRate) {
    await this.close();
    this.baudRate = baudRate;
    this.queue = new ByteQueue();
    this.closing = false;
    await this.open();
  }

  async _readLoop() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) {
          this.queue.push(value);
          if (this.debug) this.log('debug', `RX ${value.length}B: ${bytesHex(value)}`);
        }
      }
    } catch (error) {
      if (!this.closing) this.log('warn', `Serial read loop ended: ${error.message}`);
    } finally {
      this.queue.close();
    }
  }

  async send(payload, timeoutMs = 10000) {
    if (payload.length > MAX_PACKAGE_SIZE) {
      throw new TransportError(`Packet too large: ${payload.length} > ${MAX_PACKAGE_SIZE}`);
    }
    const frame = buildSerialFrame(payload);
    if (this.debug) this.log('debug', `TX ${frame.length}B: ${bytesHex(frame)}`);
    try {
      await this.writer.write(frame);
    } catch (error) {
      throw new TransportError(`Serial write failed: ${error.message}`);
    }
    const deadline = Date.now() + timeoutMs;
    let status = -1;
    let ackBytes = null;
    while (status < 0) {
      const first = await this.queue.readExactly(
        1,
        Math.max(1, deadline - Date.now()),
        'serial ACK',
      );
      if (first[0] !== 0x5a) {
        if (this.debug) {
          this.log('debug', `Discarding serial byte before ACK: 0x${first[0].toString(16)}`);
        }
        continue;
      }
      const second = await this.queue.readExactly(
        1,
        Math.max(1, deadline - Date.now()),
        'serial ACK status',
      );
      status = ackStatusFromByte(second[0]);
      if (status >= 0) {
        ackBytes = concatBytes(first, second);
        break;
      }
      if (this.debug) {
        this.log('debug', `Invalid serial ACK status, discarding: 0x${second[0].toString(16)}`);
      }
    }
    if (this.debug) this.log('debug', `RX ACK: ${bytesHex(ackBytes)}`);
    return status;
  }

  async receive(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let header = null;
    while (!header) {
      const first = await this.queue.readExactly(
        1,
        Math.max(1, deadline - Date.now()),
        'serial response header',
      );
      if (first[0] !== 0x5a) {
        if (this.debug) {
          this.log('debug', `Discarding serial byte before response header: 0x${first[0].toString(16)}`);
        }
        continue;
      }
      const rest = await this.queue.readExactly(
        3,
        Math.max(1, deadline - Date.now()),
        'serial response header',
      );
      if (rest[0] === 0xa5) {
        header = concatBytes(first, rest);
      } else if (this.debug) {
        this.log('debug', `Invalid serial response marker, discarding: ${bytesHex(concatBytes(first, rest))}`);
      }
    }
    const length = header[2] | (header[3] << 8);
    if (length > MAX_PACKAGE_SIZE) {
      throw new TransportError(`Invalid serial response length: ${length}`);
    }
    const tail = await this.queue.readExactly(
      length + 2,
      Math.max(1, deadline - Date.now()),
      'serial response data',
    );
    const payload = tail.slice(0, length);
    const expected = (tail[length] | (tail[length + 1] << 8)) & 0xffff;
    const actual = crc16(concatBytes(header, payload));
    if (actual !== expected) {
      this.log('error', `Serial response CRC error: calculated 0x${actual.toString(16)}, received 0x${expected.toString(16)}`);
      await this._sendResponse(0xa2);
      throw new TransportError('Serial response CRC check failed');
    }
    if (this.debug) {
      this.log('debug', `RX ${payload.length}B: ${bytesHex(payload)}`);
    }
    await this._sendResponse(0xa1);
    return payload;
  }

  async _sendResponse(status) {
    const response = new Uint8Array([0x5a, status & 0xff]);
    if (this.debug) this.log('debug', `TX ACK: ${bytesHex(response)}`);
    try {
      await this.writer.write(response);
    } catch (error) {
      throw new TransportError(`Serial ACK send failed: ${error.message}`);
    }
  }

  resetInput() {
    this.queue.clear();
  }

  async close() {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      await this.readLoopPromise;
    } catch {
      /* ignore */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await this.port.close();
    } catch {
      /* ignore */
    }
    this.queue.close();
  }
}

/**
 * WebHID transport.
 *
 * Output report ID 1: A5 <len_lo> <len_hi> <payload>
 * Input report ID 2:  A1/A2/A3 ... for ACK, A5 <len> <payload> for data
 * Host response:      report ID 1, data A1 00 00
 */
export class HidTransport {
  static async requestDevice(filters) {
    if (!navigator.hid) throw new Error('WebHID is not supported in this browser');
    return navigator.hid.requestDevice({ filters });
  }

  constructor(device, options = {}) {
    this.device = device;
    this.vid = device.vendorId;
    this.pid = device.productId;
    this.log = options.log || (() => {});
    this.debug = options.debug || false;
    this.onReconnectNeeded = options.onReconnectNeeded || (() => {});
    this.queue = new ReportQueue();
    this.inputReportId = 2;
    this.outputReportId = 1;
    this.inputReportBytes = 515;
    this.outputReportBytes = 515;
    this._inputHandler = (event) => {
      if (event.device !== this.device) return;
      const data = new Uint8Array(
        event.data.buffer,
        event.data.byteOffset,
        event.data.byteLength,
      ).slice();
      if (this.debug) {
        this.log('debug', `RX report ${event.reportId} ${data.length}B: ${bytesHex(data)}`);
      }
      this.queue.push({ reportId: event.reportId, data });
    };
    this._reconnectInProgress = false;
    this._userSelectedDevice = null;
    this._reconnectCancelled = false;
    this.kind = 'hid';
  }

  get isReconnecting() {
    return this._reconnectInProgress;
  }

  async open() {
    if (!this.device.opened) {
      await this.device.open();
    }
    this._detectReports();
    this.device.removeEventListener('inputreport', this._inputHandler);
    this.device.addEventListener('inputreport', this._inputHandler);
    this.queue.clear();
    const collections = (this.device.collections || [])
      .map((item) => `0x${item.usagePage.toString(16)}/0x${item.usage.toString(16)}`)
      .join(', ');
    if (this.debug && collections) {
      this.log('debug', `HID collections: ${collections}`);
    }
    this.log(
      'info',
      `HID opened: ${this.device.productName || '(unnamed)'} ` +
        `VID=0x${this.vid.toString(16)} PID=0x${this.pid.toString(16)} ` +
        `OUT report=${this.outputReportId}/${this.outputReportBytes}B ` +
        `IN report=${this.inputReportId}/${this.inputReportBytes}B`,
    );
  }

  _detectReports() {
    let output = null;
    let input = null;
    for (const collection of this.device.collections || []) {
      for (const report of collection.outputReports || []) {
        if (!output || report.reportId === 1) output = report;
      }
      for (const report of collection.inputReports || []) {
        if (!input || report.reportId === 2) input = report;
      }
    }
    const reportBits = (report) =>
      (report?.items || []).reduce(
        (sum, item) => sum + (item.reportSize || 0) * (item.reportCount || 0),
        0,
      );
    if (output) {
      this.outputReportId = output.reportId;
      this.outputReportBytes = Math.ceil(reportBits(output) / 8);
    }
    if (input) {
      this.inputReportId = input.reportId;
      this.inputReportBytes = Math.ceil(reportBits(input) / 8);
    }
    if (!output || !input) {
      this.log('warn', 'Could not identify reports in the HID descriptor; using default IDs 1/2 and 515-byte reports');
      this.outputReportId = 1;
      this.inputReportId = 2;
      this.outputReportBytes = 515;
      this.inputReportBytes = 515;
    } else if (this.outputReportBytes < MAX_PACKAGE_SIZE) {
      this.log(
        'warn',
        `HID output report is only ${this.outputReportBytes} bytes; a 512-byte packet may not fit`,
      );
    }
  }

  async _sendReport(data) {
    let report = data;
    if (this.outputReportBytes > 0 && report.length < this.outputReportBytes) {
      report = new Uint8Array(this.outputReportBytes);
      report.set(data);
    }
    if (this.outputReportBytes > 0 && report.length > this.outputReportBytes) {
      throw new TransportError(
        `HID output report too small: need ${report.length}, descriptor has ${this.outputReportBytes}`,
      );
    }
    if (this.debug) {
      this.log('debug', `TX report ${this.outputReportId} ${report.length}B: ${bytesHex(report)}`);
    }
    try {
      await this.device.sendReport(this.outputReportId, report);
    } catch (error) {
      throw new TransportError(`HID write failed: ${error.message}`);
    }
  }

  async send(payload, timeoutMs = 10000) {
    await this._sendReport(buildHidReport(payload));
    const report = await this.queue.read(timeoutMs, 'HID ACK');
    const status = ackStatusFromByte(report.data[0]);
    if (status < 0) {
      throw new TransportError(`Unknown HID ACK status: 0x${report.data[0].toString(16)}`);
    }
    return status;
  }

  async receive(timeoutMs = 10000) {
    for (;;) {
      const report = await this.queue.read(timeoutMs, 'HID response');
      const data = report.data;
      if (data.length === 0) continue;
      if (data[0] === 0xa1 || data[0] === 0xa2 || data[0] === 0xa3) {
        // A stray ACK; ignore it and keep waiting for the response package.
        continue;
      }
      if (data[0] !== 0xa5) {
        throw new TransportError(`Invalid HID response start byte: 0x${data[0].toString(16)}`);
      }
      if (data.length < 3) {
        throw new TransportError('HID response length field is incomplete');
      }
      const length = data[1] | (data[2] << 8);
      if (length > MAX_PACKAGE_SIZE) {
        throw new TransportError(`Invalid HID response length: ${length}`);
      }
      if (data.length < 3 + length) {
        throw new TransportError(
          `Incomplete HID response data: need ${length}, got ${data.length - 3}`,
        );
      }
      const payload = data.slice(3, 3 + length);
      if (this.debug) this.log('debug', `RX ${payload.length}B: ${bytesHex(payload)}`);
      await this._sendReport(new Uint8Array([0xa1, 0, 0]));
      return payload;
    }
  }

  async close() {
    this.cancelReconnect('Device disconnected');
    this.device.removeEventListener('inputreport', this._inputHandler);
    this.queue.close();
    try {
      await this.device.close();
    } catch {
      /* ignore */
    }
  }

  resetInput() {
    this.queue.clear();
  }

  /**
   * Wait until the old HIDDevice object is no longer reported by getDevices().
   * After a firmware reboot the browser usually creates a new HIDDevice object,
   * so object identity is a reliable way to avoid reopening the old interface.
   */
  async _waitForDeviceRemoval(device, timeoutMs = 3000) {
    if (!device || !navigator.hid) {
      await delay(500);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const devices = await navigator.hid.getDevices();
        if (!devices.includes(device)) return;
      } catch {
        return;
      }
      await delay(200);
    }
  }

  /**
   * Wait for the device to re-enumerate after loading the bootloader firmware.
   *
   * The ROM and the bootloader are different WebHID devices, so Chrome asks
   * for a new permission grant. As soon as the old interface disappears we
   * show the UI prompt; the user can select Boot Firmware Open immediately.
   * A background poll still auto-connects if the device was already granted.
   */
  async reconnectAfterReboot(timeoutMs = 5 * 60 * 1000) {
    const vid = this.vid;
    const pid = this.pid;
    const oldDevice = this.device;
    this._reconnectInProgress = true;
    this._userSelectedDevice = null;
    this._reconnectCancelled = false;
    this.device.removeEventListener('inputreport', this._inputHandler);
    try {
      await this.device.close();
    } catch {
      /* ignore */
    }
    this.queue.close();
    this.log('info', 'Waiting for HID re-enumeration...');

    try {
      // Wait until the old ROM interface is gone; this is usually quick.
      await this._waitForDeviceRemoval(oldDevice, 2000);
      await delay(300);

      // Give an already-authorized device one immediate chance. On later
      // flashes Chrome may still remember the Boot Firmware permission.
      let device = await this._findReenumeratedDevice(vid, pid, oldDevice);
      if (!device) {
        // Prompt right away instead of waiting 20 seconds.
        this.onReconnectNeeded();
        this.log(
          'warn',
          'Device re-enumerated. Select Boot Firmware Open in the dialog ' +
            '(VID 0x34b7 / PID 0x0005); if it is not listed yet, wait 1-2 seconds and try again.',
        );
      }

      const deadline = Date.now() + timeoutMs;
      while (!device) {
        if (this._reconnectCancelled) {
          throw new AbortError('Cancelled waiting for HID device');
        }
        if (Date.now() > deadline) {
          throw new TransportError('Timed out waiting for HID device to reconnect');
        }
        if (this._userSelectedDevice) {
          device = this._userSelectedDevice;
          break;
        }
        device = await this._findReenumeratedDevice(vid, pid, oldDevice);
        if (!device) await delay(500);
      }

      if (this._userSelectedDevice) {
        device = this._userSelectedDevice;
      }

      this.device = device;
      this.vid = device.vendorId;
      this.pid = device.productId;
      this.queue = new ReportQueue();
      await this.open();
      // Give the freshly enumerated firmware a moment before the first command.
      await delay(300);
      this.log('info', 'HID device reconnected');
    } finally {
      this._reconnectInProgress = false;
      this._userSelectedDevice = null;
    }
  }

  async _findReenumeratedDevice(vid, pid, oldDevice) {
    try {
      const devices = await navigator.hid.getDevices();
      const candidates = devices.filter((item) => item.vendorId === vid);
      return (
        candidates.find((item) => item.productId === pid && item !== oldDevice) ||
        candidates.find((item) => item !== oldDevice) ||
        null
      );
    } catch {
      return null;
    }
  }

  cancelReconnect(message = 'Cancelled waiting for HID device') {
    this._reconnectCancelled = true;
  }

  /** Called by the UI after the user selects a device again. */
  async useDevice(device) {
    if (this._reconnectInProgress) {
      this._userSelectedDevice = device;
      return;
    }
    try {
      await this.device.close();
    } catch {
      /* ignore */
    }
    this.device = device;
    this.vid = device.vendorId;
    this.pid = device.productId;
    this.queue = new ReportQueue();
    await this.open();
  }
}
