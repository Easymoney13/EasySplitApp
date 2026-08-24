'use client';

import React from 'react';
import { useLanguage } from './LanguageContext';

interface OCRProgressOverlayProps {
  isVisible: boolean;
  onComplete?: () => void;
}

export function OCRProgressOverlay({ isVisible }: OCRProgressOverlayProps) {
  const { t, isRtl } = useLanguage();

  if (!isVisible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('ocrScanningTitle', undefined, 'Scanning receipt...')}
      className="fixed inset-0 z-50 overflow-hidden bg-[#F8F8F4] text-brand-950 animate-fadeIn"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <video
        className="absolute inset-0 h-full w-full object-cover"
        src="/easysplit-loading.mp4"
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
      />

    </div>
  );
}
