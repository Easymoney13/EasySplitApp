'use client';

import React from 'react';

/**
 * Sleeping Panda (Empty groups state)
 * Static transparent icon.
 */
export function SleepingPandaIllustration({ className = "w-40 h-22" }: { className?: string }) {
  return (
    <div className={`relative inline-flex items-center justify-center select-none ${className}`}>
      <img
        src="/images/panda_sleeping.png"
        alt="No active groups"
        width={160}
        height={90}
        className="w-full h-full object-contain"
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        draggable={false}
      />
    </div>
  );
}
