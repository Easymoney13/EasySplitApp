'use client';

import React from 'react';

/**
 * Sleeping Panda (Empty groups state)
 * Static transparent icon.
 */
export function SleepingPandaIllustration({ className = "w-36 h-28 sm:w-40 sm:h-32" }: { className?: string }) {
  return (
    <div className={`relative inline-flex items-center justify-center select-none ${className}`}>
      <img
        src="/images/panda_sleeping.png"
        alt="No active groups"
        width={314}
        height={260}
        className="w-full h-full object-contain"
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        draggable={false}
      />
    </div>
  );
}
