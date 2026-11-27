# Lirio

跨端英语精听听写、雅思语料词本与 AI 口语陪练工具（支持 **macOS / Windows / Android**），基于 Tauri 2 + React + Rust 构建。

- 官方网站与多端下载：[https://lirio.deltae.tech](https://lirio.deltae.tech)
- GitHub Releases：[https://github.com/liruirui321/lirio/releases/latest](https://github.com/liruirui321/lirio/releases/latest)

## 安装包下载（GitHub Releases）

| 平台 | 安装文件 | 说明 |
| --- | --- | --- |
| **macOS**（Apple Silicon） | `Lirio-x.y.z-macos.dmg` | 挂载后将 `Lirio.app` 拖入「应用程序」；内含本机 Whisper 离线语音识别模型与自动更新支持 |
| **Windows**（x64） | `Lirio-x.y.z-windows-x64-setup.exe` | 双击安装运行；内置 Edge 神经语音与公测云端 AI 能力 |
| **Android** | `Lirio-x.y.z-android.apk` | 已签名 APK，直接安装使用（Android 8.0+） |

> 如果 macOS 提示来自未公证开发者：可在右键点击 `Lirio.app` →「打开」，或在「系统设置 → 隐私与安全性」中选择「仍要打开」。

## 核心功能

- **阶梯精听库（L1–L4）与「我的上传」独立仓库**：
  - L1–L4 分级材料与播客内容统一按难度分级，点击「继续上次」整栏即可一键直达断点听写；
  - 「我的上传」完全独立管理个人导入音频，支持弹窗拖拽（Drag & Drop）或点击上传 MP3 / M4A / WAV / MP4 / FLAC / OGG；
  - AI 精校预览支持**点击任意英文原句或中文译文直接修改**，点别处即自动保存并写入 `.abmac` 工程。
- **高效单句听写工作台**：
  - 逐句波形定位、单句循环、`0.75×` 一键慢速重听、首字母提示、只看错句与整句/填词双模式；
  - 看答案或批改出错后按 **`Tab` 重播**，立刻隐藏下方答案与批改区直接回到听写状态；
  - `Enter` 提交批改、`Shift+Enter` 换行、`Esc` 显示/隐藏答案、`Command`（单按）切换下一句、`Option+P` 播放/暂停；
  - 逐词批改并支持一键将错词/漏词加入「单词 → 错词本」、收藏经典句卡并沉淀提交轨迹分析。
- **雅思词本与 AI 口语陪练**：
  - 内置雅思高频语料词本与错词复练、导出；
  - 口语陪练支持自由对话、真题模拟与表达润色，默认采用 Microsoft Edge 神经语音，支持本地与云端识别。

## 隐私与安全设计

- **客户端零硬编码密钥**：安装包内不含任何服务商明文 API Key；若你使用自带 Key（BYOK），密钥仅保存在本机，并在数据导出与云端同步时强制剥离。
- **可独立自部署后端**：[server/](server/) 提供轻量 Node.js + SQLite 服务端，所有密钥仅通过服务器环境变量配置（参见 [server/.env.example](server/.env.example)），内置注册/请求限流、日配额限制、CORS 白名单、订单鉴权与上游报错脱敏。

## 本地开发与测试

需要 Node.js 22+、Rust stable；桌面完整包如需内置本机离线 Whisper 语音识别模型，可先运行资源脚本。

```sh
npm ci
npm run tauri dev
```

运行后端自动化安全与接口测试：

```sh
node server/test.mjs
```

前端类型检查与 Rust 编译检查：

```sh
npx tsc --noEmit
cd src-tauri && cargo check
```

## 开源许可与致谢

- 本项目基于 [MIT License](LICENSE) 开源；早期核心工作区源码延续自 [hedon954/aboboo-mac](https://github.com/hedon954/aboboo-mac)（MIT）。
- 离线识别使用 [whisper.cpp](https://github.com/ggml-org/whisper.cpp) / [Whisper](https://github.com/openai/whisper)（MIT），神经语音合成基于 Microsoft Edge TTS，部分音频工程与分词流程得益于开源社区项目。
