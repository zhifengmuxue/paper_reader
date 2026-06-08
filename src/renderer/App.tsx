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

const defaultConfig: AppConfig = {
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  chatModel: "gpt-4o-mini",
  translationModel: "gpt-4o-mini",
  temperature: 0.2,
  targetLanguage: "中文",
  useOcrFallback: true,
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
  const api = typeof window !== "undefined" ? window.paperReaderApi : undefined;

  useEffect(() => {
    if (!api) {
      setErrorMessage(
        "Desktop bridge failed to load. The preload script is missing or broken, so file access and model features are unavailable."
      );
      setStatusText("Bridge unavailable");
      return;
    }
    void initialize();
    const unsubscribe = api.onTranslationProgress((progress) => {
      setTranslationProgress(progress);
      setStatusText(progress.status);
    });
    return () => {
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    return () => {
      if (pdfUrl) {
        URL.revokeObjectURL(pdfUrl);
      }
    };
  }, [pdfUrl]);

  const pageOptions = useMemo(() => {
    if (!documentData) {
      return [];
    }
    return documentData.pages.map((page) => ({
      value: page.pageNumber,
      label: `第 ${page.pageNumber} 页`
    }));
  }, [documentData]);

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

  const loadPdfPreview = async (filePath: string, preferredPage?: number) => {
    if (!api) {
      throw new Error("Desktop bridge unavailable.");
    }
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

    const pdf = await pdfjs.getDocument({ data }).promise;
    const thumbs: Record<number, string> = {};
    const previewCount = Math.min(pdf.numPages, 18);

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
      thumbs[index] = canvas.toDataURL("image/png");
    }

    setPdfThumbs(thumbs);

    const targetPage = preferredPage ?? activePage ?? 1;
    const image = await renderPdfPageImage(pdf, targetPage);
    setActivePdfImage(image);
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

    setBusyState("loading-pdf");
    setStatusText("正在载入 PDF");
    try {
      const loaded = await api.loadPdf(filePath);
      const firstPage = loaded.pages[0]?.pageNumber ?? 1;
      await loadPdfPreview(filePath, firstPage);
      const cacheInfo = await api.getTranslationCacheInfo(loaded);
      const cachedTranslation = await api.loadCachedTranslation(loaded);
      setDocumentData(loaded);
      setTranslation(cachedTranslation);
      setTranslationCacheInfo(cacheInfo);
      setTranslationProgress(null);
      setActivePage(firstPage);
      setJumpPage(String(firstPage));
      setTranslationView(cachedTranslation ? "all" : "page");
      setForceRetranslate(false);
      setChatMessages([]);
      setStatusText(cachedTranslation ? `已载入 ${loaded.fileName}，并恢复翻译缓存` : `已载入 ${loaded.fileName}`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load PDF.");
      setStatusText("PDF 载入失败");
    } finally {
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
      setStatusText("设置已保存");
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
    if (documentData) {
      void renderActivePdfPage(documentData.filePath, pageNumber);
    }
  };

  const submitJumpPage = () => {
    const parsed = Number(jumpPage);
    if (!Number.isInteger(parsed) || !documentData) {
      return;
    }
    const page = documentData.pages.find((item) => item.pageNumber === parsed);
    if (page) {
      goToPage(page.pageNumber);
      if (translationView === "page") {
        originalPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        originalCompareCardRefs.current[page.pageNumber]?.scrollIntoView({
          block: "start",
          behavior: "smooth"
        });
        translationCompareCardRefs.current[page.pageNumber]?.scrollIntoView({
          block: "start",
          behavior: "smooth"
        });
      }
    }
  };

  const goToPreviousPage = () => {
    if (!documentData || activePage === null) {
      return;
    }
    const nextPage = Math.max(1, activePage - 1);
    goToPage(nextPage);
  };

  const goToNextPage = () => {
    if (!documentData || activePage === null) {
      return;
    }
    const nextPage = Math.min(documentData.pageCount, activePage + 1);
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
        {documentData ? <span>{documentData.fileName}</span> : <span>还没有载入 PDF</span>}
        {translationProgress ? (
          <span>
            翻译进度 {translationProgress.completedPages}/{translationProgress.totalPages}
          </span>
        ) : (
          <span>{translationCacheInfo?.hasCache ? `缓存 ${translationCacheInfo.completedPages}/${translationCacheInfo.totalPages}` : "当前没有翻译任务"}</span>
        )}
      </section>

      {documentData ? (
        <section className="statusbar document-meta">
          <span>{documentData.usedOcr ? "已启用 OCR 补全稀疏页面" : "当前使用 PDF 内嵌文本"}</span>
          <span>页数：{documentData.pageCount}</span>
          <span>
            {translationCacheInfo?.hasCache
              ? `缓存时间：${translationCacheInfo.translatedAt ?? "未知"}`
              : "尚未生成翻译缓存"}
          </span>
        </section>
      ) : null}

      {showSettings ? (
        <section className="settings-panel">
          <div className="panel-title-row">
            <h2>API 设置</h2>
            <button className="secondary" onClick={saveSettings}>
              保存
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
                  setDraftConfig({ ...draftConfig, useOcrFallback: event.target.value === "on" })
                }
              >
                <option value="on">开启</option>
                <option value="off">关闭</option>
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
          <p className="muted">支持 OpenAI 兼容 `chat/completions` 接口。译文会按 Markdown 和 LaTeX 数学公式格式显示。</p>
        </section>
      ) : null}

      {errorMessage ? <section className="error-banner">{errorMessage}</section> : null}

      <main className={layoutClassName}>
        <section className={`pane pane-original ${paneCollapsed.original ? "collapsed" : ""}`}>
          <PaneHeader
            title="原文"
            subtitle={documentData ? "原始 PDF 页面" : "先导入 PDF"}
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
                  disabled={!documentData || activePage === null || activePage >= documentData.pageCount}
                >
                  下一页
                </button>
              </div>
            ) : null}
          </PaneHeader>

          {!paneCollapsed.original ? (
            <div className="pane-scroll pane-pdf" ref={originalPaneRef}>
              {documentData ? (
                translationView === "page" ? (
                  <>
                    <div className="pdf-stage pdf-stage-large">
                      {pdfUrl ? (
                        <iframe src={`${pdfUrl}#page=${activePage ?? 1}&view=FitH`} title="Original PDF" />
                      ) : (
                        <div className="empty-mini">正在准备 PDF 预览...</div>
                      )}
                    </div>
                    <div className="thumbnail-strip">
                      {documentData.pages.map((page) => (
                        <button
                          key={page.pageNumber}
                          className={`thumbnail-card ${activePage === page.pageNumber ? "active" : ""}`}
                          onClick={() => goToPage(page.pageNumber)}
                        >
                          {pdfThumbs[page.pageNumber] ? (
                            <img src={pdfThumbs[page.pageNumber]} alt={`Page ${page.pageNumber}`} />
                          ) : (
                            <span>第 {page.pageNumber} 页</span>
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
                        <div className="comparison-card-body">{renderOriginalContent(row.originalText)}</div>
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
                      <p>{message.content}</p>
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

function renderTranslationBlock(page: TranslationPage | null) {
  const content = renderTranslationContent(page);
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
