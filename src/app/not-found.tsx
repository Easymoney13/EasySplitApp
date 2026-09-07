import type { Metadata } from 'next';
import Link from 'next/link';
import { EasySplitMark, EasySplitWordmark } from '../components/EasySplitBrand';

export const metadata: Metadata = {
  title: 'Page not found | EasySplit',
};

export default function NotFound() {
  return (
    <section className="flex min-h-full flex-1 items-center justify-center px-6 py-10 text-center">
      <div className="w-full max-w-sm rounded-[32px] border border-brand-100 bg-white/90 p-7 shadow-float backdrop-blur dark:border-brand-800 dark:bg-brand-900/90">
        <div className="mb-6 flex items-center justify-center gap-3">
          <EasySplitMark className="h-12 w-12" priority />
          <EasySplitWordmark className="text-2xl" />
        </div>

        <p className="font-rounded text-7xl font-extrabold tracking-[-0.06em] text-brand-600 dark:text-brand-300">
          404
        </p>
        <h1 className="mt-3 text-2xl font-extrabold text-brand-950 dark:text-white">
          Page not found
        </h1>
        <p dir="rtl" className="mt-2 text-base font-semibold text-slate-600 dark:text-slate-300">
          העמוד שחיפשת לא נמצא
        </p>
        <p className="mx-auto mt-4 max-w-xs text-sm leading-6 text-slate-500 dark:text-slate-400">
          The link may have expired or the address may have changed.
        </p>

        <Link
          href="/"
          className="interactive-btn mt-7 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-gradient-to-r from-brand-600 to-brand-800 px-6 py-3 font-bold text-white shadow-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-300"
        >
          Back to EasySplit
        </Link>
      </div>
    </section>
  );
}
