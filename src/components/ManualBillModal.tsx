'use client';

import React, { useEffect, useState, useRef } from 'react';
import {
  ChevronLeft,
  Info,
  Plus,
  Trash2,
  Loader2,
  Check,
  CheckCircle2,
} from 'lucide-react';
import { useLanguage } from './LanguageContext';

interface ManualBillModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLaunchSession: (billData: { storeName: string; restaurant?: Record<string, unknown>; date?: string; currency: string; items: any[]; category?: string }) => Promise<void> | void;
  initialData?: { title?: string; storeName?: string; currency?: string; items?: any[]; date?: string; [key: string]: any } | null;
  isLoading?: boolean;
}

interface DraftItem {
  id: string;
  name: string;
  price: number | '';
  category?: string;
  claimedBy?: string[];
  quantity?: number;
  unitPrice?: number;
  lineTotal?: number;
}

export const ManualBillModal: React.FC<ManualBillModalProps> = ({
  isOpen,
  onClose,
  onLaunchSession,
  initialData = null,
  isLoading = false,
}) => {
  const { t, currency, isRtl, formatPrice } = useLanguage();

  const categories = [
    { id: 'Food', label: t('categoryFood', undefined, isRtl ? 'אוכל ומסעדות 🍕' : 'Food & Dining 🍕') },
    { id: 'Coffee', label: t('categoryCoffee', undefined, isRtl ? 'קפה ומשקאות ☕' : 'Coffee & Drinks ☕') },
    { id: 'Groceries', label: t('categoryGroceries', undefined, isRtl ? 'סופר וקניות 🛒' : 'Groceries 🛒') },
    { id: 'Travel', label: t('categoryTravel', undefined, isRtl ? 'טיולים וחופשות ✈️' : 'Travel & Trips ✈️') },
    { id: 'Other', label: t('categoryOther', undefined, isRtl ? 'כללי / אחר 🏷️' : 'General / Other 🏷️') },
  ];

  const [storeName, setStoreName] = useState('');
  const [billNickName, setBillNickName] = useState('');
  const [selectedCurrency, setSelectedCurrency] = useState<string>(currency || 'NIS');
  const [selectedCategory, setSelectedCategory] = useState<string>('Food');
  const [items, setItems] = useState<DraftItem[]>([
    { id: '1', name: '', price: '', quantity: 1 }
  ]);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const prevIsOpenRef = useRef(false);
  const currentBillIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!isOpen) {
      prevIsOpenRef.current = false;
      return;
    }

    const isNewOpen = !prevIsOpenRef.current;
    const isDifferentBill = initialData?.id && initialData.id !== currentBillIdRef.current;

    if (isNewOpen || isDifferentBill) {
      const initialStore = initialData?.restaurant?.printedName || initialData?.storeName || initialData?.title || '';
      const initialNickname = initialData?.title || initialData?.storeName || initialStore;
      setStoreName(initialStore);
      setBillNickName(initialNickname);
      setSelectedCurrency(initialData?.currency || currency || 'NIS');
      
      const initialItems: DraftItem[] = Array.isArray(initialData?.items) && initialData.items.length > 0
        ? initialData.items.map((item, index): DraftItem => {
            const price: number | '' = Number(item.price) > 0 ? Number(item.price) : '';
            return {
              ...item,
              id: item.id || `draft_existing_${index}`,
              name: item.name || '',
              price,
              quantity: item.quantity || 1,
            };
          })
        : [{ id: '1', name: '', price: '', quantity: 1 }];

      setItems(initialItems);
      setIsSubmitting(false);
      setEditingItemId(null);
      currentBillIdRef.current = initialData?.id;
    }

    prevIsOpenRef.current = true;
  }, [isOpen, initialData?.id, currency]);

  if (!isOpen) return null;

  const handleAddItem = () => {
    const newId = `draft_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
    setItems((prev) => [
      ...prev,
      { id: newId, name: '', price: '', quantity: 1 }
    ]);
    setEditingItemId(newId);
  };

  const handleRemoveItem = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (items.length <= 1) {
      setItems([{ id: '1', name: '', price: '', quantity: 1 }]);
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const handleItemChange = (id: string, field: keyof DraftItem, value: any) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  };

  const calculateSubtotal = () => {
    return items.reduce((acc, item) => {
      const p = typeof item.price === 'number' ? item.price : parseFloat(item.price as string) || 0;
      return acc + p;
    }, 0);
  };

  const calculateGrandTotal = () => {
    const subtotal = calculateSubtotal();
    const serviceFee = Number(initialData?.service || 0);
    const taxFee = Number(initialData?.tax || 0);
    const discountFee = Number(initialData?.discount || 0);
    return Math.max(0, subtotal + serviceFee + taxFee - discountFee);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || isLoading) return;

    const finalTitle = billNickName.trim() || storeName.trim() || t('manualEntryTitle', undefined, isRtl ? 'חשבון חדש' : 'Custom Bill Split');

    const validItems = items
      .filter((i) => i.name.trim().length > 0 && Number(i.price) > 0)
      .map((i, idx) => ({
        ...i,
        id: i.id || `item_${Date.now()}_${idx}`,
        name: i.name.trim(),
        price: Number(i.price),
        lineTotal: Number(i.price),
        unitPrice: Number(i.quantity) > 0
          ? Math.round((Number(i.price) / Number(i.quantity)) * 100) / 100
          : (i.unitPrice || Number(i.price)),
        category: selectedCategory || 'Food',
        claimedBy: Array.isArray(i.claimedBy) ? i.claimedBy : [],
      }));

    if (validItems.length === 0) {
      alert(t('couldNotParse', undefined, isRtl ? 'אנא הזן לפחות פריט אחד עם שם ומחיר תקינים.' : 'Please add at least one item with a valid name and price.'));
      return;
    }

    try {
      setIsSubmitting(true);
      await onLaunchSession({
        storeName: finalTitle,
        restaurant: {
          ...(initialData?.restaurant && typeof initialData.restaurant === 'object' ? initialData.restaurant : {}),
          printedName: storeName.trim(),
          source: initialData?.restaurant?.source || 'manual-entry',
          consensusStatus: initialData?.restaurant?.consensusStatus || 'user-confirmed',
        },
        date: typeof initialData?.date === 'string' ? initialData.date : undefined,
        currency: selectedCurrency,
        items: validItems,
        category: selectedCategory,
      });
    } catch (err) {
      console.error('Error launching session:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const serviceFee = Number(initialData?.service || 0);
  const taxFee = Number(initialData?.tax || 0);
  const displayDate = initialData?.date || new Date().toISOString().split('T')[0];
  const submittingNow = isSubmitting || isLoading;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 dark:bg-black/80 backdrop-blur-sm animate-fadeIn"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div 
        role="dialog" 
        aria-modal="true"
        className="w-full max-w-sm sm:max-w-md rounded-[28px] bg-white dark:bg-[#0E1524] text-slate-900 dark:text-slate-100 shadow-2xl max-h-[88vh] flex flex-col overflow-hidden border border-slate-200/80 dark:border-slate-800 animate-slideUp"
      >
        {/* Header Bar */}
        <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-slate-100 dark:border-slate-800/80 shrink-0">
          <button
            type="button"
            disabled={submittingNow}
            onClick={onClose}
            aria-label="Back"
            className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 flex items-center justify-center transition-colors active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className={`w-4 h-4 ${isRtl ? 'rotate-180' : ''}`} />
          </button>

          <h3 className="font-extrabold text-sm sm:text-base text-slate-900 dark:text-white tracking-tight">
            {t('recognizedItemsTitle', undefined, isRtl ? 'פריטי החשבונית' : 'Recognized Items')}
          </h3>

          <div className="w-8 h-8 flex items-center justify-center text-slate-400">
            <Info className="w-4 h-4" />
          </div>
        </div>

        {/* Form Container with Scrollable Body and Pinned Footer */}
        <form onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0 overflow-hidden">
          
          {/* Scrollable Receipt Area */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3 no-scrollbar">
            
            {/* Store Name & Inline Settings Header */}
            <div className="text-center space-y-2 pb-3 border-b border-dashed border-slate-200/80 dark:border-slate-800">
              <input
                type="text"
                value={storeName}
                onChange={(e) => {
                  setStoreName(e.target.value);
                  if (!billNickName || billNickName === storeName) setBillNickName(e.target.value);
                }}
                placeholder={t('storeNamePlaceholder', undefined, isRtl ? 'שם העסק / מסעדה' : 'Store / Restaurant Name')}
                className="w-full text-center font-black text-lg sm:text-xl text-slate-900 dark:text-white bg-transparent border-none focus:outline-none focus:ring-1 focus:ring-brand-500/30 rounded-lg py-0.5"
                required
              />
              
              {/* Date & Category Inline Row */}
              <div className="flex items-center justify-center gap-2 flex-wrap">
                <span className="text-[11px] font-mono font-medium text-slate-400 dark:text-slate-500 px-2 py-0.5">
                  {displayDate}
                </span>

                <span className="text-slate-300 dark:text-slate-700">•</span>

                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="py-0.5 px-2.5 rounded-full text-xs font-bold bg-brand-50 dark:bg-brand-950/50 border border-brand-200/60 dark:border-brand-800/60 text-brand-700 dark:text-brand-300 focus:outline-none focus:border-brand-500 cursor-pointer transition-colors"
                >
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Itemized Receipt List with Clean, Lightweight Rows */}
            <div className="space-y-1 max-h-[36vh] overflow-y-auto no-scrollbar py-0.5">
              {items.map((item) => {
                const isEditing = editingItemId === item.id;

                if (isEditing) {
                  return (
                    <div
                      key={item.id}
                      className="p-2.5 rounded-xl bg-slate-50 dark:bg-[#18233A] border border-brand-500/50 space-y-2 animate-fadeIn"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={item.name}
                          onChange={(e) => handleItemChange(item.id, 'name', e.target.value)}
                          placeholder={t('itemNameLabel', undefined, isRtl ? 'שם הפריט' : 'Item Name')}
                          className="flex-1 py-1.5 px-2.5 rounded-lg text-sm font-bold bg-white dark:bg-[#0E1524] border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:border-brand-500"
                          autoFocus
                          required
                        />
                        <div className="w-24 relative">
                          <input
                            type="number"
                            step="0.01"
                            value={item.price}
                            onChange={(e) => handleItemChange(item.id, 'price', e.target.value === '' ? '' : parseFloat(e.target.value))}
                            placeholder={t('priceLabel', undefined, isRtl ? 'מחיר' : 'Price')}
                            className="w-full py-1.5 px-2 rounded-lg text-sm font-mono font-black bg-white dark:bg-[#0E1524] border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:border-brand-500"
                            required
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setEditingItemId(null)}
                          className="p-1.5 rounded-lg bg-mint-500 text-white shadow-xs hover:bg-mint-600 active:scale-95 cursor-pointer"
                          title="Done"
                        >
                          <Check className="w-4 h-4 stroke-[3]" />
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={item.id}
                    onClick={() => setEditingItemId(item.id)}
                    className="flex items-center justify-between py-2 px-2.5 rounded-xl hover:bg-slate-50 dark:hover:bg-[#18233A]/60 cursor-pointer transition-colors group border border-transparent hover:border-slate-100 dark:hover:border-slate-800"
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <span className="text-xs font-bold text-slate-400 font-mono shrink-0">
                        {item.quantity || 1}x
                      </span>
                      <span className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">
                        {item.name || <span className="text-slate-400 italic font-normal text-xs">{t('tapToNameItem', undefined, isRtl ? 'לחץ להזנת שם' : 'Tap to enter name')}</span>}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono font-bold text-sm text-slate-900 dark:text-white">
                        {formatPrice(Number(item.price) || 0, selectedCurrency)}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => handleRemoveItem(item.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-500 transition-opacity"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Add Item Action */}
            <button
              type="button"
              onClick={handleAddItem}
              className="w-full py-2 rounded-xl text-xs font-bold text-brand-600 dark:text-brand-400 hover:bg-brand-50/70 dark:hover:bg-brand-950/40 border border-dashed border-brand-200 dark:border-brand-800/60 flex items-center justify-center gap-1.5 transition-all cursor-pointer my-1"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>{t('addItemBtn', undefined, isRtl ? 'הוסף פריט +' : '+ Add Another Item')}</span>
            </button>

            {/* Totals Breakdown */}
            <div className="pt-2.5 border-t border-dashed border-slate-200/80 dark:border-slate-800 space-y-1 text-xs">
              {(serviceFee > 0 || taxFee > 0) && (
                <div className="flex justify-between text-slate-500 dark:text-slate-400 font-medium">
                  <span>{t('subtotalLabel', undefined, isRtl ? 'סכום ביניים' : 'Subtotal')}</span>
                  <span className="font-mono font-bold text-slate-700 dark:text-slate-300">
                    {formatPrice(calculateSubtotal(), selectedCurrency)}
                  </span>
                </div>
              )}

              {serviceFee > 0 && (
                <div className="flex justify-between text-slate-500 dark:text-slate-400 font-medium">
                  <span>{t('serviceFeeLabel', undefined, isRtl ? 'שירות / טיפ' : 'Service / Tip')}</span>
                  <span className="font-mono font-bold text-brand-500">
                    {formatPrice(serviceFee, selectedCurrency)}
                  </span>
                </div>
              )}

              {taxFee > 0 && (
                <div className="flex justify-between text-slate-500 dark:text-slate-400 font-medium">
                  <span>{t('taxLabel', undefined, isRtl ? 'מע״מ / מס' : 'Tax')}</span>
                  <span className="font-mono font-bold text-brand-500">
                    {formatPrice(taxFee, selectedCurrency)}
                  </span>
                </div>
              )}

              <div className="flex justify-between items-center text-sm sm:text-base font-black text-slate-900 dark:text-white pt-1.5 border-t border-slate-100 dark:border-slate-800">
                <span>{t('totalBillLabel', undefined, isRtl ? 'סה״כ לתשלום' : 'Total Bill')}</span>
                <span className="font-mono font-black text-base sm:text-lg text-slate-900 dark:text-white">
                  {formatPrice(calculateGrandTotal(), selectedCurrency)}
                </span>
              </div>
            </div>
          </div>

          {/* Fixed Action Button Footer - Apple Style Pill */}
          <div className="p-4 bg-white dark:bg-[#0E1524] border-t border-slate-100 dark:border-slate-800/90 shrink-0">
            <button
              type="submit"
              disabled={submittingNow}
              className="brand-tap w-full py-4 px-6 rounded-full bg-brand-600 hover:bg-brand-700 active:scale-[0.98] text-white font-black text-sm sm:text-base shadow-[0_8px_24px_-4px_rgba(61,58,203,0.4)] transition-all flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer select-none"
            >
              {submittingNow ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin text-white" />
                  <span>{t('processingBill', undefined, isRtl ? 'יוצר חשבון...' : 'Creating Bill...')}</span>
                </>
              ) : (
                <span>{t('continueBtn', undefined, isRtl ? 'המשך' : 'Continue')}</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
