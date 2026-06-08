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

dotenv.config();

const execFileAsync = promisify(execFile);
const APP_NAME = "Paper Reader Studio";

let mainWindow: BrowserWindow | null = null;

const CONFIG_DIR_NAME = "paper-reader";
const CONFIG_FILE_NAME = "config.json";
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

const defaultConfig: AppConfig = {
  apiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY ?? "",
  chatModel: process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
  translationModel: process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-4o-mini",
  temperature: 0.2,
  targetLanguage: "中文",
  useOcrFallback: true,
  ocrLanguageHint: "en-US,zh-Hans,ja-JP"
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

const getConfigPath = (): string => join(getStateDirectory(), CONFIG_FILE_NAME);
const getBundledSkillsDir = (): string => join(app.getAppPath(), "skills");
const getUserSkillsDir = (): string => ensureDirectory(join(getStateDirectory(), "skills"));
const getTranslationCacheDir = (): string =>
  ensureDirectory(join(getStateDirectory(), "cache", "translations"));

const getOcrHelperPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "bin", "ocr-helper")
    : join(app.getAppPath(), "bin", "ocr-helper");

const readConfig = (): AppConfig => {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
    return defaultConfig;
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<AppConfig>;
    return {
      ...defaultConfig,
      ...parsed
    };
  } catch {
    return defaultConfig;
  }
};

const saveConfig = (config: AppConfig): AppConfig => {
  const merged = {
    ...defaultConfig,
    ...config
  };
  writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), "utf-8");
  return merged;
};

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

const extractPdfText = async (filePath: string, config: AppConfig): Promise<LoadedDocument> => {
  const data = new Uint8Array(readFileSync(filePath));
  const documentFingerprint = sha256(data);
  const embedded = await extractEmbeddedPdfText(data);

  let pages = embedded.pages;
  let usedOcr = false;

  if (config.useOcrFallback && shouldRunOcr(embedded.pages)) {
    try {
      const ocrResult = await runOcrHelper(filePath, config);
      const merged = mergeEmbeddedAndOcr(embedded.pages, ocrResult.pages);
      pages = merged.pages;
      usedOcr = merged.usedOcr;
    } catch (error) {
      console.error("OCR fallback failed, continuing with embedded text only.", error);
    }
  }

  return {
    filePath,
    fileName: basename(filePath),
    pageCount: embedded.pageCount,
    pages,
    usedOcr,
    documentFingerprint
  };
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

const requestChatCompletion = async (
  config: AppConfig,
  messages: ChatMessage[],
  model: string
): Promise<string> => {
  if (!config.apiKey.trim()) {
    throw new Error("Missing API key. Please set API Settings first.");
  }

  const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(buildChatPayload(messages, model, config.temperature))
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Model request failed: ${response.status} ${errorText}`);
  }

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
              "You are a professional academic translator. Preserve equations, symbols, citations, section numbering, and technical terms. Keep inline math and display math in valid LaTeX form using $...$ and $$...$$. Some paragraphs may continue across page breaks. Use the provided previous-page and next-page context only to resolve continuity, but return only the translation of the current page."
          },
          {
            role: "user",
            content: [
              `Translate the current academic paper page into ${config.targetLanguage}. Preserve paragraph structure as much as possible.`,
              "If a paragraph starts on the previous page or continues to the next page, use the context to keep the translation coherent.",
              "Return only the translated text for the current page. Do not include explanations, notes, or headings.",
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
        translatedText: translation.trim(),
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
    request.document.usedOcr ? "OCR fallback was used for this document." : "Embedded PDF text was used.",
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
        "You are an academic reading copilot. Be concise, grounded in the provided document context, and explicitly say when the answer depends on missing content."
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
    message: answer,
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

ipcMain.handle("pdf:load", async (_event, filePath: string) => extractPdfText(filePath, readConfig()));
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
