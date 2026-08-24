import React from 'react';

export function ReceiptSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      {/* Header skeleton */}
      <div className="h-6 w-32 bg-slate-200 dark:bg-slate-800 rounded-lg mb-2" />
      <div className="h-4 w-48 bg-slate-200 dark:bg-slate-800 rounded-lg mb-4" />

      {/* 4 Item Card Skeletons */}
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="photo-card p-4 bg-white dark:bg-brand-900 border border-slate-200 dark:border-[#222C3D] space-y-3"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-slate-200 dark:bg-slate-800 shrink-0" />
              <div className="space-y-1.5">
                <div className="h-4 w-36 bg-slate-200 dark:bg-slate-800 rounded-md" />
                <div className="h-3 w-20 bg-slate-200 dark:bg-slate-800 rounded-full" />
              </div>
            </div>
            <div className="h-5 w-16 bg-slate-200 dark:bg-slate-800 rounded-md" />
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <div className="h-6 w-24 bg-slate-200 dark:bg-slate-800 rounded-full" />
              <div className="h-6 w-20 bg-slate-200 dark:bg-slate-800 rounded-full" />
            </div>
            <div className="h-5 w-12 bg-slate-200 dark:bg-slate-800 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function HomeSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-32 w-full photo-card bg-slate-200 dark:bg-slate-800 rounded-3xl" />
      <div className="h-44 w-full photo-card bg-slate-200 dark:bg-slate-800 rounded-3xl" />
      <div className="h-36 w-full photo-card bg-slate-200 dark:bg-slate-800 rounded-3xl" />
    </div>
  );
}
