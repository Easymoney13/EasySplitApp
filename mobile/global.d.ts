declare global {
  interface ImportMetaEnv {
    readonly VITE_GATE4_REPORT_ORIGIN?: string;
    readonly VITE_GATE4_RUN_ID?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    __EASYSPLIT_MOBILE_SHELL__?: boolean;
    __EASYSPLIT_GATE4_AUTH_DIAGNOSTICS__?: {
      stage: string;
      at: number;
      user?: 'authenticated' | 'guest';
      error?: string;
      history: Array<{
        stage: string;
        at: number;
        user?: 'authenticated' | 'guest';
        error?: string;
      }>;
    };
  }
}

export {};
