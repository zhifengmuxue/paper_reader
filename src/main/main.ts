import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  AppConfig,
  ChatMessage,
  ChatRequest,
  LoadedDocument,
  OcrProvider,
  PdfParseProgress,
  PdfParserProvider,
  PdfPage,
  SkillListResult,
  SkillManifest,
  SkillImportResult,
  TranslationCacheInfo,
  TranslationPage,
  TranslationProgress,
  TranslationRequest,
  TranslationResult
} from "../shared/types.js";

dotenv.config({ override: true });

const execFileAsync = promisify(execFile);
const APP_NAME = "Paper Reader Studio";
const DEBUG_ENV_PATH = ".dbg/chat-fetch-failed.env";

let mainWindow: BrowserWindow | null = null;

const CONFIG_DIR_NAME = "paper-reader";
const TRANSLATION_CACHE_VERSION = 1;

interface OcrHelperResult {
  pages: Array<{
    pageNumber: number;
    text: string;
  }>;
}

interface TranslationCacheFile extends TranslationResult {
  version: number;
  pageTextFingerprint: string;
}

interface MineruExtractionResult {
  pageCount: number;
  pages: Array<{
    pageNumber: number;
    text: string;
  }>;
  markdown?: string;
  backend?: string;
  error?: string;
  stdout?: string;
  stderr?: string;
}

interface CommandInvocation {
  command: string;
  args: string[];
}

const parseCsvEnv = (value: string | undefined, fallback: string[]): string[] => {
  const parsed = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
};

const normalizeOcrProvider = (value?: string): OcrProvider => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "native" || normalized === "vision" || normalized === "macos") {
    return "native";
  }
  if (normalized === "mineru") {
    return "mineru";
  }
  return "none";
};

const inferDefaultUseOcrFallback = (): boolean => {
  const fallbackEnv = process.env.USE_OCR_FALLBACK?.trim().toLowerCase();
  if (fallbackEnv === "false" || fallbackEnv === "0" || fallbackEnv === "off") {
    return false;
  }

  if (process.env.OCR_PROVIDER) {
    return normalizeOcrProvider(process.env.OCR_PROVIDER) !== "none";
  }

  return true;
};

const inferDefaultOcrProvider = (): OcrProvider => {
  if (!inferDefaultUseOcrFallback()) {
    return "none";
  }
  if (process.env.OCR_PROVIDER) {
    return normalizeOcrProvider(process.env.OCR_PROVIDER);
  }
  return "native";
};

const defaultConfig: AppConfig = {
  apiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY ?? "",
  chatModel: process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
  translationModel: process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-4o-mini",
  temperature: 0.2,
  targetLanguage: "中文",
  useOcrFallback: inferDefaultUseOcrFallback(),
  ocrProvider: inferDefaultOcrProvider(),
  ocrLanguageHint: "en-US,zh-Hans,ja-JP"
};

const normalizePdfParserProvider = (value?: string): PdfParserProvider =>
  value?.trim().toLowerCase() === "mineru" ? "mineru" : "pdfjs";

const getPdfParserProvider = (): PdfParserProvider =>
  normalizePdfParserProvider(process.env.PDF_PARSER_PROVIDER);

const getMineruScriptPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "scripts", "extract_with_mineru.py")
    : join(app.getAppPath(), "scripts", "extract_with_mineru.py");

const getMineruLaunchMode = (): "uv" | "binary" =>
  process.env.MINERU_LAUNCHER?.trim().toLowerCase() === "binary" ? "binary" : "uv";

const getUvExecutable = (): string => process.env.UV_BIN?.trim() || "uv";

const getMineruUvPackages = (): string[] => parseCsvEnv(process.env.MINERU_UV_WITH, ["mineru", "socksio"]);

type PdfParseProgressReporter = (progress: PdfParseProgress) => void;

const emitPdfParseProgress = (
  filePath: string,
  parserProvider: PdfParserProvider,
  onProgress: PdfParseProgressReporter | undefined,
  stage: PdfParseProgress["stage"],
  percent: number,
  status: string
): void => {
  onProgress?.({
    filePath,
    fileName: basename(filePath),
    parserProvider,
    stage,
    percent,
    status
  });
};

const createWindow = async (): Promise<void> => {
  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: "Copyright 2026 dianyou. All rights reserved.",
    credits: "OCR powered by macOS Vision and PDFKit. Desktop runtime by Electron.",
    website: "https://paper-reader.local"
  });

    mainWindow = new BrowserWindow({
        width: 1680,
        height: 980,
        minWidth: 1280,
        minHeight: 800,
        title: APP_NAME,
        webPreferences: {
            preload: join(app.getAppPath(), "src/main/preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  await mainWindow.loadFile(join(app.getAppPath(), "dist-renderer/index.html"));
};

const ensureDirectory = (directoryPath: string): string => {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true });
  }
  return directoryPath;
};

const getStateDirectory = (): string =>
  ensureDirectory(join(app.getPath("userData"), CONFIG_DIR_NAME));

const getBundledSkillsDir = (): string => join(app.getAppPath(), "skills");
const getUserSkillsDir = (): string => ensureDirectory(join(getStateDirectory(), "skills"));
const getTranslationCacheDir = (): string =>
  ensureDirectory(join(getStateDirectory(), "cache", "translations"));

const getOcrHelperPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "bin", "ocr-helper")
    : join(app.getAppPath(), "bin", "ocr-helper");

const buildMineruInvocation = (filePath: string): CommandInvocation => {
  const scriptPath = getMineruScriptPath();
  if (!existsSync(scriptPath)) {
    throw new Error(`MinerU helper script not found at ${scriptPath}.`);
  }

  if (getMineruLaunchMode() === "binary") {
    return {
      command: "python3",
      args: [scriptPath, "--pdf", filePath]
    };
  }

  const uvPackages = getMineruUvPackages();
  const args = ["run"];
  for (const pkg of uvPackages) {
    args.push("--with", pkg);
  }
  args.push("python", scriptPath, "--pdf", filePath);

  return {
    command: getUvExecutable(),
    args
  };
};

const readConfig = (): AppConfig => ({ ...defaultConfig });

const saveConfig = (_config: AppConfig): AppConfig => readConfig();

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

const normalizeWhitespace = (value: string): string =>
  value.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

const computePageTextFingerprint = (document: LoadedDocument): string =>
  sha256(
    JSON.stringify(
      document.pages.map((page) => ({
        pageNumber: page.pageNumber,
        text: page.text
      }))
    )
  );

const computeTranslationCacheKey = (document: LoadedDocument, config: AppConfig): string => {
  const pageTextFingerprint = computePageTextFingerprint(document);
  return sha256(
    JSON.stringify({
      documentFingerprint: document.documentFingerprint,
      pageTextFingerprint,
      translationModel: config.translationModel,
      targetLanguage: config.targetLanguage
    })
  );
};

const getTranslationCachePath = (cacheKey: string): string =>
  join(getTranslationCacheDir(), `${cacheKey}.json`);

const readTranslationCache = (
  document: LoadedDocument,
  config: AppConfig
): TranslationCacheFile | null => {
  const cacheKey = computeTranslationCacheKey(document, config);
  const cachePath = getTranslationCachePath(cacheKey);
  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as TranslationCacheFile;
    if (
      parsed.version !== TRANSLATION_CACHE_VERSION ||
      parsed.cacheKey !== cacheKey ||
      parsed.documentFingerprint !== document.documentFingerprint ||
      parsed.pageTextFingerprint !== computePageTextFingerprint(document)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeTranslationCache = (
  document: LoadedDocument,
  config: AppConfig,
  pages: TranslationPage[],
  translatedAt: string
): TranslationResult => {
  const pageTextFingerprint = computePageTextFingerprint(document);
  const cacheKey = computeTranslationCacheKey(document, config);
  const payload: TranslationCacheFile = {
    version: TRANSLATION_CACHE_VERSION,
    documentFingerprint: document.documentFingerprint,
    pageTextFingerprint,
    pages,
    translatedAt,
    targetLanguage: config.targetLanguage,
    model: config.translationModel,
    cacheKey
  };
  writeFileSync(getTranslationCachePath(cacheKey), JSON.stringify(payload, null, 2), "utf-8");
  return {
    documentFingerprint: payload.documentFingerprint,
    pages: payload.pages,
    translatedAt: payload.translatedAt,
    targetLanguage: payload.targetLanguage,
    model: payload.model,
    cacheKey: payload.cacheKey
  };
};

const getTranslationCacheInfo = (
  document: LoadedDocument,
  config: AppConfig
): TranslationCacheInfo => {
  const cacheKey = computeTranslationCacheKey(document, config);
  const cachePath = getTranslationCachePath(cacheKey);
  const cached = readTranslationCache(document, config);
  return {
    cacheKey,
    cachePath,
    hasCache: Boolean(cached),
    completedPages: cached
      ? cached.pages.filter((page) => page.status === "done" || page.status === "empty").length
      : 0,
    totalPages: document.pages.length,
    translatedAt: cached?.translatedAt
  };
};

const loadCachedTranslation = (
  document: LoadedDocument,
  config: AppConfig
): TranslationResult | null => {
  const cached = readTranslationCache(document, config);
  if (!cached) {
    return null;
  }

  return {
    documentFingerprint: cached.documentFingerprint,
    pages: cached.pages,
    translatedAt: cached.translatedAt,
    targetLanguage: cached.targetLanguage,
    model: cached.model,
    cacheKey: cached.cacheKey
  };
};

const extractEmbeddedPdfText = async (data: Uint8Array): Promise<{ pageCount: number; pages: PdfPage[] }> => {
  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;
  const pages: PdfPage[] = [];

  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const textContent = await page.getTextContent();
    const text = normalizeWhitespace(
      textContent.items.map((item) => ("str" in item ? item.str : "")).join(" ")
    );

    pages.push({
      pageNumber: index,
      text,
      extractionMethod: text ? "embedded-text" : "none"
    });
  }

  return {
    pageCount: pdf.numPages,
    pages
  };
};

const shouldRunOcr = (pages: PdfPage[]): boolean => {
  const shortPages = pages.filter((page) => page.text.trim().length < 30).length;
  const fullySparse = pages.every((page) => page.text.trim().length < 120);
  return shortPages > 0 && (fullySparse || shortPages / Math.max(pages.length, 1) >= 0.15);
};

const runMineruExtraction = async (filePath: string): Promise<MineruExtractionResult> => {
  const invocation = buildMineruInvocation(filePath);
  const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
    maxBuffer: 1024 * 1024 * 128
  });

  if (stderr?.trim()) {
    console.warn(stderr.trim());
  }

  const parsed = JSON.parse(stdout) as MineruExtractionResult;
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) {
    throw new Error("MinerU did not return any parsed pages.");
  }

  return parsed;
};

const runOcrHelper = async (
  filePath: string,
  config: AppConfig
): Promise<OcrHelperResult> => {
  const helperPath = getOcrHelperPath();
  if (!existsSync(helperPath)) {
    throw new Error(`OCR helper not found at ${helperPath}. Run npm run build first.`);
  }

  const { stdout, stderr } = await execFileAsync(
    helperPath,
    [filePath, config.ocrLanguageHint],
    {
      maxBuffer: 1024 * 1024 * 128
    }
  );

  if (stderr?.trim()) {
    console.warn(stderr.trim());
  }

  return JSON.parse(stdout) as OcrHelperResult;
};

const runConfiguredOcr = async (
  filePath: string,
  config: AppConfig
): Promise<{ provider: Exclude<OcrProvider, "none">; result: OcrHelperResult }> => {
  if (config.ocrProvider === "mineru") {
    const parsed = await runMineruExtraction(filePath);
    return {
      provider: "mineru",
      result: {
        pages: parsed.pages.map((page) => ({
          pageNumber: page.pageNumber,
          text: page.text
        }))
      }
    };
  }

  return {
    provider: "native",
    result: await runOcrHelper(filePath, config)
  };
};

const mergeEmbeddedAndOcr = (
  embeddedPages: PdfPage[],
  ocrPages: OcrHelperResult["pages"]
): { pages: PdfPage[]; usedOcr: boolean } => {
  const ocrMap = new Map(ocrPages.map((page) => [page.pageNumber, normalizeWhitespace(page.text)]));
  let usedOcr = false;

  const pages = embeddedPages.map((page) => {
    const ocrText = ocrMap.get(page.pageNumber) ?? "";
    const embeddedLength = page.text.trim().length;
    const ocrLength = ocrText.trim().length;

    if (embeddedLength >= 40) {
      return page;
    }

    if (ocrLength > embeddedLength + 20) {
      usedOcr = true;
      return {
        pageNumber: page.pageNumber,
        text: ocrText,
        extractionMethod: ocrText ? "ocr" : "none"
      } satisfies PdfPage;
    }

    if (embeddedLength > 0) {
      return page;
    }

    if (ocrLength > 0) {
      usedOcr = true;
      return {
        pageNumber: page.pageNumber,
        text: ocrText,
        extractionMethod: "ocr"
      } satisfies PdfPage;
    }

    return {
      pageNumber: page.pageNumber,
      text: "",
      extractionMethod: "none"
    } satisfies PdfPage;
  });

  return { pages, usedOcr };
};

const extractPdfTextWithPdfJs = async (
  filePath: string,
  config: AppConfig,
  onProgress?: PdfParseProgressReporter
): Promise<LoadedDocument> => {
  emitPdfParseProgress(filePath, "pdfjs", onProgress, "queued", 5, "已进入 PDF 解析队列");
  const data = new Uint8Array(readFileSync(filePath));
  const documentFingerprint = sha256(data);
  emitPdfParseProgress(filePath, "pdfjs", onProgress, "parsing", 25, "正在提取 PDF 内嵌文本");
  const embedded = await extractEmbeddedPdfText(data);

  let pages = embedded.pages;
  let usedOcr = false;

  if (config.ocrProvider !== "none" && config.useOcrFallback && shouldRunOcr(embedded.pages)) {
    const ocrStatus =
      config.ocrProvider === "mineru"
        ? "文本稀疏，正在通过 MinerU OCR 补全文本"
        : "文本稀疏，正在执行原生 OCR 补全";
    emitPdfParseProgress(filePath, "pdfjs", onProgress, "parsing", 55, ocrStatus);
    try {
      const { result: ocrResult } = await runConfiguredOcr(filePath, config);
      const merged = mergeEmbeddedAndOcr(embedded.pages, ocrResult.pages);
      pages = merged.pages;
      usedOcr = merged.usedOcr;
    } catch (error) {
      console.error(
        `OCR fallback (${config.ocrProvider}) failed, continuing with embedded text only.`,
        error
      );
    }
  }

  emitPdfParseProgress(filePath, "pdfjs", onProgress, "finalizing", 90, "正在整理页面文本");

  const loadedDocument: LoadedDocument = {
    filePath,
    fileName: basename(filePath),
    pageCount: embedded.pageCount,
    pages,
    usedOcr,
    parserProvider: "pdfjs",
    documentFingerprint
  };
  emitPdfParseProgress(filePath, "pdfjs", onProgress, "done", 100, "PDF 文本解析完成");
  return loadedDocument;
};

const extractPdfTextWithMineru = async (
  filePath: string,
  _config: AppConfig,
  onProgress?: PdfParseProgressReporter
): Promise<LoadedDocument> => {
  emitPdfParseProgress(filePath, "mineru", onProgress, "queued", 5, "已进入 MinerU 解析队列");
  const data = new Uint8Array(readFileSync(filePath));
  const documentFingerprint = sha256(data);
  emitPdfParseProgress(filePath, "mineru", onProgress, "parsing", 20, "正在启动 MinerU 文档解析");
  const parsed = await runMineruExtraction(filePath);

  emitPdfParseProgress(filePath, "mineru", onProgress, "finalizing", 88, "MinerU 已完成提取，正在整理页面结果");

  const loadedDocument: LoadedDocument = {
    filePath,
    fileName: basename(filePath),
    pageCount: parsed.pageCount,
    pages: parsed.pages.map(
      (page) =>
        ({
          pageNumber: page.pageNumber,
          text: normalizeWhitespace(page.text),
          extractionMethod: page.text.trim() ? "mineru" : "none"
        }) satisfies PdfPage
    ),
    usedOcr: false,
    parserProvider: "mineru",
    documentFingerprint
  };
  emitPdfParseProgress(filePath, "mineru", onProgress, "done", 100, "MinerU 文档解析完成");
  return loadedDocument;
};

const extractPdfText = async (
  filePath: string,
  config: AppConfig,
  onProgress?: PdfParseProgressReporter
): Promise<LoadedDocument> => {
  const provider = getPdfParserProvider();
  try {
    if (provider === "mineru") {
      return extractPdfTextWithMineru(filePath, config, onProgress);
    }
    return extractPdfTextWithPdfJs(filePath, config, onProgress);
  } catch (error) {
    emitPdfParseProgress(
      filePath,
      provider,
      onProgress,
      "error",
      100,
      error instanceof Error ? `PDF 解析失败：${error.message}` : "PDF 解析失败"
    );
    throw error;
  }
};

const loadPdfBinary = (filePath: string): Uint8Array => new Uint8Array(readFileSync(filePath));

const buildChatPayload = (
  messages: ChatMessage[],
  model: string,
  temperature: number
): Record<string, unknown> => ({
  model,
  temperature,
  messages
});

const reportDebugEvent = (
  hypothesisId: "A" | "B" | "C" | "D",
  location: string,
  msg: string,
  data: Record<string, unknown>
): void => {
  let debugServerUrl = "http://127.0.0.1:7777/event";
  let sessionId = "chat-fetch-failed";

  try {
    const envText = readFileSync(DEBUG_ENV_PATH, "utf-8");
    debugServerUrl = envText.match(/DEBUG_SERVER_URL=(.+)/)?.[1]?.trim() ?? debugServerUrl;
    sessionId = envText.match(/DEBUG_SESSION_ID=(.+)/)?.[1]?.trim() ?? sessionId;
  } catch {
    // Ignore missing debug configuration and keep the default localhost target.
  }

  void fetch(debugServerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sessionId,
      runId: "pre-fix",
      hypothesisId,
      location,
      msg,
      data,
      ts: Date.now()
    })
  }).catch(() => {});
};

const requestChatCompletion = async (
  config: AppConfig,
  messages: ChatMessage[],
  model: string
): Promise<string> => {
  if (!config.apiKey.trim()) {
    throw new Error("Missing API key. Please set API Settings first.");
  }

  const requestUrl = `${config.apiBaseUrl.replace(/\/$/, "")}/chat/completions`;

  // #region debug-point A:request-chat-start
  reportDebugEvent("A", "src/main/main.ts:requestChatCompletion:start", "[DEBUG] Starting chat completion request", {
    requestUrl,
    model,
    hasApiKey: Boolean(config.apiKey.trim()),
    apiBaseUrl: config.apiBaseUrl
  });
  // #endregion

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(buildChatPayload(messages, model, config.temperature))
    });
  } catch (error) {
    // #region debug-point B:request-chat-fetch-error
    reportDebugEvent("B", "src/main/main.ts:requestChatCompletion:fetch", "[DEBUG] Chat completion fetch threw before receiving a response", {
      requestUrl,
      apiBaseUrl: config.apiBaseUrl,
      model,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack ?? "" : "",
      errorCause:
        error instanceof Error && "cause" in error
          ? String((error as Error & { cause?: unknown }).cause ?? "")
          : ""
    });
    // #endregion
    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text();
    // #region debug-point D:request-chat-non-ok
    reportDebugEvent("D", "src/main/main.ts:requestChatCompletion:non-ok", "[DEBUG] Chat completion returned a non-OK response", {
      requestUrl,
      status: response.status,
      responseText: errorText.slice(0, 1000)
    });
    // #endregion
    throw new Error(`Model request failed: ${response.status} ${errorText}`);
  }

  // #region debug-point C:request-chat-success
  reportDebugEvent("C", "src/main/main.ts:requestChatCompletion:success", "[DEBUG] Chat completion HTTP request succeeded", {
    requestUrl,
    status: response.status
  });
  // #endregion

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => ("text" in part ? part.text ?? "" : ""))
      .join("\n")
      .trim();
  }

  throw new Error("Model response did not contain text.");
};

const buildTranslationContextWindow = (
  pages: TranslationPage[],
  currentIndex: number
): { previousContext: string; nextContext: string } => {
  const previousPage = pages[currentIndex - 1];
  const nextPage = pages[currentIndex + 1];

  const previousContext = previousPage?.originalText.trim()
    ? previousPage.originalText.trim().slice(-1200)
    : "";
  const nextContext = nextPage?.originalText.trim()
    ? nextPage.originalText.trim().slice(0, 1200)
    : "";

  return { previousContext, nextContext };
};

const normalizeModelMarkdownForRenderer = (content: string): string => {
  const mathEnvironmentNames =
    "equation\\*?|align\\*?|aligned|gather\\*?|multline\\*?|cases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|split";
  const mathEnvironmentPattern = new RegExp(
    `\\\\begin\\{(${mathEnvironmentNames})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
    "g"
  );
  const assignmentThenEnvironmentPattern = new RegExp(
    `(^|\\n)[ \\t]*([^\\n]+?=)\\s*\\n+\\s*(\\\\begin\\{(?:${mathEnvironmentNames})\\}[\\s\\S]*?\\\\end\\{(?:${mathEnvironmentNames})\\})`,
    "g"
  );

  const normalized = content
    .replace(/\r\n?/g, "\n")
    .replace(
      assignmentThenEnvironmentPattern,
      (_match: string, prefix: string, leftSide: string, environment: string) =>
        `${prefix}\n\n$$\n${leftSide.trim()} ${environment.trim()}\n$$\n\n`
    )
    .replace(mathEnvironmentPattern, (match: string) => `\n\n$$\n${match.trim()}\n$$\n\n`)
    .replace(/\\\[((?:.|\n)*?)\\\]/g, (_match, expression: string) => `\n\n$$\n${expression.trim()}\n$$\n\n`)
    .replace(/\\\(((?:.|\n)*?)\\\)/g, (_match, expression: string) => `$${expression.trim()}$`)
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/(\\tag\{[^}]+\})(?=[\u4e00-\u9fffA-Z][^\n]*)/g, "$1\n\n")
    .replace(
      /(^|\n)[ \t]*(\\[^\n]*\\tag\{[^}]+\}[^\n]*)(?=\n|$)/g,
      (_match: string, prefix: string, expression: string) => `${prefix}\n\n$$\n${expression.trim()}\n$$\n\n`
    );

  return normalized
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const translateDocument = async (
  request: TranslationRequest,
  config: AppConfig
): Promise<TranslationResult> => {
  const document = request.document;
  const forceRetranslate = request.forceRetranslate === true;
  const requestedPageSet =
    request.pageNumbers && request.pageNumbers.length > 0
      ? new Set(request.pageNumbers.filter((pageNumber) => Number.isInteger(pageNumber)))
      : null;
  const cached = readTranslationCache(document, config);
  const pages: TranslationPage[] = document.pages.map((page) => {
    const cachedPage = cached?.pages.find((item) => item.pageNumber === page.pageNumber);
    if (
      !forceRetranslate &&
      cachedPage &&
      cachedPage.originalText === page.text &&
      (cachedPage.status === "done" ||
        (cachedPage.status === "empty" && !page.text.trim()))
    ) {
      return cachedPage;
    }

    if (!page.text.trim()) {
      return {
        pageNumber: page.pageNumber,
        originalText: page.text,
        translatedText: "",
        status: "empty"
      };
    }

    if (requestedPageSet && !requestedPageSet.has(page.pageNumber)) {
      return {
        pageNumber: page.pageNumber,
        originalText: page.text,
        translatedText: "",
        status: "untranslated"
      };
    }

    return {
      pageNumber: page.pageNumber,
      originalText: page.text,
      translatedText: "",
      status: "pending"
    };
  });

  const isPageInScope = (pageNumber: number): boolean =>
    !requestedPageSet || requestedPageSet.has(pageNumber);
  let completedPages = pages.filter(
    (page) => isPageInScope(page.pageNumber) && (page.status === "done" || page.status === "empty")
  ).length;
  const totalPages = pages.filter((page) => isPageInScope(page.pageNumber)).length;

  if (totalPages === 0) {
    return writeTranslationCache(document, config, pages, cached?.translatedAt ?? new Date().toISOString());
  }

  mainWindow?.webContents.send("translation:progress", {
    completedPages,
    totalPages,
    status:
      completedPages > 0
        ? `已从缓存恢复 ${completedPages}/${totalPages} 页`
        : "开始翻译"
  } satisfies TranslationProgress);

  let translatedAt = cached?.translatedAt ?? new Date().toISOString();

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];

    if (page.status === "done" || page.status === "empty" || page.status === "untranslated") {
      continue;
    }

    const progress: TranslationProgress = {
      completedPages,
      totalPages,
      currentPage: page.pageNumber,
      status: `正在翻译第 ${page.pageNumber} 页`
    };
    mainWindow?.webContents.send("translation:progress", progress);

    try {
      const { previousContext, nextContext } = buildTranslationContextWindow(pages, index);
      const translation = await requestChatCompletion(
        config,
        [
          {
            role: "system",
            content:
              "You are a professional academic translator and document normalizer. Translate the current page into polished academic prose while structuring the result as clean Markdown that renders well in a reader UI. Preserve equations, symbols, citations, section numbering, technical terms, model names, and references. If the source clearly contains headings, bullet points, enumerations, or tabular comparisons, preserve that structure using Markdown headings, lists, and tables. Do not invent new sections or tables when the source does not imply them. Some paragraphs may continue across page breaks. Use the provided previous-page and next-page context only to resolve continuity, but return only the translation of the current page.\n\nOutput contract:\n1. Return only Markdown body content, with no preface, no translator notes, and no fenced code blocks unless the source itself is code.\n2. Use only these math delimiters: inline math must use $...$ and display math must use $$...$$.\n3. Do not use \\(...\\) or \\[...\\] delimiters.\n4. Any standalone formula, aligned equation, matrix, cases block, or equation with \\tag{...} must be written as a display math block wrapped in $$...$$ on its own lines.\n5. Keep Markdown and math separated by blank lines so the renderer can parse them correctly.\n6. If the source contains Greek letters or short symbols in running text, render them as inline math like $\\alpha$, $\\beta$, and $\\Gamma$."
          },
          {
            role: "user",
            content: [
              `Translate the current academic paper page into ${config.targetLanguage}. Preserve paragraph structure as much as possible and format the result as readable Markdown.`,
              "If a paragraph starts on the previous page or continues to the next page, use the context to keep the translation coherent.",
              "Preserve formulas in LaTeX, using $...$ for inline math and $$...$$ for standalone equations only.",
              "If the page contains comparison data, metric rows, or obvious columnar content, rewrite it as a Markdown table.",
              "If a line contains equation numbering such as \\tag{1} or \\tag{2}, output that entire line as a standalone $$...$$ math block.",
              "If a line is a sequence of Greek letters or symbols, keep each symbol in inline math, for example: $\\alpha$, $\\beta$, $\\gamma$.",
              "Do not output raw LaTeX lines outside math delimiters.",
              "Return only the translated page content. Do not include explanations, translator notes, XML, JSON, or fenced code blocks unless the source itself is code.",
              previousContext ? `\nPrevious page tail context:\n${previousContext}` : "",
              `\nCurrent page text:\n${page.originalText}`,
              nextContext ? `\nNext page head context:\n${nextContext}` : ""
            ]
              .filter(Boolean)
              .join("\n\n")
          }
        ],
        config.translationModel
      );

      pages[index] = {
        pageNumber: page.pageNumber,
        originalText: page.originalText,
        translatedText: normalizeModelMarkdownForRenderer(translation),
        status: "done"
      };
    } catch (error) {
      pages[index] = {
        pageNumber: page.pageNumber,
        originalText: page.originalText,
        translatedText: "",
        status: "error",
        error: error instanceof Error ? error.message : "Unknown translation error"
      };
    }

    translatedAt = new Date().toISOString();
    writeTranslationCache(document, config, pages, translatedAt);
    completedPages = pages.filter(
      (item) => isPageInScope(item.pageNumber) && (item.status === "done" || item.status === "empty")
    ).length;
  }

  const result = writeTranslationCache(document, config, pages, translatedAt);
  mainWindow?.webContents.send("translation:progress", {
    completedPages,
    totalPages,
    status: "翻译完成"
  } satisfies TranslationProgress);

  return result;
};

const collectSkillFiles = (directoryPath: string): string[] => {
  if (!existsSync(directoryPath)) {
    return [];
  }
  return readdirSync(directoryPath)
    .filter((file) => file.endsWith(".mjs") || file.endsWith(".md"))
    .map((file) => join(directoryPath, file))
    .filter((filePath) => statSync(filePath).isFile());
};

const sanitizeSkillFileName = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

const toSkillId = (value: string): string =>
  sanitizeSkillFileName(value)
    .replace(/\.[^.]+$/, "")
    .toLowerCase() || `skill-${Date.now()}`;

const extractMarkdownFrontMatter = (
  content: string
): { metadata: Record<string, string>; body: string } => {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    return { metadata: {}, body: trimmed };
  }

  const match = trimmed.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: trimmed };
  }

  const metadata = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((result, line) => {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) {
        return result;
      }
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (key && value) {
        result[key] = value;
      }
      return result;
    }, {});

  return {
    metadata,
    body: match[2].trim()
  };
};

const parseMarkdownSkill = (filePath: string): SkillManifest | null => {
  const raw = readFileSync(filePath, "utf-8");
  const { metadata, body } = extractMarkdownFrontMatter(raw);
  const fileStem = basename(filePath, extname(filePath));
  const headingMatch = body.match(/^#\s+(.+)$/m);
  const name = metadata.name ?? headingMatch?.[1]?.trim() ?? fileStem;
  const bodyWithoutTitle = headingMatch ? body.replace(headingMatch[0], "").trim() : body.trim();
  const firstParagraph = bodyWithoutTitle
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .find(Boolean);
  const systemPrompt = bodyWithoutTitle.trim();

  if (!systemPrompt) {
    return null;
  }

  return {
    id: metadata.id ?? toSkillId(fileStem),
    name,
    description:
      metadata.description ??
      firstParagraph?.slice(0, 120) ??
      "Imported Markdown skill.",
    systemPrompt
  };
};

const loadSkills = async (): Promise<SkillListResult> => {
  const bundledSkillDirectory = getBundledSkillsDir();
  const userSkillDirectory = getUserSkillsDir();
  const skillFiles = [
    ...collectSkillFiles(bundledSkillDirectory),
    ...collectSkillFiles(userSkillDirectory)
  ];

  const loadedById = new Map<string, SkillManifest>();
  for (const filePath of skillFiles) {
    try {
      if (filePath.endsWith(".md")) {
        const markdownSkill = parseMarkdownSkill(filePath);
        if (markdownSkill?.id && markdownSkill?.name) {
          loadedById.set(markdownSkill.id, markdownSkill);
        }
        continue;
      }

      const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
      const module = (await import(moduleUrl)) as { default?: SkillManifest };
      if (module.default?.id && module.default?.name) {
        loadedById.set(module.default.id, module.default);
      }
    } catch (error) {
      console.error(`Failed to load skill ${filePath}`, error);
    }
  }

  return {
    skills: [...loadedById.values()],
    userSkillDirectory,
    bundledSkillDirectory
  };
};

const importSkillFiles = async (): Promise<SkillImportResult | null> => {
  const userSkillDirectory = getUserSkillsDir();
  const result = await dialog.showOpenDialog({
    title: "Import Skills",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Skill Files", extensions: ["mjs", "md"] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const importedFiles: string[] = [];

  for (const filePath of result.filePaths) {
    const extension = extname(filePath).toLowerCase();
    const normalizedExtension = extension === ".md" ? ".md" : ".mjs";
    const fileStem = basename(filePath, extension);
    const safeStem = sanitizeSkillFileName(fileStem) || `skill-${Date.now()}`;
    const fileName = `${safeStem}${normalizedExtension}`;
    const targetPath = join(userSkillDirectory, fileName);
    copyFileSync(filePath, targetPath);
    importedFiles.push(targetPath);
  }

  return {
    importedFiles,
    userSkillDirectory
  };
};

const openSkillsDirectory = async (): Promise<string> => {
  const userSkillDirectory = getUserSkillsDir();
  const openError = await shell.openPath(userSkillDirectory);
  if (openError) {
    throw new Error(openError);
  }
  return userSkillDirectory;
};

const buildDocumentContext = (request: ChatRequest): string => {
  if (!request.document) {
    return "No document loaded.";
  }

  const activePage =
    request.activePage === null
      ? null
      : request.document.pages.find((page) => page.pageNumber === request.activePage) ?? null;

  const translatedPage =
    request.activePage === null || !request.translation
      ? null
      : request.translation.pages.find((page) => page.pageNumber === request.activePage) ?? null;

  return [
    `Document: ${request.document.fileName}`,
    `Pages: ${request.document.pageCount}`,
    request.document.parserProvider === "mineru"
      ? "MinerU document parsing was used for this document."
      : request.document.usedOcr
        ? "OCR fallback was used for this document."
        : "Embedded PDF text was used.",
    activePage
      ? `Current original page ${activePage.pageNumber} (${activePage.extractionMethod}): ${activePage.text}`
      : "No active page selected.",
    translatedPage
      ? `Current translated page ${translatedPage.pageNumber}: ${translatedPage.translatedText}`
      : "No translated page available for current selection."
  ].join("\n\n");
};

const buildSkillSystemPrompt = (skills: SkillManifest[]): string => {
  const prompts = skills
    .map((skill) => skill.systemPrompt?.trim())
    .filter((value): value is string => Boolean(value));
  return prompts.join("\n\n");
};

const chatWithModel = async (
  request: ChatRequest,
  config: AppConfig
): Promise<{ message: string; usedSkills: SkillManifest[] }> => {
  const skillResult = await loadSkills();
  const selectedSkills = skillResult.skills.filter((skill) => request.skillIds.includes(skill.id));
  const systemMessages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are an academic reading copilot. Be concise, grounded in the provided document context, and explicitly say when the answer depends on missing content.\n\nOutput contract:\n1. Return only Markdown body content.\n2. Use only $...$ for inline math and $$...$$ for display math.\n3. Do not output raw LaTeX outside math delimiters.\n4. Any matrix, cases block, aligned equation, or equation with \\tag{...} must be written as a standalone $$...$$ block.\n5. If an expression is of the form `W =` followed by a matrix or other math environment, keep the whole expression in one display-math block.\n6. Keep Markdown paragraphs and math blocks separated by blank lines."
    }
  ];

  const skillPrompt = buildSkillSystemPrompt(selectedSkills);
  if (skillPrompt) {
    systemMessages.push({
      role: "system",
      content: skillPrompt
    });
  }

  systemMessages.push({
    role: "system",
    content: buildDocumentContext(request)
  });

  const answer = await requestChatCompletion(
    config,
    [...systemMessages, ...request.messages],
    config.chatModel
  );

  return {
    message: normalizeModelMarkdownForRenderer(answer),
    usedSkills: selectedSkills
  };
};

app.whenReady().then(async () => {
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("config:get", () => readConfig());
ipcMain.handle("config:save", (_event, nextConfig: AppConfig) => saveConfig(nextConfig));

ipcMain.handle("dialog:openPdf", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle("pdf:load", async (event, filePath: string) =>
  extractPdfText(filePath, readConfig(), (progress) => {
    event.sender.send("pdf:parseProgress", progress);
  })
);
ipcMain.handle("pdf:binary", (_event, filePath: string) => loadPdfBinary(filePath));
ipcMain.handle("translation:start", async (_event, request: TranslationRequest) =>
  translateDocument(request, readConfig())
);
ipcMain.handle("translation:cacheInfo", (_event, document: LoadedDocument) =>
  getTranslationCacheInfo(document, readConfig())
);
ipcMain.handle("translation:loadCached", (_event, document: LoadedDocument) =>
  loadCachedTranslation(document, readConfig())
);
ipcMain.handle("skills:list", () => loadSkills());
ipcMain.handle("skills:import", async () => importSkillFiles());
ipcMain.handle("skills:openDirectory", async () => openSkillsDirectory());
ipcMain.handle("chat:send", async (_event, request: ChatRequest) =>
  chatWithModel(request, readConfig())
);
