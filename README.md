# 特制大肥鱼桌宠（GSD 版）

会**看屏幕陪你玩**、会**用自己的声音说话**、还**听得见你说话**的桌面宠物。

桌面小窗里住着一只蓝毛小女仆（哦鲸鲸）：

- 打游戏时它每隔几秒瞅一眼屏幕，画面变化够大才说一句吐槽/解说，并用**克隆音色**念出来
- 右键「听我说话」打开麦克风 → 你说话它听懂 → 用同一个声音回你（已接 Whisper，显卡加速）
- 会自动走来走去、会记住你在玩什么游戏（不会反复问"你在玩啥"）
- 双击启动器 → 填 API Key → 点「运行」，就全起来了；支持开机自启

> 打包版**不需要安装 DeepSeek Harness**（DSH）。它用的是 `dsh-pet` 的独立模式。

---

## 一、安装（给用户）

1. 下载 Release 里的分卷 `gsd-pet-1.0.zip.001 / .002 / .003` 和 `join.cmd`
2. 四个文件放同一个文件夹，双击 `join.cmd` → 得到 `gsd-pet-1.0.zip`
3. 解压（解压后约 6.7 GB）
4. 双击 **`setup.cmd`** → 装到 `%LOCALAPPDATA%\gsd-pet`，桌面出现「gsd特制大肥鱼桌宠」
5. 打开 App，填：
   - API Key：`sk-` 开头（DeepSeek）
   - 模型：`deepseek-flash` ← 能看图，别改
   - API 地址：`https://api.deepseek.com`
6. 点「运 行」。首次等 10~30 秒（加载语音模型），状态区出现「语音服务：就绪」「桌宠：运行中」即可

**卸载**：`%LOCALAPPDATA%\gsd-pet\uninstall.cmd`

### 机器要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10/11 64 位 |
| 显卡 | 建议 NVIDIA（有卡一句语音 1~2 秒；纯 CPU 能跑但慢 5~10 倍） |
| 网络 | 需要（调模型 API + edge-tts 合成） |
| 其他 | 一块 DeepSeek API Key |

---

## 二、这个仓库里是什么

```
src/
  launcher/petapp.py        启动器（tkinter，单文件，PyInstaller 打成 exe）
  install/install.ps1       安装脚本（复制到 %LOCALAPPDATA%、建快捷方式、写卸载项）
  install/uninstall.ps1     卸载脚本
  install/setup.cmd         安装入口（ASCII 名，防中文乱码）
  patch/peek.js             陪玩核心：抓屏差分、视觉提问、语音、小记忆
  patch/peek-worker.ps1     常驻抓屏 worker（PowerShell + System.Drawing）
  patch/apply-standalone.mjs  把陪玩补丁打进 dsh-pet 的 lib/standalone.js
  patch/fix-standalone-ear.mjs  给独立版补 /ear 路由（麦克风开关）
  voice/server.py           常驻语音服务（edge-tts 合成 + OpenVoice V2 换嗓，GPU）
  voice/ear.py              耳朵：麦克风 VAD → Whisper 转写 → 反问桌宠 → 播放
```

**仓库里没有的东西**（体积太大，在 Release 的安装包里）：

- `runtime/python`（Python 3.12 + torch CUDA + faster-whisper，约 5.4 GB）
- `runtime/electron`（Electron 运行时，347 MB）、`runtime/node.exe`
- `app/dsh-pet`（桌宠本体，来自 npm 包 `dsh-pet@0.3.8`）
- `app/pet-voice/models`（OpenVoice V2 换嗓模型 + Whisper small）

## 三、为什么要改 dsh-pet 的内部文件

`dsh-pet` 是 npm 上开箱即用的桌宠，但它**没有截屏陪玩、没有语音**，所以：

- 陪玩 = 在它的宿主 `lib/standalone.js` 里加 `peek` / `peek-toggle` / `ear` 路由 + 一个常驻抓屏 worker
- 语音 = 合成后走它自己的 `say` 气泡通道，做到**气泡和声音同一瞬间出现**
- 菜单 = 改 `runtime/electron-helper/sprite.js` 的右键菜单

这些改动**在 node_modules 里**，升级插件会被覆盖 ⇒ 所以补丁脚本单独放在 `src/patch/`，重装后重跑一遍即可（`apply-standalone.mjs` 会先备份 `lib/standalone.js`）。

## 四、自己构建

```powershell
# 1) 装依赖（本机）
pip install edge-tts faster-whisper sounddevice pyinstaller
# OpenVoice 仓库克隆到 app/pet-voice/repos/OpenVoice，模型放 app/pet-voice/models/openvoice/converter

# 2) 打启动器
python -m PyInstaller --noconfirm --onedir --noconsole --name "gsd-l" `
  --icon pet.ico --add-data "pet.ico;." launcher\petapp.py

# 3) 组装目录（app / runtime / launcher / _internal / exe / 脚本），然后
python make-zip.py             # 出 zip
python split-zip.py            # 切成 <2GB 分卷
```

## 五、许可与致谢

- 桌宠本体 `dsh-pet` 的版权归其作者（npm 包），本仓库只包含我自己写的启动器、补丁与语音服务代码。
- 语音换嗓：OpenVoice V2（MIT）；语音识别：faster-whisper / Whisper small（MIT）；合成：edge-tts（仅个人用途，请遵守微软服务条款）。
- 本仓库代码可自由用于学习和个人使用；请勿直接转售打包模型。

## 六、已知限制

- 截图只抓主显示器；独占全屏游戏可能抓到黑屏（无边框全屏正常）
- 「余额 / DSH 会话状态 / 系统通知」需要 DSH 宿主，独立版没有
- 截图会发送给你配置的模型服务商（本地不保存图片）
