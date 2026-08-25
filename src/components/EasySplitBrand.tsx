'use client';

import React from 'react';

type EasySplitMarkProps = {
  className?: string;
  priority?: boolean;
};

export function EasySplitMark({ className = 'w-12 h-12', priority = false }: EasySplitMarkProps) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[28%] ${className}`}>
      <img
        src="/images/easysplit-logo.webp"
        alt="EasySplit"
        width={180}
        height={180}
        loading={priority ? 'eager' : 'lazy'}
        className="h-full w-full object-contain"
        draggable={false}
      />
    </span>
  );
}

export function EasySplitWordmark({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  return (
    <span dir="ltr" className={`inline-flex items-baseline font-rounded font-semibold tracking-[-0.035em] text-brand-950 dark:text-white [unicode-bidi:isolate] ${className}`}>
      Easy<span className="text-brand-600 dark:text-brand-300">Split</span>
      {!compact && <span className="sr-only"> app</span>}
    </span>
  );
}
