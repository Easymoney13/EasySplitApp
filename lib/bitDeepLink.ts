import { copyText, openExternalApp } from './nativeActions';
import { Capacitor } from '@capacitor/core';

export interface BitPaymentParams {
  phone: string;
  amount: number | string;
  title?: string;
  storeName?: string;
}

export function cleanIsraeliPhone(phone: string): string {
  if (!phone) return '';
  let clean = phone.replace(/\D/g, '');
  if (clean.startsWith('972')) {
    clean = '0' + clean.substring(3);
  }
  if (clean.length === 9 && !clean.startsWith('0')) {
    clean = '0' + clean;
  }
  return clean;
}

export function isValidIsraeliPhone(phone: string): boolean {
  return /^05\d{8}$/.test(cleanIsraeliPhone(phone));
}

export function generateBitUrl(params: BitPaymentParams): {
  webUrl: string;
  meUrl: string;
  deepLink: string;
  intentUrl: string;
  formattedAmount: string;
  cleanPhone: string;
  displayText: string;
} {
  const cleanPhone = cleanIsraeliPhone(params.phone || '');
  const numericAmount = typeof params.amount === 'number' ? params.amount : parseFloat(params.amount as string) || 0;
  const formattedAmount = numericAmount > 0 ? numericAmount.toFixed(2) : '';
  const contentText = params.title || params.storeName || 'BillSplit Payment';
  const encodedText = encodeURIComponent(contentText);

  const queryParts: string[] = [];
  if (cleanPhone) queryParts.push(`phone=${cleanPhone}`);
  if (formattedAmount) queryParts.push(`amount=${formattedAmount}`);
  if (encodedText) queryParts.push(`text=${encodedText}`);
  const query = queryParts.join('&');

  const meUrl = cleanPhone && formattedAmount
    ? `https://www.bitpay.co.il/app/me?${query}`
    : `https://www.bitpay.co.il/app`;
  const webUrl = query ? `https://bitpay.co.il/app/pay?${query}` : `https://bitpay.co.il/app`;
  const deepLink = query ? `bit://pay?${query}` : `bit://`;
  const intentUrl = query
    ? `intent://pay?${query}#Intent;scheme=bit;package=com.poalim.bit;end`
    : `intent:#Intent;scheme=bit;package=com.poalim.bit;end`;

  return {
    webUrl,
    meUrl,
    deepLink,
    intentUrl,
    formattedAmount,
    cleanPhone,
    displayText: contentText
  };
}

export async function triggerBitPayment(params: BitPaymentParams): Promise<boolean> {
  const { meUrl, deepLink, intentUrl, formattedAmount, cleanPhone, displayText } = generateBitUrl(params);

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      if (cleanPhone && formattedAmount) {
        await copyText(`${cleanPhone} ${formattedAmount}`);
      } else if (cleanPhone) {
        await copyText(cleanPhone);
      } else if (formattedAmount) {
        await copyText(formattedAmount);
      }
    }
  } catch (e) {}

  if (typeof window === 'undefined') return false;

  const isAndroidBrowser = /Android/i.test(navigator.userAgent || '');

  return openExternalApp({
    appUrl: deepLink,
    webAppUrl: isAndroidBrowser ? intentUrl : deepLink,
    fallbackUrl: meUrl,
    browserFallbackDelayMs: 1000,
  });
}
