'use client';

import React, { useState } from 'react';
import { X, Link2, Check, ArrowRight, Users } from 'lucide-react';
import { useLanguage } from './LanguageContext';

interface AttachToGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  userGroups: Array<{ id: string; name: string; code: string }>;
  onAttach: (groupId: string) => void;
}

export const AttachToGroupModal: React.FC<AttachToGroupModalProps> = ({
  isOpen,
  onClose,
  userGroups,
  onAttach,
}) => {
  const { t, isRtl } = useLanguage();
  const [selectedGroupId, setSelectedGroupId] = useState<string>(userGroups[0]?.id || '');
  const [customGroupCode, setCustomGroupCode] = useState<string>('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalGroupId = selectedGroupId || customGroupCode.trim();
    if (finalGroupId) {
      onAttach(finalGroupId);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn text-slate-900 dark:text-white">
      <div role="dialog" aria-modal="true" aria-label={t('attachBillTitle', undefined, 'Attach Bill to Group')} className="w-full max-w-sm photo-card p-6 bg-white dark:bg-[#0E131F] border border-slate-200 dark:border-slate-800 space-y-5 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-2xl bg-indigo-100 dark:bg-indigo-950/80 text-indigo-600 dark:text-indigo-400">
              <Link2 className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <h3 className="font-extrabold text-base leading-tight">
                {t('attachBillTitle', undefined, 'Attach Bill to Group')}
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                {t('attachBillSub', undefined, 'Add this bill to a trip or roommate group')}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label={t('closeBtn', undefined, 'Close')}
            className="p-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {userGroups.length > 0 ? (
            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {t('selectGroupLabel', undefined, 'Select Your Group')}
              </label>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {userGroups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setSelectedGroupId(g.id)}
                    className={`w-full p-3 rounded-xl border text-left flex items-center justify-between transition-all ${
                      selectedGroupId === g.id
                        ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 text-slate-900 dark:text-white'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-slate-950 dark:bg-white text-white dark:text-slate-950 flex items-center justify-center font-black text-xs">
                        {(g.name || 'G').substring(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <span className="font-extrabold text-xs block leading-tight">{g.name}</span>
                        <span className="text-[10px] font-mono text-slate-400 font-bold">#{g.code}</span>
                      </div>
                    </div>
                    {selectedGroupId === g.id && <Check className="w-4 h-4 text-indigo-600 dark:text-indigo-400 stroke-[3]" />}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {t('enterGroupCodeLabel', undefined, 'Enter 8-Digit Group Code')}
              </label>
              <input
                type="text"
                maxLength={8}
                value={customGroupCode}
                onChange={(e) => setCustomGroupCode(e.target.value.replace(/\D/g, ''))}
                placeholder={t('enterGroupCodePlaceholder', undefined, 'Enter 8-digit group code')}
                className="w-full py-2.5 px-3.5 rounded-xl photo-input text-center text-lg font-mono font-extrabold tracking-widest bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
              />
            </div>
          )}

          <div className="pt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="py-2.5 px-4 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-extrabold"
            >
              {t('cancelBtn', undefined, 'Cancel')}
            </button>

            <button
              type="submit"
              disabled={!selectedGroupId && !/^\d{8}$/.test(customGroupCode)}
              className="flex-1 py-2.5 rounded-full bg-slate-950 dark:bg-white text-white dark:text-slate-950 font-black text-xs hover:bg-slate-900 dark:hover:bg-slate-200 flex items-center justify-center gap-1.5 shadow-md active:scale-95 disabled:opacity-40"
            >
              <span>{t('attachBtn', undefined, 'Attach Bill 🔗')}</span>
              <ArrowRight className={`w-3.5 h-3.5 ${isRtl ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
