import {
  buildConfigMemory,
  buildConfigRte,
  buildEraseAll,
  buildEraseRegion,
  buildLoadImageChunk,
  buildQueryRte,
  buildReset,
  buildVerifyChecksum,
  buildWriteMemoryContinuation,
  buildWriteMemoryFirst,
  LOAD_IMAGE_CHUNK,
  parseResponse,
  readU32,
  statusMessage,
  WRITE_FIRST_CHUNK,
  WRITE_NEXT_CHUNK,
} from './protocol.js';
import {
  AbortError,
  RomError,
  TimeoutError,
  TransportError,
  bytesHex,
  delay,
} from './util.js';

const DEFAULT_TIMEOUT = 10000;

export class RomClient {
  constructor(transport, options = {}) {
    this.transport = transport;
    this.log = options.log || (() => {});
    this.debug = options.debug || false;
    this.defaultTimeout = options.timeout || DEFAULT_TIMEOUT;
    this.shouldCancel = options.shouldCancel || (() => false);
    this.commandMaskUnsupported = false;
  }

  _checkCancel() {
    if (this.shouldCancel()) {
      throw new AbortError('Operation cancelled');
    }
  }

  async _sendCommand(payload, timeoutMs = this.defaultTimeout) {
    this._checkCancel();
    const status = await this.transport.send(payload, timeoutMs);
    if (status === 1) {
      throw new RomError('ROM returned NAK', 1);
    }
    if (status === 2) {
      // The ROM aborts the command but still sends a response package.
      // Consume it, otherwise the next command would read a stale response
      // and the HID/UART stream would be permanently desynchronised.
      let response;
      try {
        response = await this._getResponse(timeoutMs);
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw new RomError('ROM returned ABORT without a response packet', 2);
        }
        throw error;
      }
      if (response.status !== 0) {
        throw new RomError(
          `ROM returned ABORT: ${statusMessage(response.status)} ` +
            `(0x${response.status.toString(16)})`,
          response.status,
        );
      }
      throw new RomError('ROM returned ABORT', 2);
    }
  }

  async _getResponse(timeoutMs = this.defaultTimeout) {
    let payload;
    try {
      payload = await this.transport.receive(timeoutMs);
    } catch (error) {
      // A timed-out / failed read may leave partial bytes or reports behind.
      // Drop them so the next command starts from a clean stream.
      this.transport.resetInput?.();
      throw error;
    }
    const response = parseResponse(payload);
    if (this.debug) {
      this.log('debug', `Response payload: ${bytesHex(payload)}`);
    }
    return response;
  }

  _expectOk(response, action) {
    if (response.status !== 0) {
      throw new RomError(
        `${action} failed: ${statusMessage(response.status)} (0x${response.status.toString(16)})`,
        response.status,
      );
    }
  }

  async queryRte(rteId, argument = 0, timeoutMs = this.defaultTimeout) {
    const payload = buildQueryRte(rteId, argument);
    await this._sendCommand(payload, timeoutMs);
    const response = await this._getResponse(timeoutMs);
    this._expectOk(response, `Query RTE ${rteId}`);
    return response;
  }

  async getRomInfo(timeoutMs = this.defaultTimeout) {
    const response = await this.queryRte(0, 0, timeoutMs);
    if (response.data.length < 16) {
      throw new RomError(`Invalid ROM parameter length: ${response.data.length}`);
    }
    return {
      romVersion: readU32(response.data, 0),
      socRevision: readU32(response.data, 4),
      lifeCycle: response.data[8],
      features: readU32(response.data, 12),
    };
  }

  async getSupportedCommands(timeoutMs = this.defaultTimeout) {
    if (this.commandMaskUnsupported) {
      throw new RomError('This ROM does not support Query RTE 5', 1002000);
    }
    try {
      const response = await this.queryRte(5, 0, timeoutMs);
      if (response.data.length < 4) {
        throw new RomError(`Invalid supported-command bitmap length: ${response.data.length}`);
      }
      return readU32(response.data, 0);
    } catch (error) {
      // ROM manuals before the RTE-5 extension return Abort / invalid argument.
      // Cache that so we do not perform a failed Abort exchange on every call.
      if (error instanceof RomError && (error.status === 1002000 || error.status === 2)) {
        this.commandMaskUnsupported = true;
      }
      throw error;
    }
  }

  async loadImage(data, onProgress = () => {}, timeoutMs = this.defaultTimeout) {
    if (!data || data.length === 0) {
      throw new RomError('Firmware data is empty');
    }
    this.log('info', `Loading firmware: ${data.length} bytes`);
    let offset = 0;
    while (offset < data.length) {
      this._checkCancel();
      const chunk = data.subarray(offset, Math.min(offset + LOAD_IMAGE_CHUNK, data.length));
      const payload = buildLoadImageChunk(chunk);
      const isLast = offset + chunk.length >= data.length;
      try {
        await this._sendCommand(payload, timeoutMs);
      } catch (error) {
        if (
          isLast &&
          this.transport.kind === 'hid' &&
          (error instanceof TimeoutError || error instanceof TransportError)
        ) {
          this.log(
            'warn',
            `No ACK for the last firmware packet (device may have rebooted): ${error.message}`,
          );
        } else {
          throw error;
        }
      }
      offset += chunk.length;
      onProgress(offset, data.length);
    }
    // The ROM/bootloader normally sends one final response after the image.
    // On USB the device may reboot before responding, so a timeout is not fatal.
    try {
      const response = await this._getResponse(3000);
      this._expectOk(response, 'Load firmware');
    } catch (error) {
      if (error instanceof TimeoutError || error instanceof TransportError) {
        this.log('warn', `No final response after loading firmware (device may have rebooted): ${error.message}`);
        this.transport.resetInput?.();
      } else {
        throw error;
      }
    }
    this.log('info', 'Firmware load complete');
  }

  async configRte(speed, timeoutMs = this.defaultTimeout) {
    await this._sendCommand(buildConfigRte(speed), timeoutMs);
    const response = await this._getResponse(timeoutMs);
    this._expectOk(response, 'Configure RTE');
  }

  async configMemory(memoryId, address, timeoutMs = this.defaultTimeout) {
    await this._sendCommand(buildConfigMemory(memoryId, address), timeoutMs);
    const response = await this._getResponse(timeoutMs);
    this._expectOk(response, 'Configure memory');
  }

  async writeMemory(memoryId, address, data, onProgress = () => {}, timeoutMs = this.defaultTimeout) {
    if (!data || data.length === 0) {
      throw new RomError('Write data is empty');
    }
    let offset = 0;
    let first = true;
    while (offset < data.length) {
      this._checkCancel();
      const maxChunk = first ? WRITE_FIRST_CHUNK : WRITE_NEXT_CHUNK;
      const chunk = data.subarray(offset, Math.min(offset + maxChunk, data.length));
      const payload = first
        ? buildWriteMemoryFirst(address, data.length, memoryId, chunk)
        : buildWriteMemoryContinuation(chunk);
      await this._sendCommand(payload, timeoutMs);
      offset += chunk.length;
      first = false;
      onProgress(offset, data.length);
    }
    const response = await this._getResponse(timeoutMs);
    this._expectOk(response, 'Write memory');
  }

  async eraseRegion(memoryId, address, length, timeoutMs = 120000) {
    await this._sendCommand(buildEraseRegion(memoryId, address, length), timeoutMs);
    const response = await this._getResponse(timeoutMs);
    this._expectOk(response, 'Erase region');
  }

  async eraseAll(memoryId, timeoutMs = 120000) {
    await this._sendCommand(buildEraseAll(memoryId), timeoutMs);
    const response = await this._getResponse(timeoutMs);
    this._expectOk(response, 'Erase all');
  }

  async verifyChecksum(memoryId, address, data, timeoutMs = this.defaultTimeout) {
    if (!globalThis.crypto?.subtle) {
      throw new RomError('Web Crypto is not available; cannot compute SHA-256');
    }
    this.log('info', 'Computing SHA-256...');
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
    const payload = buildVerifyChecksum(address, data.length, memoryId, digest);
    await this._sendCommand(payload, timeoutMs);
    const response = await this._getResponse(timeoutMs);
    this._expectOk(response, 'Verify');
    this.log('info', `Verification passed, SHA-256: ${bytesHex(digest, 32)}`);
  }

  async reset(resetType = 0, timeoutMs = 2000) {
    await this._sendCommand(buildReset(resetType), timeoutMs);
    try {
      const response = await this._getResponse(timeoutMs);
      this._expectOk(response, 'Reset');
    } catch (error) {
      if (error instanceof TimeoutError || error instanceof TransportError) {
        this.log('info', 'Device reset (no response)');
        return;
      }
      throw error;
    }
  }

  async waitForBootloader(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      this._checkCancel();
      try {
        const info = await this.getRomInfo(1000);
        this.log(
          'info',
          `ROM ready: version=0x${info.romVersion.toString(16)} ` +
            `revision=0x${info.socRevision.toString(16)} ` +
            `lifeCycle=${info.lifeCycle}`,
        );
        return info;
      } catch (error) {
        lastError = error;
        this.transport.resetInput?.();
        await delay(300);
      }
    }
    throw new RomError(`Timed out waiting for the device: ${lastError?.message || 'no response'}`);
  }
}
