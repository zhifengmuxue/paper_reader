import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type {
  AppConfig,
  ChatMessage,
  LoadedDocument,
  OcrProvider,
  PdfParseProgress,
  SkillManifest,
  TranslationCacheInfo,
  TranslationPage,
  TranslationProgress,
  TranslationRequest,
  TranslationResult
} from "../shared/types";

type BusyState = "idle" | "loading-pdf" | "translating" | "chatting";
type PaneId = "original" | "translation" | "chat";
type TranslationView = "all" | "page";

interface PreviewDocumentInfo {
  filePath: string;
  fileName: string;
  pageCount: number;
}

const defaultConfig: AppConfig = {
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  chatModel: "gpt-4o-mini",
  translationModel: "gpt-4o-mini",
  temperature: 0.2,
  targetLanguage: "中文",
  useOcrFallback: true,
  ocrProvider: "native",
  ocrLanguageHint: "en-US,zh-Hans,ja-JP"
};

const paneOrder: PaneId[] = ["original", "translation", "chat"];

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export function App() {
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [draftConfig, setDraftConfig] = useState<AppConfig>(defaultConfig);
  const [showSettings, setShowSettings] = useState(false);
  const [busyState, setBusyState] = useState<BusyState>("idle");
  const [statusText, setStatusText] = useState("就绪");
  const [documentData, setDocumentData] = useState<LoadedDocument | null>(null);
  const [previewDocument, setPreviewDocument] = useState<PreviewDocumentInfo | null>(null);
  const [parseProgress, setParseProgress] = useState<PdfParseProgress | null>(null);
  const [translation, setTranslation] = useState<TranslationResult | null>(null);
  const [translationProgress, setTranslationProgress] = useState<TranslationProgress | null>(null);
  const [translationCacheInfo, setTranslationCacheInfo] = useState<TranslationCacheInfo | null>(null);
  const [activePage, setActivePage] = useState<number | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [jumpPage, setJumpPage] = useState("1");
  const [pdfUrl, setPdfUrl] = useState("");
  const [activePdfImage, setActivePdfImage] = useState("");
  const [pdfThumbs, setPdfThumbs] = useState<Record<number, string>>({});
  const [translationView, setTranslationView] = useState<TranslationView>("all");
  const [forceRetranslate, setForceRetranslate] = useState(false);
  const [paneCollapsed, setPaneCollapsed] = useState<Record<PaneId, boolean>>({
    original: false,
    translation: false,
    chat: false
  });
  const originalPaneRef = useRef<HTMLDivElement | null>(null);
  const originalComparePaneRef = useRef<HTMLDivElement | null>(null);
  const translationComparePaneRef = useRef<HTMLDivElement | null>(null);
  const originalCompareCardRefs = useRef<Record<number, HTMLElement | null>>({});
  const translationCompareCardRefs = useRef<Record<number, HTMLElement | null>>({});
  const compareScrollSyncLockRef = useRef(false);
  const previewRenderTokenRef = useRef(0);
  const loadingPdfPathRef = useRef<string | null>(null);
  const api = typeof window !== "undefined" ? window.paperReaderApi : undefined;

  const describeConfiguredOcr = (currentConfig: AppConfig): string => {
    if (!currentConfig.useOcrFallback || currentConfig.ocrProvider === "none") {
      return "当前已关闭 OCR 补全";
    }
    if (currentConfig.ocrProvider === "mineru") {
      return "当前使用 MinerU 作为 OCR 模块";
    }
    return "当前使用原生 OCR 补全稀疏页面";
  };

  useEffect(() => {
    if (!api) {
      setErrorMessage(
        "Desktop bridge failed to load. The preload script is missing or broken, so file access and model features are unavailable."
      );
      setStatusText("Bridge unavailable");
      return;
    }
    void initialize();
    const unsubscribePdfParse = api.onPdfParseProgress((progress) => {
      if (loadingPdfPathRef.current && progress.filePath !== loadingPdfPathRef.current) {
        return;
      }
      setParseProgress(progress);
      setStatusText(progress.status);
    });
    const unsubscribe = api.onTranslationProgress((progress) => {
      setTranslationProgress(progress);
      setStatusText(progress.status);
    });
    return () => {
      unsubscribePdfParse();
      unsubscribe();
    };
  }, [api]);

  const currentFilePath = documentData?.filePath ?? previewDocument?.filePath ?? null;
  const currentFileName = documentData?.fileName ?? previewDocument?.fileName ?? null;
  const currentPageCount = documentData?.pageCount ?? previewDocument?.pageCount ?? 0;

  useEffect(() => {
    return () => {
      if (pdfUrl) {
        URL.revokeObjectURL(pdfUrl);
      }
    };
  }, [pdfUrl]);

  const pageOptions = useMemo(() => {
    if (currentPageCount === 0) {
      return [];
    }
    return Array.from({ length: currentPageCount }, (_, index) => ({
      value: index + 1,
      label: `第 ${index + 1} 页`
    }));
  }, [currentPageCount]);

  const currentTranslatedPage = useMemo(
    () => translation?.pages.find((page) => page.pageNumber === activePage) ?? null,
    [translation, activePage]
  );

  const translationPageMap = useMemo(
    () => new Map((translation?.pages ?? []).map((page) => [page.pageNumber, page])),
    [translation]
  );

  const comparisonRows = useMemo(() => {
    if (!documentData) {
      return [];
    }

    return documentData.pages.map((page) => ({
      pageNumber: page.pageNumber,
      originalText: page.text,
      translationPage: translationPageMap.get(page.pageNumber) ?? null
    }));
  }, [documentData, translationPageMap]);

  useEffect(() => {
    if (translationView !== "all" || paneCollapsed.original || paneCollapsed.translation) {
      return;
    }

    const originalPane = originalComparePaneRef.current;
    const translationPane = translationComparePaneRef.current;
    if (!originalPane || !translationPane) {
      return;
    }

    const syncScroll = (source: HTMLDivElement, target: HTMLDivElement) => {
      if (compareScrollSyncLockRef.current) {
        return;
      }
      compareScrollSyncLockRef.current = true;
      target.scrollTop = source.scrollTop;
      requestAnimationFrame(() => {
        compareScrollSyncLockRef.current = false;
      });
    };

    const handleOriginalScroll = () => syncScroll(originalPane, translationPane);
    const handleTranslationScroll = () => syncScroll(translationPane, originalPane);

    originalPane.addEventListener("scroll", handleOriginalScroll);
    translationPane.addEventListener("scroll", handleTranslationScroll);

    return () => {
      originalPane.removeEventListener("scroll", handleOriginalScroll);
      translationPane.removeEventListener("scroll", handleTranslationScroll);
    };
  }, [translationView, paneCollapsed.original, paneCollapsed.translation, comparisonRows.length]);

  useEffect(() => {
    if (translationView !== "all" || paneCollapsed.original || paneCollapsed.translation || comparisonRows.length === 0) {
      return;
    }

    let frameId = 0;
    const syncCardHeights = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        for (const row of comparisonRows) {
          const originalCard = originalCompareCardRefs.current[row.pageNumber];
          const translationCard = translationCompareCardRefs.current[row.pageNumber];
          if (!originalCard || !translationCard) {
            continue;
          }
          originalCard.style.minHeight = "";
          translationCard.style.minHeight = "";
        }

        for (const row of comparisonRows) {
          const originalCard = originalCompareCardRefs.current[row.pageNumber];
          const translationCard = translationCompareCardRefs.current[row.pageNumber];
          if (!originalCard || !translationCard) {
            continue;
          }
          const nextHeight = Math.max(originalCard.offsetHeight, translationCard.offsetHeight);
          originalCard.style.minHeight = `${nextHeight}px`;
          translationCard.style.minHeight = `${nextHeight}px`;
        }
      });
    };

    syncCardHeights();
    window.addEventListener("resize", syncCardHeights);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", syncCardHeights);
    };
  }, [comparisonRows, paneCollapsed.original, paneCollapsed.translation, translationView]);

  const translationSummaryText = useMemo(() => {
    if (!translation) {
      return "还没有翻译内容";
    }
    const doneCount = translation.pages.filter((page) => page.status === "done").length;
    const emptyCount = translation.pages.filter((page) => page.status === "empty").length;
    const errorCount = translation.pages.filter((page) => page.status === "error").length;
    return `已翻译 ${doneCount} 页${emptyCount > 0 ? ` · 空白 ${emptyCount} 页` : ""}${errorCount > 0 ? ` · 失败 ${errorCount} 页` : ""}`;
  }, [translation]);

  const layoutClassName = useMemo(() => {
    const visibleCount = paneOrder.filter((paneId) => !paneCollapsed[paneId]).length;
    return [
      "workspace",
      visibleCount === 1 ? "workspace-single" : "",
      visibleCount === 2 ? "workspace-double" : "",
      paneCollapsed.original ? "original-collapsed" : "",
      paneCollapsed.translation ? "translation-collapsed" : "",
      paneCollapsed.chat ? "chat-collapsed" : ""
    ]
      .filter(Boolean)
      .join(" ");
  }, [paneCollapsed]);

  const initialize = async () => {
    try {
      const [savedConfig, loadedSkills] = await Promise.all([api!.getConfig(), api!.listSkills()]);
      setConfig(savedConfig);
      setDraftConfig(savedConfig);
      setSkills(loadedSkills.skills);
      setSelectedSkillIds(loadedSkills.skills.map((skill) => skill.id));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to initialize application.");
    }
  };

  const loadPdfPreview = async (filePath: string, preferredPage?: number): Promise<PreviewDocumentInfo> => {
    if (!api) {
      throw new Error("Desktop bridge unavailable.");
    }
    const renderToken = previewRenderTokenRef.current + 1;
    previewRenderTokenRef.current = renderToken;
    const data = await api.loadPdfBinary(filePath);
    const normalized = new Uint8Array(data.byteLength);
    normalized.set(data);
    const blob = new Blob([normalized], { type: "application/pdf" });
    const nextUrl = URL.createObjectURL(blob);
    setPdfUrl((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous);
      }
      return nextUrl;
    });
    setPdfThumbs({});
    setActivePdfImage("");

    const pdf = await pdfjs.getDocument({ data }).promise;
    const targetPage = preferredPage ?? activePage ?? 1;
    const image = await renderPdfPageImage(pdf, targetPage);
    if (previewRenderTokenRef.current === renderToken) {
      setActivePdfImage(image);
    }

    const previewCount = Math.min(pdf.numPages, 18);
    void (async () => {
      for (let index = 1; index <= previewCount; index += 1) {
        const page = await pdf.getPage(index);
        const viewport = page.getViewport({ scale: 0.3 });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) {
          continue;
        }
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: context, viewport }).promise;
        const thumbnail = canvas.toDataURL("image/png");
        if (previewRenderTokenRef.current !== renderToken) {
          return;
        }
        setPdfThumbs((previous) => ({
          ...previous,
          [index]: thumbnail
        }));
      }
    })();

    const nextPreviewDocument = {
      filePath,
      fileName: getFileNameFromPath(filePath),
      pageCount: pdf.numPages
    };
    setPreviewDocument(nextPreviewDocument);
    return nextPreviewDocument;
  };

  const renderActivePdfPage = async (filePath: string, pageNumber: number) => {
    if (!api) {
      throw new Error("Desktop bridge unavailable.");
    }
    const data = await api.loadPdfBinary(filePath);
    const pdf = await pdfjs.getDocument({ data }).promise;
    const image = await renderPdfPageImage(pdf, pageNumber);
    setActivePdfImage(image);
  };

  const openPdf = async () => {
    setErrorMessage("");
    if (!api) {
      setErrorMessage("Desktop bridge unavailable.");
      return;
    }
    const filePath = await api.openPdfDialog();
    if (!filePath) {
      return;
    }

    loadingPdfPathRef.current = filePath;
    setBusyState("loading-pdf");
    setStatusText("正在准备 PDF 预览");
    setDocumentData(null);
    setPreviewDocument(null);
    setParseProgress(null);
    setTranslation(null);
    setTranslationCacheInfo(null);
    setTranslationProgress(null);
    setForceRetranslate(false);
    setChatMessages([]);
    let previewReady = false;
    try {
      await loadPdfPreview(filePath, 1);
      previewReady = true;
      const firstPage = 1;
      setActivePage(firstPage);
      setJumpPage(String(firstPage));
      setTranslationView("page");
      setStatusText("PDF 预览已就绪，后台正在解析文档");

      const loaded = await api.loadPdf(filePath);
      const cacheInfo = await api.getTranslationCacheInfo(loaded);
      const cachedTranslation = await api.loadCachedTranslation(loaded);
      setDocumentData(loaded);
      setPreviewDocument({
        filePath: loaded.filePath,
        fileName: loaded.fileName,
        pageCount: loaded.pageCount
      });
      setTranslation(cachedTranslation);
      setTranslationCacheInfo(cacheInfo);
      setTranslationProgress(null);
      setParseProgress(null);
      setActivePage(loaded.pages[0]?.pageNumber ?? firstPage);
      setJumpPage(String(loaded.pages[0]?.pageNumber ?? firstPage));
      setTranslationView(cachedTranslation ? "all" : "page");
      setStatusText(cachedTranslation ? `已载入 ${loaded.fileName}，并恢复翻译缓存` : `已载入 ${loaded.fileName}`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load PDF.");
      setStatusText(previewReady ? "PDF 预览已就绪，但后台解析失败" : "PDF 载入失败");
    } finally {
      loadingPdfPathRef.current = null;
      setBusyState("idle");
    }
  };

  const importSkills = async () => {
    setErrorMessage("");
    try {
      if (!api) {
        throw new Error("Desktop bridge unavailable.");
      }
      const result = await api.importSkills();
      if (!result) {
        return;
      }
      const loadedSkills = await api.listSkills();
      setSkills(loadedSkills.skills);
      setSelectedSkillIds(loadedSkills.skills.map((skill) => skill.id));
      setStatusText(`已导入 ${result.importedFiles.length} 个 skill`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Skill import failed.");
    }
  };

  const startTranslation = async () => {
    if (!documentData) {
      setErrorMessage("请先导入 PDF。");
      return;
    }

    const request: TranslationRequest = {
      document: documentData,
      forceRetranslate
    };

    setErrorMessage("");
    setBusyState("translating");
    setTranslationProgress(null);
    setStatusText(forceRetranslate ? "开始重新翻译全文" : "开始翻译全文");
    try {
      if (!api) {
        throw new Error("Desktop bridge unavailable.");
      }
      const result = await api.translateDocument(request);
      setTranslation(result);
      setTranslationCacheInfo(await api.getTranslationCacheInfo(documentData));
      setTranslationView("all");
      setForceRetranslate(false);
      setStatusText(`翻译完成，共处理 ${documentData.pageCount} 页`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Translation failed.");
      setStatusText("翻译失败");
    } finally {
      setBusyState("idle");
    }
  };

  const saveSettings = async () => {
    setErrorMessage("");
    try {
      if (!api) {
        throw new Error("Desktop bridge unavailable.");
      }
      const saved = await api.saveConfig(draftConfig);
      setConfig(saved);
      setDraftConfig(saved);
      setShowSettings(false);
      setStatusText("已从 .env 重新加载配置，修改 .env 后需重启应用");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to save settings.");
    }
  };

  const sendChat = async () => {
    const content = chatInput.trim();
    if (!content) {
      return;
    }

    const nextMessages: ChatMessage[] = [...chatMessages, { role: "user", content }];
    setChatMessages(nextMessages);
    setChatInput("");
    setBusyState("chatting");
    setStatusText("正在等待模型回复");
    setErrorMessage("");

    try {
      if (!api) {
        throw new Error("Desktop bridge unavailable.");
      }
      const response = await api.sendChat({
        messages: nextMessages,
        document: documentData,
        translation,
        activePage,
        skillIds: selectedSkillIds
      });
      setChatMessages((previous) => [...previous, { role: "assistant", content: response.message }]);
      setStatusText("模型已回复");
    } catch (error) {
      setChatMessages((previous) => previous.slice(0, -1));
      setChatInput(content);
      setErrorMessage(error instanceof Error ? error.message : "Chat request failed.");
      setStatusText("对话失败");
    } finally {
      setBusyState("idle");
    }
  };

  const togglePane = (paneId: PaneId) => {
    setPaneCollapsed((current) => {
      const next = { ...current, [paneId]: !current[paneId] };
      if (paneOrder.every((id) => next[id])) {
        next[paneId] = false;
      }
      return next;
    });
  };

  const goToPage = (pageNumber: number) => {
    setActivePage(pageNumber);
    setJumpPage(String(pageNumber));
    if (currentFilePath) {
      void renderActivePdfPage(currentFilePath, pageNumber);
    }
  };

  const submitJumpPage = () => {
    const parsed = Number(jumpPage);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > currentPageCount) {
      return;
    }
    goToPage(parsed);
    if (translationView === "page" || !documentData) {
      originalPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      originalCompareCardRefs.current[parsed]?.scrollIntoView({
        block: "start",
        behavior: "smooth"
      });
      translationCompareCardRefs.current[parsed]?.scrollIntoView({
        block: "start",
        behavior: "smooth"
      });
    }
  };

  const goToPreviousPage = () => {
    if (currentPageCount === 0 || activePage === null) {
      return;
    }
    const nextPage = Math.max(1, activePage - 1);
    goToPage(nextPage);
  };

  const goToNextPage = () => {
    if (currentPageCount === 0 || activePage === null) {
      return;
    }
    const nextPage = Math.min(currentPageCount, activePage + 1);
    goToPage(nextPage);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Paper Reader Studio</div>
          <h1>论文原文、译文与对话工作台</h1>
          {skills.length > 0 ? (
            <div className="topbar-skill-strip">
              <span className="topbar-skill-label">当前 Skills</span>
              <div className="topbar-skill-list">
                {skills.map((skill) => (
                  <span key={skill.id} className="topbar-skill-chip">
                    {skill.name}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="topbar-actions">
          <button onClick={openPdf} disabled={busyState !== "idle"}>
            导入 PDF
          </button>
          <button onClick={startTranslation} disabled={!documentData || busyState !== "idle"}>
            {translation ? "重新翻译全文" : "开始翻译"}
          </button>
          <button
            className={`secondary ${translationView === "all" ? "view-toggle-active" : ""}`}
            onClick={() => setTranslationView("all")}
            disabled={!documentData}
          >
            全部译文
          </button>
          <button
            className={`secondary ${translationView === "page" ? "view-toggle-active" : ""}`}
            onClick={() => setTranslationView("page")}
            disabled={!documentData}
          >
            当前页对照
          </button>
          <label className="topbar-checkbox">
            <input
              type="checkbox"
              checked={forceRetranslate}
              onChange={(event) => setForceRetranslate(event.target.checked)}
              disabled={!documentData || busyState !== "idle"}
            />
            <span>重新翻译</span>
          </label>
          <button className="secondary" onClick={importSkills} disabled={busyState !== "idle"}>
            导入 Skill
          </button>
          <button className="secondary" onClick={() => setShowSettings((current) => !current)}>
            API 设置
          </button>
        </div>
      </header>

      <section className="statusbar">
        <span>{statusText}</span>
        {currentFileName ? <span>{currentFileName}</span> : <span>还没有载入 PDF</span>}
        {translationProgress ? (
          <span>
            翻译进度 {translationProgress.completedPages}/{translationProgress.totalPages}
          </span>
        ) : parseProgress ? (
          <span>解析进度 {parseProgress.percent}%</span>
        ) : (
          <span>{translationCacheInfo?.hasCache ? `缓存 ${translationCacheInfo.completedPages}/${translationCacheInfo.totalPages}` : "当前没有翻译任务"}</span>
        )}
      </section>

      {documentData || previewDocument ? (
        <section className="statusbar document-meta">
          <span>
            {documentData
              ? documentData.parserProvider === "mineru"
                ? "当前使用 MinerU 结构化解析"
                : documentData.usedOcr
                  ? describeConfiguredOcr(config)
                  : config.useOcrFallback && config.ocrProvider !== "none"
                    ? `当前使用 PDF 内嵌文本，必要时回退到${config.ocrProvider === "mineru" ? " MinerU OCR" : "原生 OCR"}`
                    : "当前使用 PDF 内嵌文本，OCR 补全已关闭"
              : "PDF 预览已就绪，后台正在解析"}
          </span>
          <span>页数：{currentPageCount}</span>
          <span>
            {documentData
              ? translationCacheInfo?.hasCache
                ? `缓存时间：${translationCacheInfo.translatedAt ?? "未知"}`
                : "尚未生成翻译缓存"
              : parseProgress?.status ?? "等待后台解析启动"}
          </span>
        </section>
      ) : null}

      {showSettings ? (
        <section className="settings-panel">
          <div className="panel-title-row">
            <h2>API 设置</h2>
            <button className="secondary" onClick={saveSettings}>
              从 .env 刷新
            </button>
          </div>
          <div className="settings-grid">
            <label>
              <span>API Base URL</span>
              <input
                value={draftConfig.apiBaseUrl}
                onChange={(event) => setDraftConfig({ ...draftConfig, apiBaseUrl: event.target.value })}
              />
            </label>
            <label>
              <span>API Key</span>
              <input
                type="password"
                value={draftConfig.apiKey}
                onChange={(event) => setDraftConfig({ ...draftConfig, apiKey: event.target.value })}
              />
            </label>
            <label>
              <span>Chat Model</span>
              <input
                value={draftConfig.chatModel}
                onChange={(event) => setDraftConfig({ ...draftConfig, chatModel: event.target.value })}
              />
            </label>
            <label>
              <span>Translation Model</span>
              <input
                value={draftConfig.translationModel}
                onChange={(event) => setDraftConfig({ ...draftConfig, translationModel: event.target.value })}
              />
            </label>
            <label>
              <span>OCR Fallback</span>
              <select
                value={draftConfig.useOcrFallback ? "on" : "off"}
                onChange={(event) =>
                  setDraftConfig((current) => {
                    const enabled = event.target.value === "on";
                    return {
                      ...current,
                      useOcrFallback: enabled,
                      ocrProvider: enabled && current.ocrProvider === "none" ? "native" : current.ocrProvider
                    };
                  })
                }
              >
                <option value="on">开启</option>
                <option value="off">关闭</option>
              </select>
            </label>
            <label>
              <span>OCR Provider</span>
              <select
                value={draftConfig.useOcrFallback ? draftConfig.ocrProvider : "none"}
                onChange={(event) =>
                  setDraftConfig((current) => {
                    const provider = event.target.value as OcrProvider;
                    return {
                      ...current,
                      ocrProvider: provider,
                      useOcrFallback: provider !== "none"
                    };
                  })
                }
              >
                <option value="none">关闭 OCR</option>
                <option value="native">原生 OCR</option>
                <option value="mineru">MinerU (uv)</option>
              </select>
            </label>
            <label>
              <span>OCR Languages</span>
              <input
                value={draftConfig.ocrLanguageHint}
                onChange={(event) => setDraftConfig({ ...draftConfig, ocrLanguageHint: event.target.value })}
              />
            </label>
            <label>
              <span>Target Language</span>
              <input
                value={draftConfig.targetLanguage}
                onChange={(event) => setDraftConfig({ ...draftConfig, targetLanguage: event.target.value })}
              />
            </label>
            <label>
              <span>Temperature</span>
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={draftConfig.temperature}
                onChange={(event) => setDraftConfig({ ...draftConfig, temperature: Number(event.target.value) })}
              />
            </label>
          </div>
          <p className="muted">当前配置完全来自项目根目录的 `.env`。可通过 `OCR_PROVIDER=none|native|mineru` 选择 OCR 模块，`mineru` 默认会通过 `uv run` 启动。修改 `.env` 后请重启应用，再点击按钮重新加载显示。</p>
        </section>
      ) : null}

      {errorMessage ? <section className="error-banner">{errorMessage}</section> : null}

      <main className={layoutClassName}>
        <section className={`pane pane-original ${paneCollapsed.original ? "collapsed" : ""}`}>
          <PaneHeader
            title="原文"
            subtitle={documentData ? "原始 PDF 页面" : pdfUrl ? "PDF 预览已就绪，后台解析中" : "先导入 PDF"}
            collapsed={paneCollapsed.original}
            onToggle={() => togglePane("original")}
          >
            {!paneCollapsed.original ? (
              <div className="page-controls compact-page-controls">
                <button className="secondary" onClick={goToPreviousPage} disabled={activePage === null || activePage <= 1}>
                  上一页
                </button>
                <button
                  className="secondary"
                  onClick={goToNextPage}
                  disabled={currentPageCount === 0 || activePage === null || activePage >= currentPageCount}
                >
                  下一页
                </button>
              </div>
            ) : null}
          </PaneHeader>

          {!paneCollapsed.original ? (
            <div className="pane-scroll pane-pdf" ref={originalPaneRef}>
              {pdfUrl ? (
                !documentData || translationView === "page" ? (
                  <>
                    <div className="pdf-stage pdf-stage-large">
                      <iframe src={`${pdfUrl}#page=${activePage ?? 1}&view=FitH`} title="Original PDF" />
                    </div>
                    <div className="thumbnail-strip">
                      {Array.from({ length: currentPageCount }, (_, index) => index + 1).map((pageNumber) => (
                        <button
                          key={pageNumber}
                          className={`thumbnail-card ${activePage === pageNumber ? "active" : ""}`}
                          onClick={() => goToPage(pageNumber)}
                        >
                          {pdfThumbs[pageNumber] ? (
                            <img src={pdfThumbs[pageNumber]} alt={`Page ${pageNumber}`} />
                          ) : (
                            <span>第 {pageNumber} 页</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="comparison-list" ref={originalComparePaneRef}>
                    {comparisonRows.map((row) => (
                      <article
                        key={row.pageNumber}
                        ref={(node) => {
                          originalCompareCardRefs.current[row.pageNumber] = node;
                        }}
                        className={`comparison-card ${activePage === row.pageNumber ? "active" : ""}`}
                      >
                        <div className="comparison-card-head">
                          <button className="secondary" onClick={() => goToPage(row.pageNumber)}>
                            第 {row.pageNumber} 页
                          </button>
                          <span className="translation-status done">原文</span>
                        </div>
                        <div className="comparison-card-body markdown-body">{renderOriginalBlock(row.originalText)}</div>
                      </article>
                    ))}
                  </div>
                )
              ) : (
                <EmptyState
                  title="还没有 PDF"
                  description="点击上方“导入 PDF”按钮，选择论文后这里会直接显示原始 PDF。"
                />
              )}
            </div>
          ) : (
            <CollapsedHint label="原文 PDF" />
          )}
        </section>

        <section className={`pane pane-translation ${paneCollapsed.translation ? "collapsed" : ""}`}>
          <PaneHeader
            title="译文"
            subtitle={translation ? `${translation.targetLanguage} · ${translation.model}` : "翻译后这里显示译文"}
            collapsed={paneCollapsed.translation}
            onToggle={() => togglePane("translation")}
          />

          {!paneCollapsed.translation ? (
            <div className="pane-scroll pane-pdf">
              {documentData ? (
                translationView === "page" ? (
                  <div className="translated-sheet">
                    <div className="pdf-stage pdf-stage-large translated-canvas">
                      {activePdfImage ? (
                        <>
                          <img src={activePdfImage} alt={`Translated page ${activePage ?? ""}`} />
                          <div className="translation-overlay">
                            <div className="translation-overlay-inner">
                              <div className={`translation-badge status-${currentTranslatedPage?.status ?? "untranslated"}`}>
                                {getTranslationStatusLabel(currentTranslatedPage, activePage)}
                              </div>
                              <div className="translation-text-block markdown-body">
                                {renderTranslationBlock(currentTranslatedPage)}
                              </div>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="empty-mini">正在准备译文页面...</div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="comparison-list" ref={translationComparePaneRef}>
                    {comparisonRows.length > 0 ? (
                      comparisonRows.map((row) => (
                        <article
                          key={row.pageNumber}
                          ref={(node) => {
                            translationCompareCardRefs.current[row.pageNumber] = node;
                          }}
                          className={`comparison-card translation-card ${activePage === row.pageNumber ? "active" : ""}`}
                        >
                          <div className="comparison-card-head">
                            <button className="secondary" onClick={() => goToPage(row.pageNumber)}>
                              第 {row.pageNumber} 页
                            </button>
                            <span className={`translation-status ${row.translationPage?.status ?? "untranslated"}`}>
                              {getPageStatusText(row.translationPage)}
                            </span>
                          </div>
                          <div className="comparison-card-body markdown-body">
                            {renderTranslationBlock(row.translationPage)}
                          </div>
                        </article>
                      ))
                    ) : (
                      <EmptyState
                        title="还没有译文"
                        description="点击“开始翻译”后，这里会按页显示所有已经完成的翻译内容。"
                      />
                    )}
                  </div>
                )
              ) : (
                <EmptyState
                  title="还没有译文"
                  description="导入 PDF 后可直接开始全文翻译。"
                />
              )}
            </div>
          ) : (
            <CollapsedHint label="译文" />
          )}
        </section>

        <section className={`pane pane-chat ${paneCollapsed.chat ? "collapsed" : ""}`}>
          <PaneHeader
            title="对话"
            subtitle="基于当前论文和当前页的模型助手"
            collapsed={paneCollapsed.chat}
            onToggle={() => togglePane("chat")}
          />

          {!paneCollapsed.chat ? (
            <>
              <div className="chat-thread">
                {chatMessages.length === 0 ? (
                  <EmptyState
                    title="还没有对话"
                    description="你可以直接问：这篇论文的贡献是什么、当前页在讲什么、这个公式是什么意思、译文哪里不准确。"
                  />
                ) : (
                  chatMessages.map((message, index) => (
                    <article key={`${message.role}-${index}`} className={`chat-message ${message.role}`}>
                      <header>{message.role === "user" ? "你" : "助手"}</header>
                      {message.role === "assistant" ? (
                        <div className="markdown-body">{renderChatMessage(message.content)}</div>
                      ) : (
                        <p>{message.content}</p>
                      )}
                    </article>
                  ))
                )}
              </div>

              <div className="chat-composer">
                <textarea
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="输入你要问的问题，例如：总结第 3 页的方法，并指出这页翻译里可能的术语问题。"
                  rows={5}
                />
                <button onClick={() => void sendChat()} disabled={busyState !== "idle"}>
                  发送
                </button>
              </div>
            </>
          ) : (
            <CollapsedHint label="对话" />
          )}
        </section>
      </main>
    </div>
  );
}

function PaneHeader(props: {
  title: string;
  subtitle: string;
  collapsed: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="pane-header">
      <div>
        <span className="pane-title">{props.title}</span>
        <span className="pane-subtitle">{props.subtitle}</span>
      </div>
      <div className="pane-header-actions">
        {props.children}
        <button className="secondary pane-toggle" onClick={props.onToggle}>
          {props.collapsed ? "展开" : "最小化"}
        </button>
      </div>
    </div>
  );
}

function CollapsedHint(props: { label: string }) {
  return <div className="collapsed-hint">{props.label}</div>;
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div className="empty-state">
      <h3>{props.title}</h3>
      <p>{props.description}</p>
    </div>
  );
}

function renderOriginalContent(text: string) {
  return text.trim() ? text : "这一页没有提取到原文文本。";
}

function renderOriginalBlock(text: string) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
      {normalizeLatexMarkdown(renderOriginalContent(text))}
    </ReactMarkdown>
  );
}

function getFileNameFromPath(filePath: string) {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] || filePath;
}

function normalizeLatexMarkdown(content: string) {
  const blockEnvironmentPattern =
    /\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?|cases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|split)\}([\s\S]*?)\\end\{\1\}/g;

  const normalized = content
    .replace(/\\\$/g, "$")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/(\\tag\{[^}]+\})(?=[\u4e00-\u9fffA-Z][^\n]*)/g, "$1\n\n")
    .replace(
      /(^|\n)[ \t]*(\\[^\n]*\\tag\{[^}]+\}[^\n]*)(?=\n|$)/g,
      (_match: string, prefix: string, expression: string) => `${prefix}\n\n$$\n${expression.trim()}\n$$\n\n`
    )
    .replace(blockEnvironmentPattern, (match: string) => {
      const trimmed = match.trim();
      if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
        return trimmed;
      }
      return `\n\n$$\n${trimmed}\n$$\n\n`;
    })
    .replace(/\\\[((?:.|\n)*?)\\\]/g, (_, expression: string) => `\n\n$$\n${expression.trim()}\n$$\n\n`)
    .replace(/\\\(((?:.|\n)*?)\\\)/g, (_match, expression: string) => `$${expression.trim()}$`);

  return normalized
    .split(/\n{2,}/)
    .map((block) => normalizeLatexParagraph(block))
    .join("\n\n");
}

function normalizeLatexParagraph(block: string) {
  const trimmed = block.trim();
  if (!trimmed) {
    return block;
  }

  if (shouldKeepBlockAsIs(trimmed)) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  if (lines.length === 1) {
    return isLikelyLatexBlock(trimmed) ? `$$\n${trimmed}\n$$` : trimmed;
  }

  const output: string[] = [];
  let textBuffer: string[] = [];
  let mathBuffer: string[] = [];

  const flushText = () => {
    if (textBuffer.length > 0) {
      output.push(textBuffer.join("\n").trim());
      textBuffer = [];
    }
  };

  const flushMath = () => {
    if (mathBuffer.length > 0) {
      output.push(`$$\n${mathBuffer.join("\n").trim()}\n$$`);
      mathBuffer = [];
    }
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      flushMath();
      flushText();
      continue;
    }

    if (isLikelyLatexLine(trimmedLine)) {
      flushText();
      mathBuffer.push(trimmedLine);
      continue;
    }

    flushMath();
    textBuffer.push(trimmedLine);
  }

  flushMath();
  flushText();

  return output.join("\n\n");
}

function shouldKeepBlockAsIs(trimmed: string) {
  return (
    trimmed.startsWith("$$") ||
    trimmed.startsWith("```") ||
    trimmed.startsWith("|") ||
    trimmed.startsWith(">") ||
    trimmed.startsWith("#") ||
    /(?:^|[\s(])\$[^$\n]+(?:\\\$)?\$(?:[,\s]|$)/.test(trimmed) ||
    /^[-*+] /.test(trimmed) ||
    /^\d+\. /.test(trimmed)
  );
}

function isLikelyLatexBlock(block: string) {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return false;
  }

  const latexCommandCount = (block.match(/\\[A-Za-z]+/g) ?? []).length;
  const hasMathStructure = /[_^{}]|\\\||\||=|\\cdots|\\vdots|\\ddots|\\left|\\right|\\mid|\\ge|\\le|\\neq|\\approx|\\to|\\mapsto|\\tag\{/.test(
    block
  );
  const hasMathCommand = /\\(frac|sum|prod|int|mathcal|mathbf|mathrm|operatorname|text|hat|bar|bm|lambda|theta|alpha|beta|gamma|delta|sigma|omega|Gamma|Delta|Theta|Lambda|Sigma|Omega|nabla|partial|cdot|times|max|min|arg|max|exp|log|sin|cos|tan)/.test(
    block
  );
  const containsSentencePunctuation = /[.!?][\s\n]|[A-Za-z]{4,}.*[.!?]$/.test(block);
  const averageLineLength = lines.reduce((total, line) => total + line.length, 0) / lines.length;

  if (containsSentencePunctuation && latexCommandCount < 2) {
    return false;
  }

  if (lines.length > 1) {
    return latexCommandCount >= 1 && (hasMathStructure || hasMathCommand);
  }

  return (
    latexCommandCount >= 1 &&
    (hasMathStructure || hasMathCommand) &&
    (averageLineLength <= 160 || latexCommandCount >= 2)
  );
}

function isLikelyLatexLine(line: string) {
  if (shouldKeepBlockAsIs(line)) {
    return false;
  }

  if (/(?:^|[\s(])\$[^$\n]+(?:\\\$)?\$(?:[,\s]|$)/.test(line)) {
    return false;
  }

  const latexCommandCount = (line.match(/\\[A-Za-z]+/g) ?? []).length;
  const hasMathStructure = /[_^{}=]|\\tag\{|\\mid|\\ge|\\le|\\neq|\\approx|\\to|\\cdots|\\vdots|\\ddots|\\left|\\right/.test(
    line
  );
  const hasMathCommand = /\\(frac|sum|prod|int|mathcal|mathbf|mathrm|operatorname|text|hat|bar|bm|lambda|theta|alpha|beta|gamma|delta|sigma|omega|Gamma|Delta|Theta|Lambda|Sigma|Omega|nabla|partial|cdot|times|max|min|arg|max|exp|log|sin|cos|tan)/.test(
    line
  );
  const looksLikeSentence = /[.!?][\s\n]|[A-Za-z]{4,}\s+[A-Za-z]{4,}/.test(line);

  if (looksLikeSentence && latexCommandCount < 2 && !/\\text\{/.test(line)) {
    return false;
  }

  return latexCommandCount >= 1 && (hasMathStructure || hasMathCommand);
}

function renderTranslationBlock(page: TranslationPage | null) {
  const content = normalizeLatexMarkdown(renderTranslationContent(page));
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
      {content}
    </ReactMarkdown>
  );
}

function renderTranslationContent(page: TranslationPage | null) {
  if (!page) {
    return "载入 PDF 后点击“开始翻译”。";
  }
  if (page.status === "done") {
    return page.translatedText;
  }
  if (page.status === "error") {
    return page.error ?? "翻译失败。";
  }
  if (page.status === "empty") {
    return "这一页没有可提取文本。";
  }
  if (page.status === "untranslated") {
    return "这一页还没有翻译。";
  }
  return "正在翻译当前页。";
}

function renderChatMessage(content: string) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
      {normalizeLatexMarkdown(content)}
    </ReactMarkdown>
  );
}

function getPageStatusText(page: TranslationPage | null) {
  if (!page) {
    return "未翻译";
  }
  if (page.status === "done") {
    return "已完成";
  }
  if (page.status === "empty") {
    return "无文本";
  }
  if (page.status === "error") {
    return "失败";
  }
  if (page.status === "pending") {
    return "进行中";
  }
  return "未翻译";
}

function getTranslationStatusLabel(page: TranslationPage | null, activePage: number | null) {
  if (page?.status === "done") {
    return `第 ${activePage} 页译文`;
  }
  if (page?.status === "empty") {
    return `第 ${activePage} 页无可翻译文本`;
  }
  if (page?.status === "error") {
    return `第 ${activePage} 页翻译失败`;
  }
  if (page?.status === "pending") {
    return `第 ${activePage} 页翻译中`;
  }
  return activePage ? `第 ${activePage} 页未翻译` : "未选择页面";
}

async function renderPdfPageImage(
  pdf: pdfjs.PDFDocumentProxy,
  pageNumber: number
): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.15 });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return "";
  }
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toDataURL("image/png");
}
