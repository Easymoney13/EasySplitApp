'use client';

import React from 'react';

/**
 * Sleeping Panda (Empty groups state)
 * Static transparent icon.
 */
export function SleepingPandaIllustration({ className = "w-28 h-20 sm:w-32 sm:h-22" }: { className?: string }) {
  return (
    <div className={`relative inline-flex items-center justify-center select-none ${className}`}>
      <img
        src="/images/panda_sleeping.png"
        alt="No active groups"
        width={128}
        height={88}
        className="w-full h-full object-contain drop-shadow-sm"
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        draggable={false}
      />
    </div>
  );
}
