import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/app/globals.css';
import './mobile.css';
import HomePage from '../src/app/page';
import SessionPage from '../src/app/session/[id]/page';
import GroupPage from '../src/app/group/[id]/page';
import { LanguageProvider } from '../src/components/LanguageContext';
import { NAV_EVENT, routeFromSearch } from './router-core.mjs';
import { installMobileRuntime } from './runtime/mobileRuntime';

window.__EASYSPLIT_MOBILE_SHELL__ = true;
window.__EASYSPLIT_MOBILE_RUNTIME_READY__ = false;
document.documentElement.classList.add('easysplit-mobile');
document.body.className = 'app-viewport bg-brand-950 text-brand-950 min-h-0 overflow-hidden antialiased';

function routeView(route: string) {
  if (/^\/session\/[^/]+$/.test(route)) return <SessionPage />;
  if (/^\/group\/[^/]+$/.test(route)) return <GroupPage />;
  return <HomePage />;
}

function MobileApp() {
  const [route, setRoute] = useState(() => routeFromSearch(window.location.search));

  useEffect(() => {
    const syncRoute = () => setRoute(routeFromSearch(window.location.search));
    window.addEventListener('popstate', syncRoute);
    window.addEventListener(NAV_EVENT, syncRoute);
    return () => {
      window.removeEventListener('popstate', syncRoute);
      window.removeEventListener(NAV_EVENT, syncRoute);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let cleanup: undefined | (() => Promise<void>);
    installMobileRuntime().then((remove) => {
      if (disposed) {
        void remove();
      } else {
        cleanup = remove;
        window.__EASYSPLIT_MOBILE_RUNTIME_READY__ = true;
      }
    });
    return () => {
      disposed = true;
      window.__EASYSPLIT_MOBILE_RUNTIME_READY__ = false;
      void cleanup?.();
    };
  }, []);

  return (
    <LanguageProvider>
      <div className="app-viewport w-full min-h-0 bg-[#F8F8FC] dark:bg-brand-950 relative overflow-hidden flex flex-col">
        <main className="flex-1 min-h-0 w-full relative z-10 flex flex-col overflow-y-auto">
          {routeView(route)}
        </main>
      </div>
    </LanguageProvider>
  );
}

createRoot(document.getElementById('root')!).render(<MobileApp />);
