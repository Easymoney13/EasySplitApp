'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, X } from 'lucide-react';
import { receiptConsent } from '../../lib/receiptPrivacyConsent';
import { MOBILE_BACK_REQUEST_EVENT } from '../../lib/mobileEvents';
import { useLanguage } from './LanguageContext';
import { PrivacyPolicyContent } from './PrivacyPolicyContent';

type Decision = 'accept' | 'manual' | 'cancel';

export function ReceiptPrivacyProvider({ children }: { children: React.ReactNode }) {
  const { language } = useLanguage();
  const he = language === 'he';
  const [open, setOpen] = useState(false);
  const [showPolicy, setShowPolicy] = useState(false);
  const resolver = useRef<((decision: Decision) => void) | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  function finish(decision: Decision) {
    const resolve = resolver.current;
    resolver.current = null;
    setOpen(false);
    setShowPolicy(false);
    resolve?.(decision);
  }

  useEffect(() => {
    const unregister = receiptConsent.registerPrompt(() => new Promise<Decision>((resolve) => {
      resolver.current = resolve;
      setOpen(true);
      setShowPolicy(false);
    }));
    return () => {
      unregister();
      resolver.current?.('cancel');
      resolver.current = null;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    function onNativeBack(event: Event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      finish('cancel');
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish('cancel');
      }
      if (event.key !== 'Tab') return;
      const targets = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]');
      if (!targets?.length) return;
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, onNativeBack, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, onNativeBack, true);
      previousFocus?.focus();
    };
  }, [open]);

  return <>
    {children}
    {open && <div className="fixed inset-0 z-[200] flex items-center justify-center bg-brand-950/60 px-5 py-8 backdrop-blur-sm">
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="receipt-privacy-title" aria-describedby="receipt-privacy-description" dir={he ? 'rtl' : 'ltr'} className="relative max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-[28px] bg-white p-6 shadow-xl outline-none dark:bg-brand-900">
        <button type="button" onClick={() => finish('cancel')} aria-label={he ? 'סגירה' : 'Close'} className="absolute end-3 top-3 rounded-full p-3 text-slate-500"><X className="h-5 w-5" /></button>
        <ShieldCheck className="mb-3 h-8 w-8 text-brand-600 dark:text-brand-300" />
        <h2 id="receipt-privacy-title" className="pe-6 text-xl font-bold text-brand-950 dark:text-white">{he ? 'סריקת קבלה בענן' : 'Scan your receipt in the cloud'}</h2>
        <div id="receipt-privacy-description" className="mt-3 space-y-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
          <p>{he ? 'כדי לקרוא פריטים ומחירים, נשלח את התמונה דרך שרת EasySplit ל־Google Gemini AI. כל תוכן שמופיע בתמונה יישלח, כולל מידע אישי או פרטי תשלום אם הם מודפסים בה.' : 'To read items and prices, we send the photo through the EasySplit server to Google Gemini AI. Everything visible in the photo is sent, including personal or payment information if printed on it.'}</p>
          <p>{he ? 'אפשר להזין פריטים ידנית בלי לשלוח תמונה. תוכלו לבטל את ההסכמה בכל עת בהגדרות ← פרטיות.' : 'You can enter items manually without sending a photo. You can withdraw this permission anytime in Settings → Privacy.'}</p>
        </div>
        <button type="button" onClick={() => setShowPolicy(!showPolicy)} aria-expanded={showPolicy} className="my-3 min-h-11 text-sm font-semibold text-brand-600 underline underline-offset-4 dark:text-brand-300">{he ? 'מדיניות פרטיות ופרטי העיבוד' : 'Privacy policy and processing details'}</button>
        {showPolicy && <div className="mb-5 border-t border-slate-200 pt-4 dark:border-brand-700"><PrivacyPolicyContent language={language} /></div>}
        <div className="flex flex-col gap-3">
          <button type="button" onClick={() => finish('accept')} className="interactive-btn min-h-12 rounded-full bg-brand-600 px-4 py-3 font-bold text-white">{he ? 'אני מסכים/ה, המשך לסריקה' : 'I agree, continue scanning'}</button>
          <button type="button" onClick={() => finish('manual')} className="interactive-btn min-h-12 rounded-full border border-brand-200 px-4 py-3 font-semibold text-brand-700 dark:text-brand-200">{he ? 'הזנה ידנית ללא תמונה' : 'Enter manually without a photo'}</button>
        </div>
      </div>
    </div>}
  </>;
}

export function PrivacySettingsLink() {
  const router = useRouter();
  const { language } = useLanguage();
  return <button type="button" onClick={() => router.push('/privacy')} className="interactive-btn flex min-h-12 w-full items-center gap-3 rounded-2xl border border-brand-100 bg-white px-4 py-3 text-start font-semibold text-brand-800 dark:border-brand-700 dark:bg-brand-900 dark:text-brand-100">
    <ShieldCheck aria-hidden="true" className="h-5 w-5 shrink-0" />
    {language === 'he' ? 'פרטיות והרשאות סריקה' : 'Privacy and scanning permission'}
  </button>;
}
