'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from '../../components/LanguageContext';
import { PrivacyPolicyContent } from '../../components/PrivacyPolicyContent';
import { receiptConsent } from '../../../lib/receiptPrivacyConsent';

export default function PrivacyPage() {
  const { language, setLanguage } = useLanguage();
  const router = useRouter();
  const he = language === 'he';
  const [allowed, setAllowed] = useState(false);
  useEffect(() => { setAllowed(Boolean(receiptConsent.current())); }, []);
  return <article dir={he ? 'rtl' : 'ltr'} className="px-6 pb-12 pt-6">
    <div className="mb-5 flex items-center justify-between gap-3">
      <button type="button" onClick={() => router.back()} className="min-h-11 px-2 font-semibold text-brand-600 dark:text-brand-300">{he ? 'חזרה' : 'Back'}</button>
      <button type="button" onClick={() => setLanguage(he ? 'en' : 'he')} className="min-h-11 px-2 text-sm font-semibold text-brand-600 dark:text-brand-300" aria-label={he ? 'Read in English' : 'קריאה בעברית'}>{he ? 'English' : 'עברית'}</button>
    </div>
    <h1 className="mb-5 text-2xl font-bold text-brand-950 dark:text-white">{he ? 'מדיניות הפרטיות של EasySplit' : 'EasySplit Privacy Policy'}</h1>
    <PrivacyPolicyContent language={language} />
    <section className="mt-7 rounded-2xl border border-brand-100 bg-white p-4 dark:border-brand-700 dark:bg-brand-900">
      <h2 className="font-bold text-brand-950 dark:text-white">{he ? 'הרשאת סריקה בענן במכשיר הזה' : 'Cloud-scanning permission on this device'}</h2>
      <p role="status" className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{allowed ? (he ? 'הסריקה בענן מאושרת. אפשר לבטל כאן ולבחור מחדש בסריקה הבאה.' : 'Cloud scanning is allowed. Withdraw here to choose again before your next scan.') : (he ? 'אין הסכמה שמורה. לפני העלאת תמונה נבקש את אישורכם.' : 'No permission is saved. We will ask before uploading a photo.')}</p>
      {allowed && <button type="button" onClick={() => { receiptConsent.revoke(); setAllowed(false); }} className="mt-3 min-h-11 rounded-full border border-brand-200 px-4 py-2 font-semibold text-brand-700 dark:text-brand-200">{he ? 'ביטול ההסכמה לסריקה בענן' : 'Withdraw cloud-scanning permission'}</button>}
    </section>
  </article>;
}
