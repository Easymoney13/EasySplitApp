import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { StatusBar, Style } from '@capacitor/status-bar';
import { MOBILE_BACK_REQUEST_EVENT, MOBILE_RECOVERY_EVENT } from '../../lib/mobileEvents';
import {
  NAV_EVENT,
  backAction,
  buildShellSearch,
  initialHistoryPlan,
} from '../router-core.mjs';


export async function installMobileRuntime() {
  const handles = [];
  let lastRecoverySignalAt = 0;

  const initialPlan = initialHistoryPlan(window.location.search, window.history.state);
  if (initialPlan.seedHome) {
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const inheritedState = { ...(window.history.state || {}) };
    window.history.replaceState({ ...inheritedState, esDepth: 0 }, '', `${window.location.pathname}${buildShellSearch('/')}`);
    window.history.pushState({ ...inheritedState, esDepth: 1 }, '', currentUrl);
  } else if (!window.history.state || typeof window.history.state.esDepth !== 'number') {
    window.history.replaceState({ ...(window.history.state || {}), esDepth: initialPlan.depth }, '', window.location.href);
  }

  const emitRecovery = (reason: 'resume' | 'network-online') => {
    const now = Date.now();
    if (now - lastRecoverySignalAt < 750) return;
    lastRecoverySignalAt = now;
    window.dispatchEvent(new CustomEvent(MOBILE_RECOVERY_EVENT, { detail: { reason } }));
  };

  const emitResume = () => {
    window.dispatchEvent(new Event('easysplit:app-resume'));
    emitRecovery('resume');
  };

  handles.push(await App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) emitResume();
  }));

  handles.push(await App.addListener('resume', emitResume));

  // Keep the App plugin's default back handler enabled in config. Registering this
  // listener intentionally takes ownership of Android back navigation.
  handles.push(await App.addListener('backButton', async () => {
    const backRequest = new Event(MOBILE_BACK_REQUEST_EVENT, { cancelable: true });
    window.dispatchEvent(backRequest);
    if (backRequest.defaultPrevented) return;

    const action = backAction(window.location.search, window.history.state);
    if (action === 'history-back') {
      window.history.back();
      return;
    }

    if (action === 'home') {
      const search = buildShellSearch('/');
      window.history.replaceState({ ...(window.history.state || {}), esDepth: 0 }, '', `${window.location.pathname}${search}`);
      window.dispatchEvent(new Event(NAV_EVENT));
      return;
    }

    await App.exitApp();
  }));

  handles.push(await Network.addListener('networkStatusChange', ({ connected }) => {
    window.dispatchEvent(new Event(connected ? 'easysplit:network-online' : 'easysplit:network-offline'));
    if (connected) emitRecovery('network-online');
  }));

  try {
    await StatusBar.setStyle({ style: Style.Default });
  } catch (_) {
    // Non-fatal: status-bar styling must never block the core product.
  }

  return async () => {
    await Promise.all(handles.map((handle) => handle.remove()));
  };
}
