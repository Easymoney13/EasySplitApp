import { AppLauncher } from '@capacitor/app-launcher';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { nativeInviteUrlFromWeb } from '../mobile/deep-link-core.mjs';

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
      const nativeUrl = nativeInviteUrlFromWeb(options.url);
      const payload = nativeUrl
        ? {
            ...options,
            text: `${options.text}\n${options.url}`,
            url: nativeUrl,
          }
        : options;
      await Share.share(payload);
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
  webAppUrl?: string;
  browserFallbackDelayMs?: number;
}

export async function openExternalApp({
  appUrl,
  fallbackUrl,
  webAppUrl = appUrl,
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
      console.warn('Could not check installed app with AppLauncher:', error);
    }

    try {
      const { completed } = await AppLauncher.openUrl({ url: appUrl });
      if (completed) return true;
    } catch (error) {
      console.warn('Direct AppLauncher openUrl failed:', error);
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
    window.location.href = webAppUrl;
    window.setTimeout(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
      }
    }, browserFallbackDelayMs);
    return true;
  }

  return Boolean(window.open(fallbackUrl, '_blank', 'noopener,noreferrer'));
}

export async function openPayBoxPayment(phone: string, amount: number): Promise<boolean> {
  const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
  const formattedAmount = (amount || 0).toFixed(2);
  const textToCopy = cleanPhone ? `${cleanPhone} ${formattedAmount}` : (amount > 0 ? formattedAmount : '');
  if (textToCopy) {
    await copyText(textToCopy);
  }

  const queryParts: string[] = [];
  if (cleanPhone) queryParts.push(`phone=${encodeURIComponent(cleanPhone)}`);
  if (amount > 0) queryParts.push(`amount=${encodeURIComponent(formattedAmount)}`);
  const query = queryParts.join('&');

  const appUrl = query ? `paybox://pay?${query}` : `paybox://`;
  const intentUrl = query
    ? `intent://pay?${query}#Intent;scheme=paybox;package=com.payboxapp;end`
    : `intent:#Intent;scheme=paybox;package=com.payboxapp;end`;
  const fallbackUrl = query
    ? `https://payboxapp.page.link/pay?${query}`
    : `https://payboxapp.page.link`;

  const isAndroidBrowser = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');

  return openExternalApp({
    appUrl,
    webAppUrl: isAndroidBrowser ? intentUrl : appUrl,
    fallbackUrl,
    browserFallbackDelayMs: 800,
  });
}
