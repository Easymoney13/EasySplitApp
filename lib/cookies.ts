/**
 * Cookie Storage Utility for persistent state management
 */

export function setCookie(name: string, value: any, days: number = 365) {
  try {
    const stringVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const date = new Date();
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
    const expires = `; expires=${date.toUTCString()}`;
    const secureFlag = typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(stringVal)}${expires}; path=/; SameSite=Lax${secureFlag}`;
  } catch (e) {
    console.error('Error writing cookie:', e);
  }
}

export function getCookie(name: string): any {
  try {
    const nameEQ = `${name}=`;
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i];
      while (c.charAt(0) === ' ') c = c.substring(1, c.length);
      if (c.indexOf(nameEQ) === 0) {
        const raw = decodeURIComponent(c.substring(nameEQ.length, c.length));
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      }
    }
  } catch (e) {
    console.error('Error reading cookie:', e);
  }
  return null;
}

export function removeCookie(name: string) {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
}
