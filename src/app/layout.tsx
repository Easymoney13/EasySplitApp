import './globals.css';
import React from 'react';
import { LanguageProvider } from '../components/LanguageContext';

export const metadata = {
  title: 'EasySplit - Split the Bill Together',
  description: 'Split restaurant and group bills in real-time with friends via receipt scanning, photo uploads, WebSockets, and 1-tap Bit/Paybox transfers.',
  icons: {
    icon: '/images/easysplit-logo.webp',
    apple: '/images/easysplit-logo.webp',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover' as const,
  themeColor: '#3D3ACB',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning className="app-viewport bg-brand-950 text-brand-950 min-h-0 overflow-hidden flex items-center justify-center p-0 md:p-6 antialiased">
        <LanguageProvider>
          {/* Main container: Centered phone shell look on desktop, full screen on mobile */}
          <div className="app-phone-shell w-full max-w-md min-h-0 bg-gradient-to-b from-white via-[#FAF8FF] to-[#EDE7FE] dark:from-brand-950 dark:via-brand-950 dark:to-brand-950 md:rounded-[44px] md:shadow-[0_28px_80px_rgba(9,7,35,0.58)] md:border-[10px] md:border-brand-900 relative overflow-hidden flex flex-col">
            {/* Main view container */}
            <main className="flex-1 min-h-0 w-full relative z-10 flex flex-col overflow-y-auto">
              {children}
            </main>
          </div>
        </LanguageProvider>
      </body>
    </html>
  );
}
