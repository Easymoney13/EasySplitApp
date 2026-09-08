import './globals.css';
import React from 'react';
import type { Metadata } from 'next';
import { LanguageProvider } from '../components/LanguageContext';
import { ReceiptPrivacyProvider } from '../components/ReceiptPrivacy';

const title = 'EasySplit - Split the Bill Together';
const description = 'Scan a receipt, split items with friends in real time, and settle the bill in seconds.';
const socialPreview = '/images/easysplit-social-preview.png';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN || 'https://billspltapp.onrender.com'),
  title,
  description,
  icons: {
    icon: '/images/easysplit-logo.webp',
    apple: '/images/easysplit-logo.webp',
  },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'EasySplit',
    title,
    description,
    images: [{
      url: socialPreview,
      width: 1200,
      height: 630,
      alt: 'EasySplit - Split the bill together',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
    images: [socialPreview],
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
      <body suppressHydrationWarning className="app-viewport bg-brand-950 text-brand-950 min-h-0 overflow-hidden flex items-stretch md:items-center justify-center p-0 md:p-6 antialiased">
        <LanguageProvider>
          <ReceiptPrivacyProvider>
            {/* Main container: Centered phone shell look on desktop, full screen on mobile */}
            <div className="app-phone-shell w-full max-w-md h-full min-h-0 bg-gradient-to-b from-white via-[#FAF8FF] to-[#EDE7FE] dark:from-brand-950 dark:via-brand-950 dark:to-brand-950 md:rounded-[44px] md:shadow-[0_28px_80px_rgba(9,7,35,0.58)] md:border-[10px] md:border-brand-900 relative overflow-hidden flex flex-col">
              {/* Main view container */}
              <main className="flex-1 min-h-0 w-full relative z-10 flex flex-col overflow-y-auto">
                {children}
              </main>
            </div>
          </ReceiptPrivacyProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
