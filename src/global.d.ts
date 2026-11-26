export interface OpenedFile {
  path: string;
  name: string;
  data: Uint8Array;
}

interface FileFilter {
  name: string;
  extensions: string[];
}

declare global {
  interface Window {
    acro: {
      openPdfs(opts?: { multi?: boolean; title?: string; filters?: FileFilter[] }): Promise<OpenedFile[]>;
      readPdf(path: string): Promise<OpenedFile>;
      pathForFile(file: File): string;
      saveFile(defaultName: string, data: Uint8Array, filters?: FileFilter[]): Promise<string | null>;
      chooseFolder(): Promise<string | null>;
      writeFile(filePath: string, data: Uint8Array): Promise<string>;
      printPages(pages: { url: string; w: number; h: number }[]): Promise<string>;
      writeInFolder(folder: string, name: string, data: Uint8Array): Promise<string>;
      showItem(path: string): Promise<void>;
      version(): Promise<string>;
      ready(): Promise<OpenedFile[]>;
      confirmClose(): Promise<void>;
      openDefaultApps(): Promise<void>;
      installUpdate(): Promise<void>;
      checkUpdates(): Promise<{ status: 'dev' | 'latest' | 'downloading' | 'error'; message: string }>;
      matchFont(pdfName: string): Promise<{ family: string; bold: boolean; italic: boolean; file: string; exact: boolean } | null>;
      loadFont(q: { family: string; bold: boolean; italic: boolean }): Promise<{ data: Uint8Array; exact: boolean; italic?: boolean } | null>;
      listFonts(): Promise<string[]>;
      convertCaps(): Promise<{ office: boolean; libreoffice: boolean }>;
      officeToPdf(kind?: 'word' | 'excel' | 'ppt', opts?: { orientation?: 'auto' | 'portrait' | 'landscape'; fitWidth?: boolean }): Promise<{ name: string; data?: Uint8Array; error?: string }[]>;
      webToPdf(url: string, landscape?: boolean): Promise<{ name: string; data: Uint8Array }>;
      pickHtmlToPdf(): Promise<{ name: string; data: Uint8Array } | null>;
      htmlToPdf(html: string, name: string): Promise<{ name: string; data: Uint8Array }>;
      onOpenFiles(cb: (files: OpenedFile[]) => void): () => void;
      onBeforeClose(cb: () => void): () => void;
      onUpdateAvailable(cb: (version: string) => void): () => void;
      onUpdateReady(cb: (version: string) => void): () => void;
      onUpdateProgress(cb: (percent: number) => void): () => void;
    };
  }
}
