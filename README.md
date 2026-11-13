# 特制大肥鱼桌宠（GSD 版）

会看屏幕、会说话、听得见你说话，也能按命令走到桌面图标旁边帮你打开的 Windows 桌宠。

本项目基于 `dsh-pet@0.3.8` 独立模式，不需要安装 DeepSeek Harness。

## v1.1 更新

- 人设、说话参考、名字和克隆音色参考音频可在图形界面中修改。
- 启动器改为原生 C# WinForms，不再依赖 Python/Tk 启动。
- 桌宠和语音模型并行启动，状态检测在后台线程执行，启动和切页不再卡 UI。
- 语音服务先监听端口再加载 OpenVoice；Whisper 改为后台加载，首次说话时等待模型就绪。
- 新增桌面命令，例如「打开PCL2」「帮我启动一下微信」。
  - 本地匹配用户桌面和公共桌面中的 `.lnk` / `.url` / `.exe`
  - 用 Windows UI Automation 读取真实图标坐标
  - 桌宠以慢速步频移动到图标旁，先播放“忙碌点按”动作再打开
  - 桌面图标找不到时，继续搜索当前屏幕上的按钮、菜单和列表项
  - 无无障碍名称的控件可用高分截图交给视觉模型返回归一化坐标
  - 桌面不在前台或点击失败时回退为直接启动
  - 不接受模型传入的任意 shell 命令或任意路径
- 发布包拆成轻量版和可选语音包，不再要求下载一个 4 GB 压缩包。

## 发布文件

| 文件 | 大小 | 用途 |
|---|---:|---|
| `gsd-pet-lite-1.1-setup.exe` | 约 398 MB | 轻量单文件安装器，含桌宠、Electron、Node、系统语音 |
| `gsd-pet-lite-1.1.zip` | 约 398 MB | 同内容便携包 |
| `gsd-pet-voice-pack-1.1.zip.part01` | 1.80 GB | GitHub 语音分卷 1 |
| `gsd-pet-voice-pack-1.1.zip.part02` | 1.66 GB | GitHub 语音分卷 2 |
| `install-voice-pack-from-parts.ps1` | 小 | 合并、校验、解压并安装语音包 |

轻量版只带系统语音。需要 OpenVoice 克隆音色、Whisper 听写时再安装语音包。

GitHub Release 不需要自建服务器。语音包原文件 3.3 GB，超过单文件 2 GiB 限制，因此拆成两个 `< 2 GiB` 的分卷。

## 给用户安装

1. 运行 `gsd-pet-lite-1.1-setup.exe`。
2. 启动器里填写 API Key、模型和接口地址。
3. 点「保存并运行」。
4. 需要克隆音色时，下载两个语音分卷和安装脚本，放到同一文件夹，用 PowerShell 运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\install-voice-pack-from-parts.ps1"
```

设置保存在：

```text
%LOCALAPPDATA%\gsd-pet\data
```

覆盖安装不会删除 `data`。

## 源码结构

```text
src/
  launcher/
    DesktopPetLauncher.cs    当前使用的原生 WinForms 启动器
    petapp.py                旧版 Tk 启动器，仅留作历史参考
  voice/
    server.py                edge-tts + OpenVoice 常驻语音服务
    ear.py                   麦克风 VAD + Whisper + 对话
  patch/
    apply-release-patches.mjs  一次应用全部 dsh-pet 补丁
    apply-standalone.mjs       陪玩、语音同步、截图链路
    patch-sync.mjs             气泡与语音同步
    fix-standalone-ear.mjs     /ear 路由
    apply-desktop-action.mjs   桌面图标命令与移动点击
    desktop-action.js          命令解析和本地动作入口
    desktop-action.ps1         UI Automation 图标定位/点击
    peek.js                    截图差分、视觉生成、语音记忆
    peek-worker.ps1            常驻抓屏 worker
    peek-capture.ps1           一次性抓屏兜底
  install/                     安装、卸载、语音包安装脚本
  tools/                       轻量包、安装器、语音包和分卷构建脚本
```

## 重新给 dsh-pet 打补丁

```powershell
node .\src\patch\apply-release-patches.mjs --pkg "C:\path\to\dsh-pet"
```

脚本会先备份原始文件。重复运行是幂等的。

单独还原桌面命令补丁：

```powershell
node .\src\patch\apply-desktop-action.mjs --pkg "C:\path\to\dsh-pet" --revert
```

## 重新构建

原始发布材料需要放在仓库根目录或通过参数指定：

- `gsd-pet-1.0.zip`
- 包含 Electron、Node、OpenVoice、Whisper 等大体积运行时

构建轻量包：

```powershell
powershell -ExecutionPolicy Bypass -File .\src\tools\build-lite.ps1
```

构建单文件安装器：

```powershell
powershell -ExecutionPolicy Bypass -File .\src\tools\build-installer.ps1
```

构建可选语音包并切分：

```powershell
powershell -ExecutionPolicy Bypass -File .\src\tools\build-voice-pack.ps1
powershell -ExecutionPolicy Bypass -File .\src\tools\split-voice-pack.ps1
```

## 已知限制

- 截图默认只抓主显示器；独占全屏游戏可能抓到黑屏。
- 桌面命令只打开桌面目录中真实存在的快捷方式、URL 或 exe。
- 轻量版不含克隆音色；纯 CPU 语音包合成比 NVIDIA GPU 慢。
- 截图与文字会发送给用户配置的模型服务商，本地不保存整屏图片。

## 许可与致谢

- 桌宠本体 `dsh-pet` 的版权归其作者，本仓库只包含启动器、补丁和语音服务代码。
- OpenVoice V2、faster-whisper / Whisper、edge-tts 遵循各自许可与服务条款。
- 本仓库代码可用于学习和个人使用；模型与运行时请勿直接转售。
