# Paper Reader

一个面向 Apple Silicon 的桌面论文阅读器，支持：

- 本地打开 PDF
- 提取可复制文本型 PDF 的全文内容
- 对扫描版或文本稀疏 PDF 使用 macOS 原生 OCR
- 通过 OpenAI 兼容 API 进行全文翻译
- 翻译缓存与断点续跑
- 左侧原 PDF、中间翻译结果、右侧大模型对话的三栏阅读界面
- 通过 `skills/` 目录扩展对话技能

## 技术方案

- Electron + React + TypeScript
- `pdfjs-dist` 用于 PDF 文本提取和原文渲染
- Swift + Vision + PDFKit 用于 macOS 原生 OCR
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

## API 配置

应用启动后点击右上角 `API Settings`，填写：

- `API Base URL`：例如 `https://api.openai.com/v1`
- `API Key`
- `Chat Model`
- `Translation Model`
- `OCR Fallback`
- `OCR Languages`
- `Target Language`

也可以通过环境变量提供默认值，见 `.env.example`。

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

- OCR 目前仅支持 macOS，且依赖系统 Vision 能力
- 翻译结果以文本页展示，不保留复杂公式排版和双栏版式
- 全文翻译对长论文会较慢，并产生较高模型调用成本
- 翻译缓存按“文档内容 + 目标语言 + 翻译模型”区分，改动论文内容后会重新翻译
- API Key 当前保存在 Electron 用户配置目录内，未接入系统钥匙串
