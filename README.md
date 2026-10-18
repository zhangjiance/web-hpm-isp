**English** | [简体中文](README.zh-CN.md)

# HPM ISP Flasher

Pure web-based HPMicro ISP programmer for UART (Web Serial) and USB-HID (WebHID).

## Usage

1. Put the target into ISP / serial download mode.
2. In the connection card, select the SoC series, then the interface (`UART` or `USB-HID`). For UART, choose the baud rate; for HID, optionally enable **All HID devices**.
3. Click **Connect**. The matching `bl_fw` is loaded into RAM at connection time, so changing the image or configuration words does not reload it.
4. Configure the image options first:
   - Choose **Image Type**:
     - **Boot Image**: auto-detects the `0xFCF9xxxx` configuration block, boot header, and write address when a file is loaded.
     - **User Data**: writes the file as-is at the address you enter and does not parse configuration words from the image.
   - Check the write address and **Flash Configuration Words**.
   - Then select or drag an HPM Flash image into the bottom **Firmware Image** drop zone.
5. Optionally open the ⚙️ button next to **Flash Configuration Words** to generate the four configuration words from the vendor-style GUI.
6. Click **Program**. The progress bar is shown only while programming is running.

## Reading and erasing flash

The connection card header also provides two utility actions:

- **Read Flash** — queries `query-rte 4` for the XPI0 NOR properties and fills the
  start address and length from the detected memory range. The range can still be
  edited manually, and a **Detect** button re-runs discovery. The current
  **Flash Configuration Words** are written to ILM and used to configure XPI0 NOR
  before reading. Data is downloaded as a `.bin` file; a single read is limited to
  16 MiB. If detection fails, the tool falls back to `0x80000000 + 1 MiB`.
- **Erase** — opens a range editor. By default the start address and length cover the
  entire XPI0 NOR range reported by `query-rte 4`. A custom start address/length is
  automatically aligned to the detected sector size, and the resulting range is shown
  before execution. There is no separate confirmation checkbox; the Erase button
  starts the operation directly. Use the full range for a chip erase, or a smaller
  range for a partial erase. Erasing is irreversible and cannot be cancelled once
  started.

Both operations require an active connection to the bootloader. Read progress is
shown in the existing progress bar; chip erase uses an indeterminate progress bar.

## UART baud rates

For UART, `bl_fw` is loaded at connection time using the baud rate selected in the connection card.
After the device reboots into the bootloader, the tool reopens the same SerialPort at that baud
rate and continues. If the bootloader does not answer at the selected rate, the tool retries at
115200 bps.

On every connection, the tool checks whether `bl_fw` is already running. Reconnecting after a
normal disconnect skips the `Load Image` step; after a reset or power cycle, `bl_fw` is loaded
again.

## USB-HID re-authorization

The same check is performed over HID at connection time. If the interface is still the ROM,
`bl_fw` is loaded immediately during **Connect** and the device re-enumerates from
`Boot ROM Open` to `Boot Firmware Open`. Chrome grants WebHID permission per device instance,
so this first switch prompts for a new grant:

- Click **Select Boot Firmware Open** in the dialog.
- Pick the **Boot Firmware Open** device (VID `0x34b7`; the PID depends on the SoC).
- The HID picker is filtered by the selected SoC's PID. Enable **All HID devices** when using
  a custom VID/PID from OTP.
- If it is not listed yet, wait 1-2 seconds and try again.

If `bl_fw` is already running (for example after reconnecting), no re-authorization is needed and
the tool goes straight to the bootloader session.

The tool also follows the official GUI's version rule: an encoded ROM version whose prefix is
`F` means `bl_fw` is already running, so no `Load Image` is attempted. HPM6700/HPM6400 SoC
revisions below `1.1.0` use the bare ROM instead of loading `bl_fw`, matching the official GUI.
Because such ROMs do not support `verify-checksum`, the Verify option performs a read-back
comparison instead: the written range is read through the ROM and compared byte-for-byte in the
browser.

Some older ROM versions keep the same HID interface after loading `bl_fw` instead of
re-enumerating. In that case the tool reopens and continues on the current interface, so no
`Boot Firmware Open` device or new permission grant is required.

For zero-click operation, use the Chrome `WebHidAllowDevicesForUrls` policy to auto-grant the
VID/PID. See `chrome-webhid-policy.json` in this folder.

## Browser requirements

- Desktop Chrome, Edge, or Opera
- Served from `https://` or `http://localhost`
- Firefox, Safari, and mobile browsers are not supported

## Notes

- The default write address is `0x80000400`.
- The whole image is written as-is; the configuration block is not stripped.
- `Query RTE 5` may return ABORT on older ROMs; this is expected.
- The tool loads `bl_fw` automatically at connection time. A short re-enumeration is normal.
