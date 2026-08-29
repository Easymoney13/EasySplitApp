'use client';

import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';

interface SwipeableCardProps {
  children: React.ReactNode;
  onDelete: () => boolean | void | Promise<boolean | void>;
  className?: string;
}

export function SwipeableCard({ children, onDelete, className = '' }: SwipeableCardProps) {
  const [translateX, setTranslateX] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSwiping, setIsSwiping] = useState(false);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const startXRef = useRef<number | null>(null);
  const blockClickRef = useRef(false);

  const handleTouchStart = (e: React.TouchEvent | React.MouseEvent) => {
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    startXRef.current = clientX;
    setIsSwiping(true);
    blockClickRef.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent | React.MouseEvent) => {
    if (startXRef.current === null) return;
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const diffX = clientX - startXRef.current;

    if (Math.abs(diffX) > 5) {
      blockClickRef.current = true;
    }

    // Only allow left swiping (negative diffX)
    if (diffX < 0) {
      setTranslateX(Math.max(diffX, -140));
    } else {
      setTranslateX(0);
    }
  };

  const handleTouchEnd = async () => {
    if (startXRef.current === null) return;
    setIsSwiping(false);
    startXRef.current = null;

    if (translateX < -70) {
      setTranslateX(-92);
      setShowDeleteConfirmation(true);
    } else {
      setTranslateX(0);
    }
  };

  const cancelDelete = () => {
    setShowDeleteConfirmation(false);
    setTranslateX(0);
  };

  const confirmDelete = async () => {
    const shouldRemove = await onDelete();
    if (shouldRemove === false) {
      cancelDelete();
      return;
    }
    setShowDeleteConfirmation(false);
    setTranslateX(-400);
    setIsDeleting(true);
  };

  useEffect(() => {
    if (!showDeleteConfirmation) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelDelete();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [showDeleteConfirmation]);

  const handleClickCapture = (e: React.MouseEvent) => {
    if (blockClickRef.current) {
      e.stopPropagation();
      e.preventDefault();
      blockClickRef.current = false;
    }
  };

  return (
    <>
    <div
      onClickCapture={handleClickCapture}
      className={`relative overflow-hidden rounded-2xl transition-all duration-300 ease-out ${
        isDeleting ? 'max-h-0 opacity-0 my-0 py-0 overflow-hidden' : 'max-h-[1000px]'
      } ${className}`}
    >
      {/* Red Trash Can Reveal Background (Only Trash Icon) */}
      <div
        className="absolute inset-0 bg-red-600 dark:bg-red-700 rounded-2xl flex items-center justify-end px-5 z-0 transition-opacity duration-200"
        style={{ opacity: Math.min(Math.abs(translateX) / 50, 1) }}
      >
        <div className="p-2 rounded-full bg-red-700/60 text-white flex items-center justify-center shadow-inner">
          <Trash2 className="w-5 h-5 text-white" />
        </div>
      </div>

      {/* Ultra-Smooth Swipeable Content */}
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onMouseDown={handleTouchStart}
        onMouseMove={handleTouchMove}
        onMouseUp={handleTouchEnd}
        onMouseLeave={handleTouchEnd}
        style={{
          transform: `translateX(${translateX}px)`,
          transition: isSwiping ? 'none' : 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)'
        }}
        className="relative z-10 w-full touch-pan-y select-none"
      >
        {children}
      </div>
    </div>
    {showDeleteConfirmation && typeof document !== 'undefined' && createPortal(
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm" onClick={cancelDelete}>
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="delete-confirmation-title"
          className="w-full max-w-xs rounded-3xl border border-slate-200 bg-white p-5 text-center shadow-2xl dark:border-slate-700 dark:bg-brand-950"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400">
            <Trash2 className="h-5 w-5" />
          </div>
          <h3 id="delete-confirmation-title" className="text-base font-black text-slate-950 dark:text-white">Are you sure?</h3>
          <p className="mt-1 text-xs font-medium text-slate-500 dark:text-slate-400">This item will be removed from your list.</p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <button type="button" onClick={cancelDelete} className="rounded-xl border border-slate-200 px-4 py-3 text-xs font-extrabold text-slate-700 dark:border-slate-700 dark:text-slate-200">Cancel</button>
            <button type="button" onClick={() => void confirmDelete()} className="rounded-xl bg-red-600 px-4 py-3 text-xs font-extrabold text-white hover:bg-red-700">Delete</button>
          </div>
        </div>
      </div>,
      document.body,
    )}
    </>
  );
}
