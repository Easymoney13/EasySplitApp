/// <reference types="@capacitor/app" />
/// <reference types="@capacitor/keyboard" />
/// <reference types="@capacitor/splash-screen" />

import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'com.easysplit.app',
  appName: 'EasySplit',
  webDir: 'mobile-dist',
  // Intentionally no server.url: production ships bundled assets.
  server: {
    hostname: 'localhost',
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
  plugins: {
    // Do NOT set App.disableBackButtonHandler=true: our App.addListener('backButton')
    // relies on the native callback remaining enabled.
    Keyboard: {
      resize: KeyboardResize.Body,
      resizeOnFullScreen: true,
    },
    SystemBars: {
      // Capacitor 8 injects --safe-area-inset-* on Android where env() can be wrong.
      insetsHandling: 'css',
    },
    SplashScreen: {
      launchShowDuration: 500,
      launchAutoHide: true,
      showSpinner: false,
      backgroundColor: '#F8F8FC',
    },
  },
};

export default config;
