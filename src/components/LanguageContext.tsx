'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { Sparkles, Phone, User, Globe, LogOut } from 'lucide-react';
import defaultTranslations, { translations as namedTranslations, formatCurrency, convertCurrency, formatDualPrice, updateLiveExchangeRates } from '../../lib/i18n';
import { getCookie, setCookie, removeCookie } from '../../lib/cookies';
import { clearAccountScopedStorage, transitionAccountScope } from '../../lib/accountIsolation';
import { isProtectedSameOriginApi } from '../../lib/authFetch';

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
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>('en');
  const [currency, setCurrencyState] = useState<Currency>('NIS');
  const [theme, setThemeState] = useState<Theme>('light');
  const [isInitialized, setIsInitialized] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [firebaseUser, setFirebaseUser] = useState<any>(null);
  const [authModules, setAuthModules] = useState<any>(null);
  const [guestName, setGuestName] = useState('');
  
  // Preload Firebase Auth modules on client mount to bypass popup blocker limitations on mobile
  useEffect(() => {
    const preload = async () => {
      try {
        const { auth, googleProvider } = await import('../../lib/firebase');
        const { signInWithPopup, signInWithRedirect } = await import('firebase/auth');
        setAuthModules({ auth, googleProvider, signInWithPopup, signInWithRedirect });
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
    fetch('/api/exchange-rates')
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
        if (isProtectedSameOriginApi(input, window.location.origin)) {
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
      }
    } catch (_) {
      localStorage.removeItem('billsplit_local_profile');
    }

    // Auth subscription
    const initAuth = async () => {
      try {
        const { auth } = await import('../../lib/firebase');
        const { onAuthStateChanged, getRedirectResult } = await import('firebase/auth');
        
        // Handle redirect result if returning from a Google redirect flow
        getRedirectResult(auth)
          .then((result) => {
            if (result) {
              console.log('Successfully authenticated user via redirect:', result.user);
            }
          })
          .catch((err) => {
            console.error('Error handling redirect authentication:', err);
          });

        onAuthStateChanged(auth, async (user) => {
          const accountTransition = transitionAccountScope(localStorage, user?.uid || '');
          if (accountTransition.changed) {
            removeCookie('billsplit_user_groups');
            savedLocalProfile = null;
            setProfile({ displayName: '', avatarColor: '#4DE1A1', avatarUrl: undefined, phoneNumber: undefined });
            setGuestName('');
            // Cancel old-account requests before they can repopulate caches.
            window.location.reload();
            return;
          }
          setFirebaseUser(user);
          if (user) {
            // Sync user settings and fetch DB record
            try {
              const res = await fetch('/api/user/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  username: user.displayName || 'Google User',
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
                  avatarUrl: savedLocalProfile?.avatarUrl || user.photoURL || undefined
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
                avatarUrl: savedLocalProfile?.avatarUrl || user.photoURL || undefined
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
      }
    };

    initAuth();
  }, []);

  useEffect(() => {
    if (!isInitialized || !profile.displayName) return;
    localStorage.setItem('billsplit_local_profile', JSON.stringify(profile));
  }, [profile, isInitialized]);

  // Debounced effect to sync profile and settings to the backend
  useEffect(() => {
    if (!isInitialized || authLoading || !firebaseUser) return;

    const timer = setTimeout(() => {
      fetch('/api/user/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: profile.displayName,
          settings: {
            language,
            currency,
            theme
          }
        })
      }).catch((err) => console.error('Error syncing profile settings:', err));
    }, 500);

    return () => clearTimeout(timer);
  }, [profile.displayName, language, currency, theme, isInitialized, authLoading, firebaseUser]);

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

  const loginWithGoogle = async () => {
    try {
      let activeAuth, activeProvider, activeSignInWithPopup, activeSignInWithRedirect;
      
      if (authModules) {
        activeAuth = authModules.auth;
        activeProvider = authModules.googleProvider;
        activeSignInWithPopup = authModules.signInWithPopup;
        activeSignInWithRedirect = authModules.signInWithRedirect;
      } else {
        const { auth, googleProvider } = await import('../../lib/firebase');
        const { signInWithPopup, signInWithRedirect } = await import('firebase/auth');
        activeAuth = auth;
        activeProvider = googleProvider;
        activeSignInWithPopup = signInWithPopup;
        activeSignInWithRedirect = signInWithRedirect;
      }
      
      // Attempt signInWithPopup first. Because it's called synchronously within the click handler tick (no await yields before it if authModules is preloaded),
      // the browser will allow the popup to open without blocking it.
      try {
        await activeSignInWithPopup(activeAuth, activeProvider);
      } catch (popupError: any) {
        console.warn('signInWithPopup failed, falling back to signInWithRedirect:', popupError);
        if (popupError.code === 'auth/popup-blocked' || popupError.code === 'auth/operation-not-supported') {
          await activeSignInWithRedirect(activeAuth, activeProvider);
        } else {
          throw popupError;
        }
      }
    } catch (e) {
      console.error('Google Sign-In failed:', e);
      alert('Failed to sign in with Google. Please try again.');
    }
  };

  const logout = async () => {
    try {
      if (typeof window !== 'undefined') {
        clearAccountScopedStorage(localStorage);
        removeCookie('billsplit_user_groups');
      }
      setProfile({ displayName: '', avatarColor: '#4DE1A1', avatarUrl: undefined, phoneNumber: undefined });
      setGuestName('');
      const { auth } = await import('../../lib/firebase');
      const { signOut } = await import('firebase/auth');
      await signOut(auth);
      if (typeof window !== 'undefined') {
        clearAccountScopedStorage(localStorage);
        removeCookie('billsplit_user_groups');
        window.location.href = '/';
      }
    } catch (e) {
      console.error('Sign-Out failed:', e);
      setProfile({ displayName: '', avatarColor: '#4DE1A1', avatarUrl: undefined, phoneNumber: undefined });
      setGuestName('');
      if (typeof window !== 'undefined') {
        clearAccountScopedStorage(localStorage);
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




  const showOnboarding = isInitialized && !authLoading && !firebaseUser && !profile.displayName;

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
        loginWithGoogle,
        logout
      }}
    >
      {children}

      {/* Global Onboarding Modal for New/Unauthenticated Users */}
      {showOnboarding && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-md animate-fadeIn" dir={isRtl ? 'rtl' : 'ltr'}>
          <div role="dialog" aria-modal="true" aria-label={language === 'he' ? 'ברוכים הבאים ל-EasySplit' : 'Welcome to EasySplit'} className="w-full max-w-sm rounded-[24px] p-6 bg-white dark:bg-brand-900 border border-slate-200 dark:border-[#222C3D] text-slate-900 dark:text-white space-y-4 shadow-2xl transition-all">
            
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
                {language === 'he' ? 'אפשר להתחיל מיד כאורח, או להתחבר כדי לסנכרן בין מכשירים.' : 'Start immediately as a guest, or sign in to sync across devices.'}
              </p>
            </div>

            <form
              className="space-y-2 pt-2"
              onSubmit={(event) => {
                event.preventDefault();
                const displayName = guestName.trim();
                if (!displayName) return;
                setProfile({ displayName, avatarColor: '#0F172A', avatarUrl: undefined });
              }}
            >
              <input
                value={guestName}
                onChange={(event) => setGuestName(event.target.value)}
                maxLength={30}
                placeholder={language === 'he' ? 'השם שיוצג לחברים' : 'Your display name'}
                aria-label={language === 'he' ? 'שם תצוגה' : 'Display name'}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none focus:border-slate-900 dark:focus:border-white dark:border-slate-700 dark:bg-slate-900"
                required
              />
              <button
                type="submit"
                className="w-full rounded-xl bg-slate-900 dark:bg-white hover:bg-slate-800 dark:hover:bg-slate-200 py-3.5 text-sm font-extrabold text-white dark:text-slate-900 shadow-md transition-all active:scale-95"
              >
                {language === 'he' ? 'המשך כאורח' : 'Continue as guest'}
              </button>
            </form>

            <div className="pt-1">
              <div className="mb-2 text-center text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {language === 'he' ? 'או' : 'or'}
              </div>
              <button
                type="button"
                onClick={loginWithGoogle}
                className="w-full py-3.5 rounded-xl bg-slate-50 hover:bg-slate-100 dark:bg-[#1C2638] dark:hover:bg-[#222E45] border border-slate-200 dark:border-[#2a374f] text-slate-800 dark:text-slate-100 text-sm font-bold shadow-md hover:shadow-lg transition-all active:scale-95 flex items-center justify-center gap-3"
              >
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
              </button>
            </div>
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
