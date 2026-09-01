import { Capacitor } from '@capacitor/core';
import { AppleSignIn, SignInScope } from '@capawesome/capacitor-apple-sign-in';

const SIGN_IN_CANCELED = 'SIGN_IN_CANCELED';

export type NativeAppleResult = {
  idToken: string;
  rawNonce: string;
  authorizationCode: string;
  email?: string;
  displayName?: string;
};

function randomNonce(length = 32): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

async function sha256(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isNativeAppleAuthPlatform(): boolean {
  return Capacitor.getPlatform() === 'ios';
}

export function isNativeAppleSignInCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: string }).code === SIGN_IN_CANCELED;
}

export async function signInNativeApple(): Promise<NativeAppleResult> {
  if (!isNativeAppleAuthPlatform()) {
    throw new Error('Native Sign in with Apple is only available in the iOS app.');
  }

  const rawNonce = randomNonce();
  const nonce = await sha256(rawNonce);
  const result = await AppleSignIn.signIn({
    scopes: [SignInScope.Email, SignInScope.FullName],
    nonce,
  });

  if (!result?.idToken) {
    throw new Error('Sign in with Apple did not return an ID token.');
  }

  const displayName = [result.givenName, result.familyName].filter(Boolean).join(' ').trim();
  return {
    idToken: result.idToken,
    rawNonce,
    authorizationCode: result.authorizationCode,
    ...(result.email ? { email: result.email } : {}),
    ...(displayName ? { displayName } : {}),
  };
}
