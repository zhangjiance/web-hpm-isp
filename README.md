**English** | [简体中文](README.zh-CN.md)

# HPM ISP Flasher

Pure web-based HPMicro ISP programmer for UART (Web Serial) and USB-HID (WebHID).

## Usage

1. Put the target into ISP / serial download mode.
2. In the connection card, select the SoC series, then the interface (`UART` or `USB-HID`). For UART, choose the baud rate; for HID, optionally enable **All HID devices**.
3. Click **Connect**. The matching `bl_fw` is loaded into RAM at connection time, so changing the image or configuration words does not reload it.
4. Select or drag an HPM Flash image into the **Firmware & Image** drop zone, then choose **Image Type**:
   - **Boot Image**: auto-detects the `0xFCF9xxxx` configuration block, boot header, and write address.
   - **User Data**: writes the file as-is at the address you enter and does not parse configuration words from the image.
5. Optionally open the ⚙️ button next to **Flash Configuration Words** to generate the four configuration words from the vendor-style GUI.
6. Click **Program**. The progress bar is shown only while programming is running.

## UART baud rates

For UART, `bl_fw` is loaded at connection time using the baud rate selected in the connection card.
After the device reboots into the bootloader, the tool reopens the same SerialPort at that baud
rate and continues. If the bootloader does not answer at the selected rate, the tool retries at
115200 bps.

## USB-HID re-authorization

After loading `bl_fw`, the device re-enumerates from `Boot ROM Open` to `Boot Firmware Open`.
Chrome grants WebHID permission per device instance, so the first switch prompts for a new grant:

- Click **Select Boot Firmware Open** in the dialog.
- Pick the device with VID `0x34b7` / PID `0x0005`.
- If it is not listed yet, wait 1-2 seconds and try again.

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
