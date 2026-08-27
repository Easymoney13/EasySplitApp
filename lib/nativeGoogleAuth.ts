import { Capacitor } from '@capacitor/core';

const GOOGLE_WEB_CLIENT_ID = '510350845002-o6t8t84c5fnvncgkspqdit0s0ndgsir9.apps.googleusercontent.com';
const SIGN_IN_CANCELED = 'SIGN_IN_CANCELED';

let initializationPromise: Promise<void> | null = null;

type NativeGoogleResult = {
  idToken: string;
};

type NativeGoogleSignInOptions = {
  forceAccountSelection?: boolean;
};

async function getNativeGooglePlugin() {
  const { GoogleSignIn } = await import('@capawesome/capacitor-google-sign-in');
  return GoogleSignIn;
}

async function ensureNativeGoogleInitialized(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('Native Google Sign-In is only available in the native app.');
  }

  if (!initializationPromise) {
    initializationPromise = (async () => {
      const GoogleSignIn = await getNativeGooglePlugin();
      await GoogleSignIn.initialize({ clientId: GOOGLE_WEB_CLIENT_ID });
    })().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }

  await initializationPromise;
}

export function isNativeGoogleAuthPlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export function isNativeGoogleSignInCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: string }).code === SIGN_IN_CANCELED;
}

export async function signInNativeGoogle(
  options: NativeGoogleSignInOptions = {},
): Promise<NativeGoogleResult> {
  await ensureNativeGoogleInitialized();
  const GoogleSignIn = await getNativeGooglePlugin();

  // Only clear provider state for an explicit account switch. Normal login stays fast,
  // while "Switch account" cannot silently reuse the previous Google account.
  if (options.forceAccountSelection) {
    try {
      await GoogleSignIn.signOut();
    } catch {
      // A stale or missing provider session must not block a fresh sign-in attempt.
    }
  }

  const result = await GoogleSignIn.signIn();
  if (!result?.idToken) {
    throw new Error('Google Sign-In did not return an ID token.');
  }

  return { idToken: result.idToken };
}

export async function signOutNativeGoogle(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  await ensureNativeGoogleInitialized();
  const GoogleSignIn = await getNativeGooglePlugin();
  await GoogleSignIn.signOut();
}
