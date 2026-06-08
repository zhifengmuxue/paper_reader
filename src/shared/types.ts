export interface PdfPage {
  pageNumber: number;
  text: string;
  extractionMethod: "embedded-text" | "ocr" | "none";
}

export interface LoadedDocument {
  filePath: string;
  fileName: string;
  pageCount: number;
  pages: PdfPage[];
  usedOcr: boolean;
  documentFingerprint: string;
}

export interface TranslationPage {
  pageNumber: number;
  originalText: string;
  translatedText: string;
  status: "untranslated" | "pending" | "done" | "empty" | "error";
  error?: string;
}

export interface TranslationResult {
  documentFingerprint: string;
  pages: TranslationPage[];
  translatedAt: string;
  targetLanguage: string;
  model: string;
  cacheKey: string;
}

export interface TranslationProgress {
  completedPages: number;
  totalPages: number;
  currentPage?: number;
  status: string;
}

export interface TranslationRequest {
  document: LoadedDocument;
  pageNumbers?: number[];
  forceRetranslate?: boolean;
}

export interface AppConfig {
  apiBaseUrl: string;
  apiKey: string;
  chatModel: string;
  translationModel: string;
  temperature: number;
  targetLanguage: string;
  useOcrFallback: boolean;
  ocrLanguageHint: string;
}

export interface TranslationCacheInfo {
  cacheKey: string;
  cachePath: string;
  hasCache: boolean;
  completedPages: number;
  totalPages: number;
  translatedAt?: string;
}

export interface SkillQuickAction {
  id: string;
  label: string;
  prompt: string;
}

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  systemPrompt?: string;
  quickActions?: SkillQuickAction[];
}

export interface SkillListResult {
  skills: SkillManifest[];
  userSkillDirectory: string;
  bundledSkillDirectory: string;
}

export interface SkillImportResult {
  importedFiles: string[];
  userSkillDirectory: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  document: LoadedDocument | null;
  translation: TranslationResult | null;
  activePage: number | null;
  skillIds: string[];
}
