import type {
  AppConfig,
  ChatRequest,
  LoadedDocument,
  SkillImportResult,
  SkillListResult,
  SkillManifest,
  TranslationCacheInfo,
  TranslationProgress,
  TranslationRequest,
  TranslationResult
} from "./types";

declare global {
  interface Window {
    paperReaderApi: {
      getConfig: () => Promise<AppConfig>;
      saveConfig: (config: AppConfig) => Promise<AppConfig>;
      openPdfDialog: () => Promise<string | null>;
      loadPdf: (filePath: string) => Promise<LoadedDocument>;
      loadPdfBinary: (filePath: string) => Promise<Uint8Array>;
      translateDocument: (request: TranslationRequest) => Promise<TranslationResult>;
      getTranslationCacheInfo: (document: LoadedDocument) => Promise<TranslationCacheInfo>;
      loadCachedTranslation: (document: LoadedDocument) => Promise<TranslationResult | null>;
      onTranslationProgress: (listener: (progress: TranslationProgress) => void) => () => void;
      listSkills: () => Promise<SkillListResult>;
      importSkills: () => Promise<SkillImportResult | null>;
      openSkillsFolder: () => Promise<string>;
      sendChat: (
        request: ChatRequest
      ) => Promise<{ message: string; usedSkills: SkillManifest[] }>;
    };
  }
}

export {};
