'use client';

import React, { useEffect, useState } from 'react';
import { useLanguage } from './LanguageContext';

interface OCRProgressOverlayProps {
  isVisible: boolean;
  onComplete?: () => void;
}

export function OCRProgressOverlay({ isVisible }: OCRProgressOverlayProps) {
  const { t, isRtl } = useLanguage();
  const [shouldRender, setShouldRender] = useState(isVisible);
  const [progress, setProgress] = useState(isVisible ? 6 : 0);

  useEffect(() => {
    if (isVisible) {
      setShouldRender(true);
      setProgress(6);
      const interval = window.setInterval(() => {
        setProgress((current) => Math.min(92, current + Math.max(1, (92 - current) * 0.08)));
      }, 350);
      return () => window.clearInterval(interval);
    }

    if (shouldRender) {
      setProgress(100);
      const timeout = window.setTimeout(() => setShouldRender(false), 360);
      return () => window.clearTimeout(timeout);
    }
  }, [isVisible, shouldRender]);

  if (!shouldRender) return null;

  return (
    <div
      className="absolute inset-0 z-50 overflow-hidden bg-[#F8F8F4] text-brand-950 animate-fadeIn md:rounded-[34px]"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {t('ocrScanningTitle', undefined, 'Scanning receipt...')}
      </span>
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
      <div className="absolute inset-x-0 bottom-0 z-10 flex h-[21%] items-start justify-center bg-[#F8F8F4] px-10 pt-5">
        <div
          className="h-2 w-full max-w-56 overflow-hidden rounded-full bg-brand-100 shadow-inner"
          role="progressbar"
          aria-label={t('ocrScanningTitle', undefined, 'Scanning receipt...')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-700 transition-[width] duration-300 ease-out"
            style={{ width: `${progress}%` }}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}
