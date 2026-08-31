declare global {
  interface ImportMetaEnv {
    readonly VITE_GATE4_REPORT_ORIGIN?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    __EASYSPLIT_MOBILE_SHELL__?: boolean;
  }
}

export {};
