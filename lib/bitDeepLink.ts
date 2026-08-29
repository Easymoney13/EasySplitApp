import { copyText, openExternalApp } from './nativeActions';

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
  const cleanPhone = cleanIsraeliPhone(params.phone);
  const numericAmount = typeof params.amount === 'number' ? params.amount : parseFloat(params.amount as string) || 0;
  const formattedAmount = numericAmount.toFixed(2);
  const contentText = params.title || params.storeName || 'BillSplit Payment';
  const encodedText = encodeURIComponent(contentText);

  const meUrl = `https://www.bitpay.co.il/app/me?phone=${cleanPhone}&amount=${formattedAmount}&text=${encodedText}`;
  const webUrl = `https://bitpay.co.il/app/pay?phone=${cleanPhone}&amount=${formattedAmount}&text=${encodedText}`;
  const deepLink = `bit://pay?phone=${cleanPhone}&amount=${formattedAmount}&text=${encodedText}`;
  const intentUrl = `intent://pay?phone=${cleanPhone}&amount=${formattedAmount}&text=${encodedText}#Intent;scheme=bit;package=com.poalim.bit;end`;

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
  if (!isValidIsraeliPhone(params.phone)) return false;
  const { meUrl, deepLink, formattedAmount, cleanPhone } = generateBitUrl(params);

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await copyText(`${cleanPhone} ${formattedAmount}`);
    }
  } catch (e) {}

  if (typeof window === 'undefined') return false;

  return openExternalApp({
    appUrl: deepLink,
    fallbackUrl: meUrl,
    browserFallbackDelayMs: 1000,
  });
}
