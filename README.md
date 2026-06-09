# Paper Reader
# (完全使用 codex 生成)

一个面向 Apple Silicon 的桌面论文阅读器，支持：

- 本地打开 PDF
- 提取可复制文本型 PDF 的全文内容
- 对扫描版或文本稀疏 PDF 使用 OCR 补全
- 通过 OpenAI 兼容 API 进行全文翻译
- 翻译缓存与断点续跑
- 左侧原 PDF、中间翻译结果、右侧大模型对话的三栏阅读界面
- 通过 `skills/` 目录扩展对话技能

## 技术方案

- Electron + React + TypeScript
- `pdfjs-dist` 用于 PDF 文本提取和原文渲染
- Swift + Vision + PDFKit 用于 macOS 原生 OCR
- MinerU 可作为可选 OCR 模块，通过 `uv run` 启动
- 主进程负责本地文件访问、PDF 解析、模型请求和 skill 加载

## 本地运行

1. 安装依赖

```bash
npm install
```

2. 启动开发环境

```bash
npm run dev
```

3. 构建应用

```bash
npm run build
```

4. 生成 macOS arm64 包

```bash
npm run dist:mac
```

生成结果位于 `release/`，可直接在 Apple Silicon 上打开 `.app` 或 `.zip`。

## 配置方式

应用当前完全依赖项目根目录的 `.env` 作为配置真源，设置面板只用于查看当前生效值，并在修改 `.env` 后执行“从 `.env` 刷新”。

可参考 `.env.example`，常用字段如下：

- `OPENAI_BASE_URL`：例如 `https://api.openai.com/v1` 或兼容 OpenAI 协议的平台地址
- `OPENAI_API_KEY`
- `OPENAI_CHAT_MODEL`
- `OPENAI_TRANSLATION_MODEL`
- `PDF_PARSER_PROVIDER`
- `USE_OCR_FALLBACK`
- `OCR_PROVIDER`
- `MINERU_LAUNCHER`
- `MINERU_UV_WITH`

修改 `.env` 后请重启应用，再点击设置面板里的“从 `.env` 刷新”确认显示值。

## OCR 与 MinerU

默认情况下，应用使用原生 OCR：

```env
USE_OCR_FALLBACK=true
OCR_PROVIDER=native
```

只有在你主动修改 `.env` 或希望切换实现时，才需要改 OCR 配置。

可选值如下：

- `OCR_PROVIDER=native`：默认值，使用 macOS Vision / PDFKit 原生 OCR
- `OCR_PROVIDER=mineru`：使用 MinerU 作为 OCR 模块
- `OCR_PROVIDER=none`：关闭 OCR 补全

如果要切换到 MinerU OCR，推荐配置为：

```env
PDF_PARSER_PROVIDER=pdfjs
USE_OCR_FALLBACK=true
OCR_PROVIDER=mineru
UV_BIN=uv
MINERU_LAUNCHER=uv
MINERU_UV_WITH=mineru,socksio
```

说明：

- `PDF_PARSER_PROVIDER` 决定主解析链，通常建议保持 `pdfjs`
- `OCR_PROVIDER` 决定 OCR 补全模块，默认是 `native`
- `mineru` 模式下会通过 `uv run` 启动 Python 侧提取脚本
- 只有文本稀疏或扫描版页面才会触发 OCR 补全

## Skill 扩展

在项目根目录的 `skills/` 中放置 ESM 模块，例如：

```js
export default {
  id: "my-skill",
  name: "My Skill",
  description: "Describe what this skill does.",
  systemPrompt: "Additional behavior for the chat assistant.",
  quickActions: [
    {
      id: "action-1",
      label: "Quick Action",
      prompt: "Prompt inserted into the chat input."
    }
  ]
};
```

点击界面的 `Reload Skills` 即可重新加载。

## 当前限制

- 原生 OCR 目前仅支持 macOS，且依赖系统 Vision 能力
- MinerU OCR 依赖本机可用的 `uv` / Python 环境与对应模型依赖
- 翻译结果以文本页展示，不保留复杂公式排版和双栏版式
- 全文翻译对长论文会较慢，并产生较高模型调用成本
- 翻译缓存按“文档内容 + 目标语言 + 翻译模型”区分，改动论文内容后会重新翻译
- API Key 当前来自项目 `.env`，未接入系统钥匙串
