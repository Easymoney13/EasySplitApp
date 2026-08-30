'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { Sparkles, Phone, User, Globe, LogOut, Loader2, AlertCircle, CheckCircle, X } from 'lucide-react';
import defaultTranslations, { translations as namedTranslations, formatCurrency, convertCurrency, formatDualPrice, updateLiveExchangeRates } from '../../lib/i18n';
import { getCookie, setCookie, removeCookie } from '../../lib/cookies';
import {
  clearAccountScopedStorage,
  clearGuestAccountMigration,
  consumeGuestAccountMigration,
  prepareGuestAccountMigration,
  transitionAccountScope,
} from '../../lib/accountIsolation';
import { clearCreatorIntent, readCreatorIntent } from '../../lib/creatorIntent';
import { isProtectedApi } from '../../lib/authFetch';
import { cleanIsraeliPhone, isValidIsraeliPhone } from '../../lib/bitDeepLink';
import { apiUrl, getApiOrigin } from '../../lib/platformTransport';
import {
  isNativeGoogleAuthPlatform,
  isNativeGoogleSignInCancellation,
  signInNativeGoogle,
  signOutNativeGoogle,
} from '../../lib/nativeGoogleAuth';

const rawDictionary: any = defaultTranslations || namedTranslations || {};
const i18nDictionary: Record<string, Record<string, string>> = 
  (rawDictionary?.en || rawDictionary?.he) ? rawDictionary : (rawDictionary?.default || rawDictionary?.translations || {});

export const DEFAULT_REAL_AVATAR = '';

type Language = 'en' | 'he';
type Currency = 'USD' | 'NIS' | 'EUR';
type Theme = 'dark' | 'light';

interface UserProfile {
  displayName: string;
  avatarColor: string;
  avatarUrl?: string;
  phoneNumber?: string;
}

export interface AuthNotification {
  type: 'error' | 'info' | 'success';
  message: string;
}

export type GoogleLoginResult = 'authenticated' | 'cancelled' | 'failed' | 'busy';

export interface GoogleLoginOptions {
  forceAccountSelection?: boolean;
}

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  isRtl: boolean;
  t: (key: string, params?: Record<string, string | number>, defaultText?: string) => string;
  currency: Currency;
  setCurrency: (curr: Currency) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  profile: UserProfile;
  setProfile: React.Dispatch<React.SetStateAction<UserProfile>>;
  formatPrice: (amount: number, fromCurr?: string) => string;
  formatDual: (amount: number, billCurrency?: string) => { primary: string; secondary?: string };
  firebaseUser: any;
  authLoading: boolean;
  isAuthenticating: boolean;
  authNotification: AuthNotification | null;
  clearAuthNotification: () => void;
  loginWithGoogle: (options?: GoogleLoginOptions) => Promise<GoogleLoginResult>;
  logout: () => Promise<void>;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>('en');
  const [currency, setCurrencyState] = useState<Currency>('NIS');
  const [theme, setThemeState] = useState<Theme>('light');
  const [isInitialized, setIsInitialized] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authNotification, setAuthNotification] = useState<AuthNotification | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<any>(null);
  const [authModules, setAuthModules] = useState<any>(null);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');

  const showAuthMessage = (message: string, type: 'error' | 'info' | 'success' = 'error') => {
    setAuthNotification({ type, message });
  };

  const clearAuthNotification = () => {
    setAuthNotification(null);
  };

  // Auto-dismiss auth notification after 6 seconds
  useEffect(() => {
    if (!authNotification) return;
    const timer = setTimeout(() => {
      setAuthNotification(null);
    }, 6000);
    return () => clearTimeout(timer);
  }, [authNotification]);
  
  // Preload Firebase Auth modules on client mount for instant popup execution
  useEffect(() => {
    const preload = async () => {
      try {
        const { auth, googleProvider, getGoogleProvider, ensureAuthPersistence } = await import('../../lib/firebase');
        await ensureAuthPersistence();
        if (typeof auth.authStateReady === 'function') {
          await auth.authStateReady();
        }
        const { signInWithPopup } = await import('firebase/auth');
        setAuthModules({ auth, googleProvider, getGoogleProvider, signInWithPopup });
      } catch (e) {
        console.error('Failed to preload auth modules:', e);
      }
    };
    preload();
  }, []);

  const [profile, setProfile] = useState<UserProfile>({
    displayName: '',
    avatarColor: '#4DE1A1'
  });

  // 1. Fetch real-time live currency exchange rates on mount
  useEffect(() => {
    fetch(apiUrl('/api/exchange-rates'))
      .then((res) => res.json())
      .then((data) => {
        if (data && data.rates) {
          updateLiveExchangeRates(data.rates);
        }
      })
      .catch((err) => {
        console.warn('Real-time exchange rate fetch fallback:', err);
      });
  }, []);

  // 2. Transparent fetch interception to inject Firebase ID token
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const originalFetch = window.fetch;
      window.fetch = async (input, init) => {
        if (isProtectedApi(input, window.location.origin, getApiOrigin())) {
          try {
            const { auth } = await import('../../lib/firebase');
            const currentUser = auth.currentUser;
            if (currentUser) {
              const token = await currentUser.getIdToken();
              const inheritedHeaders = input instanceof Request ? input.headers : undefined;
              const headers = new Headers(init?.headers || inheritedHeaders);
              headers.set('Authorization', `Bearer ${token}`);
              init = { ...init, headers };
            }
          } catch (e) {
            console.error('Error attaching Firebase token to request:', e);
          }
        }
        return originalFetch(input, init);
      };

      return () => {
        window.fetch = originalFetch;
      };
    }
  }, []);

  // 3. Load cookies/local preferences & listen to Firebase Auth changes
  useEffect(() => {
    // Load local settings
    const cookieLang = getCookie('billsplit_lang');
    const savedLang = cookieLang || (localStorage.getItem('billsplit_lang') as Language);
    if (savedLang && (savedLang === 'en' || savedLang === 'he')) {
      setLanguageState(savedLang);
    }

    const cookieCurr = getCookie('billsplit_currency');
    const savedCurr = cookieCurr || (localStorage.getItem('billsplit_currency') as Currency);
    if (savedCurr && ['USD', 'NIS', 'EUR'].includes(savedCurr)) {
      setCurrencyState(savedCurr);
    }

    const cookieTheme = getCookie('billsplit_theme');
    const savedTheme = cookieTheme || (localStorage.getItem('billsplit_theme') as Theme);
    if (savedTheme && ['dark', 'light'].includes(savedTheme)) {
      setThemeState(savedTheme);
    }

    let savedLocalProfile: UserProfile | null = null;
    try {
      const rawProfile = localStorage.getItem('billsplit_local_profile');
      const parsedProfile = rawProfile ? JSON.parse(rawProfile) : null;
      const localPhone = localStorage.getItem('billsplit_phone') || undefined;
      if (parsedProfile?.displayName) {
        savedLocalProfile = {
          displayName: String(parsedProfile.displayName),
          avatarColor: String(parsedProfile.avatarColor || '#4DE1A1'),
          avatarUrl: typeof parsedProfile.avatarUrl === 'string' ? parsedProfile.avatarUrl : undefined,
          phoneNumber: typeof parsedProfile.phoneNumber === 'string' ? parsedProfile.phoneNumber : localPhone,
        };
        setProfile(savedLocalProfile);
        setGuestName(savedLocalProfile.displayName);
        setGuestPhone(savedLocalProfile.phoneNumber || '');
      }
    } catch (_) {
      localStorage.removeItem('billsplit_local_profile');
    }

    // Auth subscription
    const initAuth = async () => {
      try {
        const { auth, ensureAuthPersistence } = await import('../../lib/firebase');
        await ensureAuthPersistence();
        const { onAuthStateChanged } = await import('firebase/auth');

        onAuthStateChanged(auth, async (user) => {
          setIsAuthenticating(false);
          const pendingCreatorIntent = readCreatorIntent(localStorage);
          const accountTransition = transitionAccountScope(localStorage, user?.uid || '');
          if (accountTransition.changed) {
            if (user?.uid) {
              consumeGuestAccountMigration(
                localStorage,
                sessionStorage,
                accountTransition.previousScope,
                user.uid,
              );
            } else {
              clearGuestAccountMigration(sessionStorage);
            }
            removeCookie('billsplit_user_groups');
            const pendingCreatorProfile = pendingCreatorIntent?.creatorProfile;
            if (pendingCreatorProfile?.displayName && pendingCreatorProfile?.phoneNumber) {
              const preservedProfile = {
                displayName: pendingCreatorProfile.displayName,
                phoneNumber: pendingCreatorProfile.phoneNumber,
                avatarColor: '#4DE1A1',
              };
              localStorage.setItem('billsplit_local_profile', JSON.stringify(preservedProfile));
              localStorage.setItem('billsplit_phone', pendingCreatorProfile.phoneNumber);
            }
            savedLocalProfile = null;
            setProfile({ displayName: '', avatarColor: '#4DE1A1', avatarUrl: undefined, phoneNumber: undefined });
            setGuestName('');
            setGuestPhone('');
            // Cancel old-account requests before they can repopulate caches.
            window.location.reload();
            return;
          }
          setFirebaseUser(user);
          if (user) {
            // Sync user settings and fetch DB record
            try {
              const res = await fetch(apiUrl('/api/user/sync'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  username: user.displayName || 'Google User',
                  phone: savedLocalProfile?.phoneNumber || '',
                  settings: {
                    language: savedLang || 'en',
                    currency: savedCurr || 'NIS',
                    theme: savedTheme || 'light'
                  }
                })
              });
              const data = await res.json();
              if (data && data.success && data.user) {
                setProfile({
                  displayName: data.user.username || user.displayName || 'Google User',
                  avatarColor: data.user.avatarColor || '#4DE1A1',
                  avatarUrl: savedLocalProfile?.avatarUrl || user.photoURL || undefined,
                  phoneNumber: data.user.phone || savedLocalProfile?.phoneNumber || undefined,
                });

                // Pull preferences from DB user if they exist
                if (data.user.settings?.language) setLanguageState(data.user.settings.language);
                if (data.user.settings?.currency) setCurrencyState(data.user.settings.currency);
                if (data.user.settings?.theme) setThemeState(data.user.settings.theme);
              }
            } catch (err) {
              console.error('Error syncing user with backend:', err);
              // Fallback settings
              setProfile({
                displayName: user.displayName || 'Google User',
                avatarColor: '#4DE1A1',
                avatarUrl: savedLocalProfile?.avatarUrl || user.photoURL || undefined,
                phoneNumber: savedLocalProfile?.phoneNumber,
              });
            }
          } else {
            const rawProfile = typeof window !== 'undefined' ? localStorage.getItem('billsplit_local_profile') : null;
            const parsedProfile = rawProfile ? JSON.parse(rawProfile) : null;
            if (parsedProfile?.displayName) {
              setProfile({
                displayName: String(parsedProfile.displayName),
                avatarColor: String(parsedProfile.avatarColor || '#4DE1A1'),
                avatarUrl: typeof parsedProfile.avatarUrl === 'string' ? parsedProfile.avatarUrl : undefined,
                phoneNumber: typeof parsedProfile.phoneNumber === 'string' ? parsedProfile.phoneNumber : undefined,
              });
            } else {
              setProfile({ displayName: '', avatarColor: '#4DE1A1' });
            }
          }
          setAuthLoading(false);
          setIsInitialized(true);
        });
      } catch (e) {
        console.error('Failed to initialize Firebase Auth listener:', e);
        setAuthLoading(false);
        setIsInitialized(true);
        setIsAuthenticating(false);
      }
    };

    initAuth();
  }, []);

  useEffect(() => {
    if (!isInitialized || !profile.displayName) return;
    localStorage.setItem('billsplit_local_profile', JSON.stringify(profile));
  }, [profile, isInitialized]);

  useEffect(() => {
    if (!firebaseUser) return;
    setGuestName(profile.displayName === 'Google User' ? '' : profile.displayName || '');
    setGuestPhone(profile.phoneNumber || '');
  }, [firebaseUser, profile.displayName, profile.phoneNumber]);

  // Debounced effect to sync profile and settings to the backend
  useEffect(() => {
    if (!isInitialized || authLoading || !firebaseUser) return;

    const timer = setTimeout(() => {
      fetch(apiUrl('/api/user/sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: profile.displayName,
          phone: profile.phoneNumber || '',
          settings: {
            language,
            currency,
            theme
          }
        })
      }).catch((err) => console.error('Error syncing profile settings:', err));
    }, 500);

    return () => clearTimeout(timer);
  }, [profile.displayName, profile.phoneNumber, language, currency, theme, isInitialized, authLoading, firebaseUser]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('billsplit_lang', lang);
    setCookie('billsplit_lang', lang);
  };

  const setCurrency = (curr: Currency) => {
    setCurrencyState(curr);
    localStorage.setItem('billsplit_currency', curr);
    setCookie('billsplit_currency', curr);
  };

  const setTheme = (th: Theme) => {
    setThemeState(th);
    localStorage.setItem('billsplit_theme', th);
    setCookie('billsplit_theme', th);
  };

  useEffect(() => {
    const isHebrew = language === 'he';
    document.documentElement.dir = isHebrew ? 'rtl' : 'ltr';
    document.documentElement.lang = language;

    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [language, theme]);

  const loginWithGoogle = async (options: GoogleLoginOptions = {}): Promise<GoogleLoginResult> => {
    if (isAuthenticating) return 'busy';
    setIsAuthenticating(true);
    clearAuthNotification();

    let guestMigrationPrepared = false;
    let signInCompleted = false;
    try {
      let firebaseModule: any = null;
      let activeAuth = authModules?.auth;
      let activeGetProvider = authModules?.getGoogleProvider;
      let activeSignInWithPopup = authModules?.signInWithPopup;

      if (!activeAuth) {
        firebaseModule = await import('../../lib/firebase');
        await firebaseModule.ensureAuthPersistence();
        activeAuth = firebaseModule.auth;
        if (typeof activeAuth.authStateReady === 'function') {
          await activeAuth.authStateReady();
        }
        activeGetProvider = firebaseModule.getGoogleProvider;
      }

      // Firebase is the source of truth. React state may briefly be stale after
      // a reload, but a persisted user must never be asked to sign in again.
      if (activeAuth.currentUser && !options.forceAccountSelection) {
        setFirebaseUser(activeAuth.currentUser);
        return 'authenticated';
      }

      if (!activeAuth.currentUser && typeof window !== 'undefined') {
        guestMigrationPrepared = prepareGuestAccountMigration(localStorage, sessionStorage);
      }

      if (isNativeGoogleAuthPlatform()) {
        const { GoogleAuthProvider, signInWithCredential } = await import('firebase/auth');
        const { idToken } = await signInNativeGoogle({
          forceAccountSelection: options.forceAccountSelection || Boolean(activeAuth.currentUser),
        });
        const credential = GoogleAuthProvider.credential(idToken);
        await signInWithCredential(activeAuth, credential);
        signInCompleted = true;
        return 'authenticated';
      }

      if (!activeSignInWithPopup) {
        const fbAuth = await import('firebase/auth');
        activeSignInWithPopup = fbAuth.signInWithPopup;
      }

      const provider = typeof activeGetProvider === 'function'
        ? activeGetProvider()
        : (authModules?.googleProvider || new (await import('firebase/auth')).GoogleAuthProvider());
      provider.setCustomParameters({ prompt: 'select_account' });

      // Popup is required on the hosted web app. Firebase redirect auth depends
      // on third-party storage when authDomain is on firebaseapp.com, which is
      // blocked by modern Safari/Firefox/Chrome privacy protections.
      await activeSignInWithPopup(activeAuth, provider);
      signInCompleted = true;
      return 'authenticated';
    } catch (e: any) {
      console.error('Google Sign-In failed:', e);
      if (isNativeGoogleSignInCancellation(e)
        || e?.code === 'auth/popup-closed-by-user'
        || e?.code === 'auth/cancelled-popup-request') {
        return 'cancelled';
      }
      const message = e?.code === 'auth/unauthorized-domain'
        ? (language === 'he'
            ? `Google Sign-In אינו מאושר עבור הדומיין ${window.location.hostname}. יש להוסיף את הדומיין בהגדרות Firebase.`
            : `Google Sign-In is not authorized for ${window.location.hostname}. Add this domain in Firebase Authentication > Settings > Authorized domains.`)
        : e?.code === 'auth/popup-blocked'
          ? (language === 'he'
              ? 'הדפדפן חסם את חלונית ההתחברות של Google. יש לאפשר חלונות קופצים ולנסות שוב.'
              : 'The browser blocked the Google sign-in window. Allow pop-ups and try again.')
        : (language === 'he'
            ? 'ההתחברות באמצעות Google נכשלה. אנא נסו שוב.'
            : 'Failed to sign in with Google. Please try again.');
      showAuthMessage(message, 'error');
      return 'failed';
    } finally {
      if (guestMigrationPrepared && !signInCompleted && typeof window !== 'undefined') {
        clearGuestAccountMigration(sessionStorage);
      }
      setIsAuthenticating(false);
    }
  };

  const logout = async () => {
    try {
      if (typeof window !== 'undefined') {
        clearAccountScopedStorage(localStorage);
        clearCreatorIntent(localStorage);
        clearCreatorIntent(sessionStorage);
        removeCookie('billsplit_user_groups');
      }
      setProfile({ displayName: '', avatarColor: '#4DE1A1', avatarUrl: undefined, phoneNumber: undefined });
      setGuestName('');
      setGuestPhone('');
      if (isNativeGoogleAuthPlatform()) {
        try {
          await signOutNativeGoogle();
        } catch (nativeSignOutError) {
          // Firebase remains the authoritative session; native provider cleanup is best-effort.
          console.warn('Failed to clear native Google credential state:', nativeSignOutError);
        }
      }
      const { auth } = await import('../../lib/firebase');
      const { signOut } = await import('firebase/auth');
      await signOut(auth);
      if (typeof window !== 'undefined') {
        clearAccountScopedStorage(localStorage);
        clearCreatorIntent(localStorage);
        clearCreatorIntent(sessionStorage);
        removeCookie('billsplit_user_groups');
        window.location.href = '/';
      }
    } catch (e) {
      console.error('Sign-Out failed:', e);
      setProfile({ displayName: '', avatarColor: '#4DE1A1', avatarUrl: undefined, phoneNumber: undefined });
      setGuestName('');
      setGuestPhone('');
      if (typeof window !== 'undefined') {
        clearAccountScopedStorage(localStorage);
        clearCreatorIntent(localStorage);
        clearCreatorIntent(sessionStorage);
        removeCookie('billsplit_user_groups');
        window.location.href = '/';
      }
    }
  };

  const isRtl = language === 'he';

  const t = (key: string, params?: Record<string, string | number>, defaultText?: string): string => {
    const dict = (i18nDictionary && i18nDictionary[language]) ? i18nDictionary[language] : (i18nDictionary?.en || {});
    let str = (dict && typeof dict[key] === 'string') ? dict[key] : (i18nDictionary?.en?.[key] || defaultText || key);
    if (params && typeof str === 'string') {
      Object.keys(params).forEach((paramKey) => {
        str = str.replace(`{${paramKey}}`, String(params[paramKey]));
      });
    }
    return str;
  };

  const formatPrice = (amount: number, fromCurr: string = 'NIS'): string => {
    const converted = typeof convertCurrency === 'function' ? convertCurrency(amount, fromCurr, currency) : (amount || 0);
    return typeof formatCurrency === 'function' ? formatCurrency(converted, currency) : `${converted} ${currency || 'NIS'}`;
  };

  const formatDual = (amount: number, billCurrency: string = 'NIS'): { primary: string; secondary?: string } => {
    if (typeof formatDualPrice === 'function') {
      return formatDualPrice(amount, billCurrency, currency);
    }
    const val = typeof amount === 'number' ? amount : parseFloat(amount as any) || 0;
    const primary = typeof formatCurrency === 'function' ? formatCurrency(val, billCurrency) : `${val} ${billCurrency}`;
    if (!currency || billCurrency === currency) return { primary };
    const converted = typeof convertCurrency === 'function' ? convertCurrency(val, billCurrency, currency) : val;
    const secondary = typeof formatCurrency === 'function' ? formatCurrency(converted, currency) : `${converted} ${currency}`;
    return { primary, secondary };
  };




  const showOnboarding = Boolean(
    isInitialized
    && !authLoading
    && !firebaseUser
    && (!profile.displayName.trim() || !profile.phoneNumber || !isValidIsraeliPhone(profile.phoneNumber))
  );
  const showAuthenticatedProfileCompletion = Boolean(
    isInitialized
    && !authLoading
    && firebaseUser
    && (!profile.displayName.trim() || !profile.phoneNumber || !isValidIsraeliPhone(profile.phoneNumber))
  );
  const showProfileModal = showOnboarding || showAuthenticatedProfileCompletion;

  return (
    <LanguageContext.Provider
      value={{
        language,
        setLanguage,
        isRtl,
        t,
        currency,
        setCurrency,
        theme,
        setTheme,
        profile,
        setProfile,
        formatPrice,
        formatDual,
        firebaseUser,
        authLoading,
        isAuthenticating,
        authNotification,
        clearAuthNotification,
        loginWithGoogle,
        logout
      }}
    >
      {/* Sleek In-App Toast Notification */}
      {authNotification && (
        <div
          role="alert"
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-[10000] max-w-[92vw] sm:max-w-md w-full p-4 rounded-2xl shadow-2xl backdrop-blur-md border transition-all duration-300 animate-in fade-in slide-in-from-top-4 flex items-start gap-3 ${
            authNotification.type === 'error'
              ? 'bg-rose-950/90 dark:bg-rose-950/95 border-rose-500/40 text-rose-100'
              : authNotification.type === 'success'
              ? 'bg-emerald-950/90 dark:bg-emerald-950/95 border-emerald-500/40 text-emerald-100'
              : 'bg-slate-900/90 dark:bg-[#15142A]/95 border-slate-700/50 text-slate-100'
          }`}
          dir={isRtl ? 'rtl' : 'ltr'}
        >
          <div className="shrink-0 mt-0.5">
            {authNotification.type === 'error' ? (
              <AlertCircle className="w-5 h-5 text-rose-400" />
            ) : authNotification.type === 'success' ? (
              <CheckCircle className="w-5 h-5 text-emerald-400" />
            ) : (
              <Sparkles className="w-5 h-5 text-brand-400" />
            )}
          </div>
          <div className="flex-1 text-xs font-semibold leading-relaxed">
            {authNotification.message}
          </div>
          <button
            type="button"
            onClick={clearAuthNotification}
            className="shrink-0 p-1 rounded-lg hover:bg-white/10 text-slate-300 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {children}

      {/* Global Onboarding / Profile Modal */}
      {showProfileModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-md animate-fadeIn" dir={isRtl ? 'rtl' : 'ltr'}>
          <div role="dialog" aria-modal="true" aria-label={language === 'he' ? 'ברוכים הבאים ל-EasySplit' : 'Welcome to EasySplit'} className="w-full max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain rounded-[28px] p-6 bg-white dark:bg-brand-900 border border-slate-200 dark:border-[#222C3D] text-slate-900 dark:text-white space-y-4 shadow-2xl transition-all">
            
            {/* Language Switcher */}
            <div className={`flex ${isRtl ? 'justify-start' : 'justify-end'} items-center`}>
              <button
                type="button"
                onClick={() => setLanguage(language === 'en' ? 'he' : 'en')}
                className="text-xs flex items-center gap-1.5 py-1 px-3 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-semibold transition-all active:scale-95"
              >
                <Globe className="w-3.5 h-3.5" />
                {language === 'en' ? 'עברית' : 'English'}
              </button>
            </div>

            <div className="text-center">
              <div className="inline-flex p-3.5 rounded-full bg-brand-100 dark:bg-brand-950/50 text-brand-600 dark:text-brand-400 mb-2 shadow-sm">
                <Sparkles className="w-6 h-6 animate-pulse" />
              </div>
              <h3 className="text-xl font-extrabold tracking-tight">
                {language === 'he' ? 'ברוכים הבאים ל-EasySplit' : 'Welcome to EasySplit'}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
                {firebaseUser
                  ? (language === 'he' ? 'השלימו את מספר הטלפון כדי לאפשר העברות Bit/Paybox בחלוקות.' : 'Complete your phone number to enable Bit/Paybox transfers.')
                  : (language === 'he' ? 'מלאו פרטים להמשך כאורח, או התחברו עם Google לסנכרון בין מכשירים.' : 'Enter your details, or sign in with Google to sync across devices.')}
              </p>
            </div>

            {/* Google Account Status Badge if authenticated */}
            {firebaseUser && (
              <div className="p-3.5 rounded-2xl bg-white dark:bg-[#15142A] border border-slate-200/90 dark:border-[#2A2847] shadow-xs flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 overflow-hidden">
                  {firebaseUser.photoURL ? (
                    <img
                      src={firebaseUser.photoURL}
                      alt={firebaseUser.displayName || 'Google'}
                      className="w-9 h-9 rounded-full object-cover shrink-0 ring-2 ring-slate-100 dark:ring-white/10"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white font-bold text-sm flex items-center justify-center shrink-0 shadow-xs">
                      {(firebaseUser.displayName || firebaseUser.email || 'U').charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="overflow-hidden min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                        {firebaseUser.displayName || 'Google User'}
                      </span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200/50 dark:border-emerald-800/40 shrink-0">
                        Google
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate mt-0.5">
                      {firebaseUser.email}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void loginWithGoogle({ forceAccountSelection: true })}
                  disabled={isAuthenticating}
                  className="text-[11px] font-bold text-brand-600 dark:text-brand-300 px-3 py-1.5 rounded-xl bg-brand-50 hover:bg-brand-100 dark:bg-brand-950/60 dark:hover:bg-brand-900/60 transition-all shrink-0 flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={language === 'he' ? 'החלף חשבון Google' : 'Switch Google account'}
                >
                  {isAuthenticating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : null}
                  <span>{language === 'he' ? 'החלף חשבון' : 'Switch'}</span>
                </button>
              </div>
            )}

            <form
              className="space-y-3 pt-1"
              onSubmit={(event) => {
                event.preventDefault();
                const displayName = guestName.trim();
                const phoneNumber = cleanIsraeliPhone(guestPhone);
                if (!displayName || !isValidIsraeliPhone(phoneNumber)) return;
                const completedProfile = {
                  ...profile,
                  displayName,
                  phoneNumber,
                  avatarColor: profile.avatarColor || '#4DE1A1',
                  avatarUrl: profile.avatarUrl || firebaseUser?.photoURL || undefined,
                };
                localStorage.setItem('billsplit_local_profile', JSON.stringify(completedProfile));
                localStorage.setItem('billsplit_phone', phoneNumber);
                setProfile(completedProfile);
              }}
            >
              <div>
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block mb-1">
                  {language === 'he' ? 'שם לתצוגה' : 'Display Name'}
                </label>
                <input
                  value={guestName}
                  onChange={(event) => setGuestName(event.target.value)}
                  maxLength={30}
                  placeholder={language === 'he' ? 'השם שיוצג לחברים' : 'Your display name'}
                  aria-label={language === 'he' ? 'שם תצוגה' : 'Display name'}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none focus:border-brand-600 dark:focus:border-brand-400 dark:border-slate-700 dark:bg-slate-900"
                  required
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block mb-1">
                  {language === 'he' ? 'מספר טלפון (Bit / Paybox)' : 'Phone Number (Bit / Paybox)'}
                </label>
                <div className="relative">
                  <Phone className="pointer-events-none absolute left-3.5 rtl:left-auto rtl:right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="tel"
                    inputMode="tel"
                    value={guestPhone}
                    onChange={(event) => setGuestPhone(event.target.value)}
                    maxLength={16}
                    placeholder={language === 'he' ? '0501234567' : '0501234567'}
                    aria-label={language === 'he' ? 'מספר טלפון' : 'Phone number'}
                    className={`w-full rounded-xl border ${guestPhone && !isValidIsraeliPhone(guestPhone) ? 'border-amber-400 dark:border-amber-500' : 'border-slate-200 dark:border-slate-700'} bg-slate-50 py-3 pl-10 pr-4 rtl:pl-4 rtl:pr-10 text-sm font-semibold font-mono outline-none focus:border-brand-600 dark:focus:border-brand-400 dark:bg-slate-900`}
                    required
                  />
                </div>
                {guestPhone && !isValidIsraeliPhone(guestPhone) && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 font-semibold mt-1">
                    {language === 'he' ? 'יש להזין מספר נייד תקין בן 10 ספרות המתחיל ב-05' : 'Please enter a valid 10-digit Israeli mobile number starting with 05'}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={!guestName.trim() || !isValidIsraeliPhone(guestPhone)}
                className="w-full rounded-xl bg-brand-600 hover:bg-brand-700 py-3.5 text-sm font-extrabold text-white shadow-brand transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {firebaseUser
                  ? (language === 'he' ? 'שמירה והמשך' : 'Save and continue')
                  : (language === 'he' ? 'המשך כאורח' : 'Continue as guest')}
              </button>
            </form>

            {!firebaseUser && (
              <div className="pt-1">
                <div className="mb-2 text-center text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  {language === 'he' ? 'או' : 'or'}
                </div>
                <button
                  type="button"
                  onClick={() => void loginWithGoogle()}
                  disabled={isAuthenticating}
                  className="w-full py-3.5 rounded-xl bg-slate-50 hover:bg-slate-100 dark:bg-[#1C2638] dark:hover:bg-[#222E45] border border-slate-200 dark:border-[#2a374f] text-slate-800 dark:text-slate-100 text-sm font-bold shadow-md hover:shadow-lg transition-all active:scale-95 flex items-center justify-center gap-3 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isAuthenticating ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin text-brand-600 dark:text-brand-400" />
                      <span>{language === 'he' ? 'מתחבר ל-Google...' : 'Connecting with Google...'}</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
                        <path
                          fill="#EA4335"
                          d="M12 5.04c1.66 0 3.2.57 4.38 1.69l3.27-3.27C17.68 1.54 14.98 1 12 1 7.24 1 3.2 3.73 1.24 7.72l3.96 3.07C6.16 7.6 8.85 5.04 12 5.04z"
                        />
                        <path
                          fill="#4285F4"
                          d="M23.49 12.27c0-.81-.07-1.59-.2-2.33H12v4.42h6.45c-.28 1.47-1.11 2.71-2.36 3.56l3.66 2.84c2.14-1.97 3.38-4.88 3.38-8.49z"
                        />
                        <path
                          fill="#FBBC05"
                          d="M5.2 10.79c-.25-.72-.39-1.49-.39-2.29s.14-1.57.39-2.29L1.24 3.14C.45 4.73 0 6.51 0 8.5s.45 3.77 1.24 5.36l3.96-3.07z"
                        />
                        <path
                          fill="#34A853"
                          d="M12 23c3.24 0 5.97-1.07 7.96-2.92l-3.66-2.84c-1.01.68-2.31 1.09-4.3 1.09-3.15 0-5.84-2.56-6.8-5.75L1.24 13.65C3.2 17.64 7.24 23 12 23z"
                        />
                      </svg>
                      <span>{language === 'he' ? 'התחבר עם Google' : 'Sign in with Google'}</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return ctx;
};
