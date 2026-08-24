'use client';

import React, { useState } from 'react';
import { X, Users, ArrowRight, Loader2 } from 'lucide-react';
import { useLanguage } from './LanguageContext';

interface CreateGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateGroup: (groupData: { name: string; currency: string }) => Promise<void> | void;
  isLoading?: boolean;
}

export const CreateGroupModal: React.FC<CreateGroupModalProps> = ({
  isOpen,
  onClose,
  onCreateGroup,
  isLoading = false
}) => {
  const { t, currency, isRtl } = useLanguage();

  const [groupName, setGroupName] = useState('');
  const [selectedCurrency, setSelectedCurrency] = useState<string>(currency || 'NIS');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || isLoading) return;

    const finalName = groupName.trim() || 'Group';
    try {
      setIsSubmitting(true);
      await onCreateGroup({
        name: finalName,
        currency: selectedCurrency
      });
    } catch (err) {
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isBusy = isSubmitting || isLoading;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn text-slate-900 dark:text-white" dir={isRtl ? 'rtl' : 'ltr'}>
      <div role="dialog" aria-modal="true" aria-label={t('createGroupTitle', undefined, 'Create Group')} className="w-full max-w-sm rounded-[24px] p-6 bg-white dark:bg-brand-950 border border-slate-200 dark:border-slate-800 space-y-5 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-2xl bg-brand-50 dark:bg-brand-950/50 text-brand-600 dark:text-brand-400 border border-brand-100 dark:border-brand-900/40">
              <Users className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <h3 className="font-extrabold text-base leading-tight">
                {t('createGroupTitle', undefined, 'Create Group')}
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                {t('createGroupSub', undefined, 'Keep multiple splits with the same people in one place')}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            disabled={isBusy}
            aria-label={t('closeBtn', undefined, 'Close')}
            className="p-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {t('groupNameLabel', undefined, 'Group Name')}
            </label>
            <input
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder={t('groupNamePlaceholder', undefined, 'e.g. Eilat Weekend')}
              className="w-full py-2.5 px-3.5 rounded-xl text-xs font-semibold bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 focus:outline-none focus:border-brand-500 text-slate-900 dark:text-white"
              required
              disabled={isBusy}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {t('preferredCurrencyLabel', undefined, 'Group Currency')}
            </label>
            <select
              value={selectedCurrency}
              onChange={(e) => setSelectedCurrency(e.target.value)}
              disabled={isBusy}
              className="w-full py-2.5 px-3 rounded-xl text-xs font-bold bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 focus:outline-none focus:border-brand-500 text-slate-900 dark:text-white"
            >
              <option value="NIS">NIS ₪</option>
              <option value="USD">USD $</option>
              <option value="EUR">EUR €</option>
              <option value="GBP">GBP £</option>
            </select>
          </div>

          <div className="pt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isBusy}
              className="py-2.5 px-4 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-extrabold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
            >
              {t('cancelBtn', undefined, 'Cancel')}
            </button>

            <button
              type="submit"
              disabled={isBusy}
              className="flex-1 py-2.5 rounded-full bg-brand-600 dark:bg-brand-300 text-white dark:text-brand-950 font-black text-xs hover:bg-brand-700 dark:hover:bg-brand-200 flex items-center justify-center gap-2 shadow-md active:scale-95 transition-all disabled:opacity-60"
            >
              {isBusy ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{t('creatingGroup', undefined, 'Creating Group...')}</span>
                </>
              ) : (
                <>
                  <span>{t('createGroupBtn', undefined, 'Create Group ✨')}</span>
                  <ArrowRight className={`w-3.5 h-3.5 ${isRtl ? 'rotate-180' : ''}`} />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
