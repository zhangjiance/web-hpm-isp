[English](README.md) | **简体中文**

# HPM ISP 烧录工具

纯 Web 的 HPMicro ISP 烧录工具，支持 UART（Web Serial）和 USB-HID（WebHID），无需安装本地程序。

## 使用方法

1. 将目标芯片置于 ISP / 串口下载模式。
2. 在连接卡片中选择 SoC 系列，然后选择接口（`UART` 或 `USB-HID`）。
   - UART：选择波特率。
   - USB-HID：如有需要，勾选 **All HID devices**。
3. 点击 **Connect**。工具会在连接时把对应的 `bl_fw` 加载到 RAM，因此后续更换镜像或修改配置字都不会重复加载。
4. 先配置镜像选项：
   - 选择 **Image Type**：
     - **Boot Image**：加载文件后自动解析 `0xFCF9xxxx` 配置块、Boot Header 和写入地址。
     - **User Data**：按用户填写的地址原样写入，不解析镜像中的配置字。
   - 确认写入地址和 **Flash Configuration Words**。
   - 再选择文件，或直接拖入底部 **Firmware Image** 虚线区域。
5. 如需生成配置字，点击 **Flash Configuration Words** 右侧的 ⚙️ 按钮，使用厂商风格的配置界面。
6. 点击 **Program**。进度条只在烧录过程中显示。

## 读取和擦除 Flash

连接卡片标题栏还提供两个工具操作：

- **Read Flash**：通过 `query-rte 4` 查询 XPI0 NOR 的容量和地址范围，自动填入起始
  地址和长度；仍可手动修改，并提供 **Detect** 按钮重新探测。读取前会把当前
  **Flash Configuration Words** 写入 ILM，并用它配置 XPI0 NOR。数据会下载为 `.bin`
  文件，单次最多读取 16 MiB。探测失败时回退到 `0x80000000 + 1 MiB`。
- **Erase**：打开擦除范围编辑窗口。默认使用 `query-rte 4` 报告的整个 XPI0 NOR 范围；
  自定义起始地址和长度会自动按探测到的扇区大小对齐，并在执行前显示对齐后的范围。
  没有额外的确认勾选框，点击 Erase 直接开始。使用全片范围即整片擦除，使用较小范围
  即局部擦除。擦除不可恢复，开始后不能取消。

这两个操作都要求已经连接 bootloader。读取进度显示在现有进度条中；全片擦除使用
不确定进度条。

## UART 波特率

UART 模式下，`bl_fw` 会在连接时使用连接卡片中选择的波特率加载。
设备重启进入 bootloader 后，工具会重新打开同一个 SerialPort，并继续在该波特率下通信。
如果 bootloader 在所选波特率下没有响应，工具会自动改用 115200 bps 重试。

每次连接时工具都会检查 `bl_fw` 是否已经在运行。正常断开后重新连接会跳过
`Load Image`；如果设备经过 reset 或重新上电，`bl_fw` 会重新加载。

## USB-HID 重新授权

USB-HID 在连接时也会执行同样的检查。如果当前是 ROM，工具会在点击 **Connect** 后立即加载
`bl_fw`，设备随后从 `Boot ROM Open` 重新枚举为 `Boot Firmware Open`。Chrome 对 WebHID
权限按设备实例管理，首次切换需要重新授权：

- 在弹窗中点击 **Select Boot Firmware Open**。
- 选择产品名为 **Boot Firmware Open** 的设备（VID `0x34b7`，PID 随 SoC 不同而变化）。
- HID 选择框会按当前 SoC 的 PID 过滤；如果使用 OTP 自定义 VID/PID，请勾选
  **All HID devices**。
- 如果还没有出现，等待 1–2 秒后重试。

如果 `bl_fw` 已经在运行（例如正常断开后重新连接），则不需要再次授权，工具会直接进入
bootloader 会话。

工具也会遵循官方 GUI 的版本判断规则：如果 ROM 版本编码的前缀是 `F`，说明 `bl_fw`
已经在运行，不会再次执行 `Load Image`。HPM6700/HPM6400 的 SoC revision 低于 `1.1.0` 时
使用裸 ROM，不加载 `bl_fw`。这类 ROM 不支持 `verify-checksum`，因此 Verify 会改用
read-back 校验：通过 ROM 读回已写入的 Flash 区域，在浏览器中逐字节比较。

部分旧版本 ROM 在加载 `bl_fw` 后不会重新枚举，而是继续使用原来的 HID 接口。遇到这种情况，
工具会重新打开并继续使用当前接口，不需要出现 `Boot Firmware Open` 设备，也不需要重新授权。

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
