[English](README.md) | **简体中文**

# HPM ISP 烧录工具

纯 Web 的 HPMicro ISP 烧录工具，支持 UART（Web Serial）和 USB-HID（WebHID），无需安装本地程序。

## 使用方法

1. 将目标芯片置于 ISP / 串口下载模式。
2. 在连接卡片中选择 SoC 系列，然后选择接口（`UART` 或 `USB-HID`）。
   - UART：选择波特率。
   - USB-HID：如有需要，勾选 **All HID devices**。
3. 点击 **Connect**。工具会在连接时把对应的 `bl_fw` 加载到 RAM，因此后续更换镜像或修改配置字都不会重复加载。
4. 选择镜像文件，也可以直接拖入 **Firmware & Image** 虚线区域，然后选择 **Image Type**：
   - **Boot Image**：自动解析 `0xFCF9xxxx` 配置块、Boot Header 和写入地址。
   - **User Data**：按用户填写的地址原样写入，不解析镜像中的配置字。
5. 如需生成配置字，点击 **Flash Configuration Words** 右侧的 ⚙️ 按钮，使用厂商风格的配置界面。
6. 点击 **Program**。进度条只在烧录过程中显示。

## UART 波特率

UART 模式下，`bl_fw` 会在连接时使用连接卡片中选择的波特率加载。
设备重启进入 bootloader 后，工具会重新打开同一个 SerialPort，并继续在该波特率下通信。
如果 bootloader 在所选波特率下没有响应，工具会自动改用 115200 bps 重试。

## USB-HID 重新授权

加载 `bl_fw` 后，设备会从 `Boot ROM Open` 重新枚举为 `Boot Firmware Open`。
Chrome 对 WebHID 权限按设备实例管理，首次切换需要重新授权：

- 在弹窗中点击 **Select Boot Firmware Open**。
- 选择 VID `0x34b7` / PID `0x0005` 的设备。
- 如果还没有出现，等待 1–2 秒后重试。

如需零点击授权，可使用 Chrome 的 `WebHidAllowDevicesForUrls` 策略自动放行对应 VID/PID。
参考本目录下的 `chrome-webhid-policy.json`。

## 浏览器要求

- 桌面版 Chrome、Edge 或 Opera
- 通过 `https://` 或 `http://localhost` 访问
- 不支持 Firefox、Safari 和移动浏览器

## 说明

- 默认写入地址为 `0x80000400`。
- 整个镜像按原样写入，不会剥离镜像中的配置块。
- 部分旧版 ROM 的 `Query RTE 5` 可能返回 ABORT，这是正常现象。
- 工具会在连接时自动加载 `bl_fw`；短暂的重新枚举属于正常流程。
- 烧录成功后会显示绿色成功提示，并保留到下一次操作或清空日志。

## 语言

- 默认英文：[README.md](README.md)
- 中文：[README.zh-CN.md](README.zh-CN.md)
