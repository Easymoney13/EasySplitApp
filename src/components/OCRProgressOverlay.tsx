'use client';

import React, { useEffect, useState } from 'react';
import { EasySplitLoadingScreen } from './EasySplitLoadingScreen';

interface OCRProgressOverlayProps {
  isVisible: boolean;
  onComplete?: () => void;
}

export function OCRProgressOverlay({ isVisible }: OCRProgressOverlayProps) {
  const [shouldRender, setShouldRender] = useState(isVisible);

  useEffect(() => {
    if (isVisible) {
      setShouldRender(true);
    } else if (shouldRender) {
      const timeout = window.setTimeout(() => setShouldRender(false), 300);
      return () => window.clearTimeout(timeout);
    }
  }, [isVisible, shouldRender]);

  if (!shouldRender) return null;

  return <EasySplitLoadingScreen isOverlay={true} />;
}

