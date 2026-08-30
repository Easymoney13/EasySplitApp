'use client';

import React from 'react';
import { useLanguage } from './LanguageContext';

interface EasySplitLoadingScreenProps {
  className?: string;
  isOverlay?: boolean;
}

export function EasySplitLoadingScreen({ className = '', isOverlay = true }: EasySplitLoadingScreenProps) {
  const { t, isRtl } = useLanguage();

  const containerClasses = isOverlay
    ? `fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#F9FAFD] dark:bg-[#0E131F] animate-fadeIn select-none ${className}`
    : `relative w-full h-full min-h-[380px] flex flex-col items-center justify-center bg-[#F9FAFD] dark:bg-[#0E131F] animate-fadeIn select-none ${className}`;

  return (
    <div
      className={containerClasses}
      dir={isRtl ? 'rtl' : 'ltr'}
      role="status"
      aria-live="polite"
      aria-label={t('ocrScanningTitle', undefined, 'Scanning receipt...')}
    >
      <div className="flex flex-col items-center justify-center flex-1">
        {/* Animated App Icon Squircle */}
        <div className="relative animate-float-gentle">
          <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-[32px] bg-gradient-to-b from-[#4154F6] via-[#3543E8] to-[#2027A8] shadow-[0_20px_45px_-12px_rgba(59,80,255,0.48)] flex items-center justify-center overflow-hidden border border-white/20">
            {/* Glossy top-light reflection */}
            <div className="absolute top-0 inset-x-0 h-1/2 bg-gradient-to-b from-white/20 to-transparent pointer-events-none rounded-t-[32px]" />

            {/* Receipt Vector with Green Checkmark */}
            <svg
              viewBox="0 0 72 84"
              className="w-16 h-18 text-white drop-shadow-md relative z-10"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* Receipt shape with zig-zag serrated bottom */}
              <path
                d="M10 8C10 4.68629 12.6863 2 16 2H56C59.3137 2 62 4.68629 62 8V72L55.5 66.5L49 72L42.5 66.5L36 72L29.5 66.5L23 72L16.5 66.5L10 72V8Z"
                fill="white"
              />

              {/* Blue horizontal receipt lines */}
              <rect x="19" y="14" width="34" height="4.5" rx="2.25" fill="#7588FF" />
              <rect x="19" y="24" width="26" height="4.5" rx="2.25" fill="#7588FF" />
              <rect x="19" y="24" width="26" height="4.5" rx="2.25" fill="#7588FF" />
              <rect x="19" y="34" width="18" height="4.5" rx="2.25" fill="#7588FF" />

              {/* Green checkmark badge */}
              <circle cx="48" cy="35" r="9" fill="#E6FAF2" />
              <path
                d="M44 35L46.8 38L52.5 32"
                stroke="#10B981"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        {/* EasySplit Brand Title */}
        <div className="mt-8 flex items-baseline justify-center text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white font-rounded" dir="ltr">
          <span>Easy</span>
          <span className="text-[#3B50FF] dark:text-[#5B6EF5]">Split</span>
        </div>

        {/* Subtle status caption */}
        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-2 font-mono tracking-wide">
          {t('ocrScanningTitle', undefined, 'Scanning receipt...')}
        </p>

        {/* Indeterminate Animated Progress Bar */}
        <div className="mt-16 sm:mt-20 w-44 sm:w-48 h-1.5 rounded-full bg-[#E5E7EB] dark:bg-slate-800 overflow-hidden relative shadow-inner">
          <div className="absolute top-0 bottom-0 rounded-full bg-gradient-to-r from-[#3B50FF] to-[#6366F1] animate-indeterminate-bar" />
        </div>
      </div>
    </div>
  );
}
