import { initializeApp, getApps, getApp } from "firebase/app";
import { browserLocalPersistence, getAuth, GoogleAuthProvider, setPersistence } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyBQmeJV8TR77XGRSybwTJXA6HZXh8DmGx8",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "easysplit-24576.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "easysplit-24576",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "easysplit-24576.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "510350845002",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:510350845002:web:cc49a335ab30154bbcb2b3",
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || "G-WFV5CP6F4Q"
};

// Prevent duplicate initialization on Hot Reloads
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
let authPersistencePromise: Promise<void> | null = null;

// Make the one-time account login explicit. Firebase normally selects local
// persistence in browsers, but setting it deliberately prevents mobile browser
// and Capacitor auth flows from silently degrading to an in-memory session.
export function ensureAuthPersistence(): Promise<void> {
  if (!authPersistencePromise) {
    authPersistencePromise = setPersistence(auth, browserLocalPersistence).catch((error) => {
      // Authentication must still initialize on browsers that disable durable
      // storage. The user can retry persistence on the next full app load.
      console.warn('Durable Firebase auth persistence is unavailable:', error);
    });
  }
  return authPersistencePromise;
}

// Configure Google provider options
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

export const getGoogleProvider = () => {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    prompt: 'select_account'
  });
  return provider;
};

export { app, auth, googleProvider };
