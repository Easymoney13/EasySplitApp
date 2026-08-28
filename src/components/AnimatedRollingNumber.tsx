'use client';

import React, { useEffect, useState, useRef } from 'react';

interface AnimatedRollingNumberProps {
  value: number;
  currency?: string;
  isDual?: boolean;
  formatDual?: (amount: number, curr?: string) => { primary: string; secondary?: string };
  formatPrice?: (amount: number, curr?: string) => string;
  className?: string;
}

export function AnimatedRollingNumber({
  value,
  currency = 'NIS',
  isDual = false,
  formatDual,
  formatPrice,
  className = ''
}: AnimatedRollingNumberProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const [isRolling, setIsRolling] = useState(false);
  const animRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const startValRef = useRef(value);

  useEffect(() => {
    if (Math.abs(displayValue - value) < 0.005) {
      setDisplayValue(value);
      return;
    }

    startValRef.current = displayValue;
    startTimeRef.current = null;
    setIsRolling(true);

    const duration = 320; // 320ms duration

    const animate = (time: number) => {
      if (!startTimeRef.current) startTimeRef.current = time;
      const elapsed = time - startTimeRef.current;
      const progress = Math.min(1, elapsed / duration);
      // Fast ease-out cubic curve for punchy rolling feel
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const current = startValRef.current + (value - startValRef.current) * easeOut;

      setDisplayValue(current);

      if (progress < 1) {
        animRef.current = requestAnimationFrame(animate);
      } else {
        setDisplayValue(value);
        setIsRolling(false);
      }
    };

    animRef.current = requestAnimationFrame(animate);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [value]);

  if (isDual && formatDual) {
    const dual = formatDual(displayValue, currency);
    return (
      <span className={`inline-flex items-baseline transition-transform duration-150 ${isRolling ? 'scale-[1.04] text-brand-600 dark:text-brand-300' : ''} ${className}`}>
        <span>{dual.primary}</span>
        {dual.secondary && <span className="text-[11px] opacity-75 ms-1">{dual.secondary}</span>}
      </span>
    );
  }

  const formatted = formatPrice ? formatPrice(displayValue, currency) : `${displayValue.toFixed(2)} ${currency}`;
  return (
    <span className={`inline-block transition-transform duration-150 ${isRolling ? 'scale-[1.04] text-brand-600 dark:text-brand-300' : ''} ${className}`}>
      {formatted}
    </span>
  );
}
