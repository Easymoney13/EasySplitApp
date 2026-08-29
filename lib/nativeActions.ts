import { AppLauncher } from '@capacitor/app-launcher';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';

export interface ShareInviteOptions {
  title: string;
  text: string;
  url: string;
  dialogTitle?: string;
}

function isShareCancellation(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /abort|cancel|dismiss/i.test(message);
}

export async function shareInvite(options: ShareInviteOptions): Promise<'shared' | 'cancelled' | 'unavailable'> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { value } = await Share.canShare();
      if (!value) return 'unavailable';
      await Share.share(options);
      return 'shared';
    }

    if (typeof navigator !== 'undefined' && navigator.share) {
      await navigator.share(options);
      return 'shared';
    }
  } catch (error) {
    if (isShareCancellation(error)) return 'cancelled';
    console.warn('Could not open the share sheet:', error);
  }

  return 'unavailable';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.warn('Could not copy text:', error);
    return false;
  }
}

export interface ExternalAppOptions {
  appUrl: string;
  fallbackUrl: string;
  browserFallbackDelayMs?: number;
}

export async function openExternalApp({
  appUrl,
  fallbackUrl,
  browserFallbackDelayMs = 900,
}: ExternalAppOptions): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { value } = await AppLauncher.canOpenUrl({ url: appUrl });
      if (value) {
        const { completed } = await AppLauncher.openUrl({ url: appUrl });
        if (completed) return true;
      }
    } catch (error) {
      console.warn('Could not open the installed payment app:', error);
    }

    try {
      const { completed } = await AppLauncher.openUrl({ url: fallbackUrl });
      return completed;
    } catch (error) {
      console.warn('Could not open the payment fallback URL:', error);
      return false;
    }
  }

  if (typeof window === 'undefined') return false;
  const isMobileBrowser = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');
  if (isMobileBrowser) {
    window.location.href = appUrl;
    window.setTimeout(() => window.open(fallbackUrl, '_blank', 'noopener,noreferrer'), browserFallbackDelayMs);
    return true;
  }

  return Boolean(window.open(fallbackUrl, '_blank', 'noopener,noreferrer'));
}

export async function openPayBoxPayment(phone: string, amount: number): Promise<boolean> {
  const formattedAmount = amount.toFixed(2);
  await copyText(`${phone} ${formattedAmount}`);
  const query = `phone=${encodeURIComponent(phone)}&amount=${encodeURIComponent(formattedAmount)}`;
  return openExternalApp({
    appUrl: `paybox://pay?${query}`,
    fallbackUrl: `https://payboxapp.page.link/pay?${query}`,
    browserFallbackDelayMs: 800,
  });
}
