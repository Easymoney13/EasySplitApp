/**
 * Mobile Haptic Vibration Feedback Utility
 * Delivers crisp tactile haptic feedback for user actions on iOS (Taptic Engine) & Android
 */

import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

export async function triggerHaptic(type: 'light' | 'medium' | 'heavy' | 'success' | 'warning' = 'light') {
  if (typeof window === 'undefined') return;

  if (Capacitor.isNativePlatform()) {
    try {
      switch (type) {
        case 'light':
          await Haptics.impact({ style: ImpactStyle.Light });
          break;
        case 'medium':
          await Haptics.impact({ style: ImpactStyle.Medium });
          break;
        case 'heavy':
          await Haptics.impact({ style: ImpactStyle.Heavy });
          break;
        case 'success':
          await Haptics.notification({ type: NotificationType.Success });
          break;
        case 'warning':
          await Haptics.notification({ type: NotificationType.Warning });
          break;
        default:
          await Haptics.impact({ style: ImpactStyle.Light });
      }
      return;
    } catch (_) {
      // Fallback to web vibration below
    }
  }

  if ('vibrate' in navigator) {
    try {
      switch (type) {
        case 'light':
          navigator.vibrate(12);
          break;
        case 'medium':
          navigator.vibrate(22);
          break;
        case 'heavy':
          navigator.vibrate(35);
          break;
        case 'success':
          navigator.vibrate([15, 40, 20]);
          break;
        case 'warning':
          navigator.vibrate([35, 60, 35]);
          break;
        default:
          navigator.vibrate(15);
      }
    } catch (_) {
      // Ignore unsupported browser errors
    }
  }
}
