'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Receipt,
  History,
  Settings,
  Camera,
  Upload,
  ArrowRight,
  Sparkles,
  User,
  Trash2,
  Check,
  Globe,
  LogOut,
  QrCode,
  Play,
  Moon,
  Sun,
  FilePlus,
  Users,
  X,
  Share2,
  PieChart,
  TrendingUp,
  Utensils,
  ShoppingCart,
  Plane,
  Wine,
  Box,
  Pencil,
  LockOpen,
  Coffee,
  Loader2
} from 'lucide-react';
import { useLanguage, DEFAULT_REAL_AVATAR } from '../components/LanguageContext';
import { CameraViewfinder } from '../components/CameraViewfinder';
import { QRCodeModal } from '../components/QRCodeModal';
import { OCRProgressOverlay } from '../components/OCRProgressOverlay';
import { SwipeableCard } from '../components/SwipeableCard';
import { ManualBillModal } from '../components/ManualBillModal';
import { CreateGroupModal } from '../components/CreateGroupModal';
import { SleepingPandaIllustration } from '../components/PandaIllustrations';
import { EasySplitWordmark } from '../components/EasySplitBrand';
import { compressAvatarImage } from '../../lib/imageUtils';
import { createReceiptDraft, receiptConfirmationPayload, receiptScanUserMessage } from '../../lib/receiptScanClient';
import { getCookie, setCookie } from '../../lib/cookies';
import { triggerHaptic } from '../../lib/haptics';
import { MOBILE_BACK_REQUEST_EVENT } from '../../lib/mobileEvents';
import { clearRoomCredentials, clearSessionInviteToken, getOrCreateRoomClientId, getSessionInviteToken, roomHeaders, saveRoomCredentials, saveSessionInviteToken } from '../../lib/roomTokens';
import { fetchPaginatedAccountData } from '../../lib/accountClient';
import { apiUrl, publicWebUrl } from '../../lib/platformTransport';
import { cleanIsraeliPhone, isValidIsraeliPhone } from '../../lib/bitDeepLink';
import { copyText, shareInvite } from '../../lib/nativeActions';
import {
  collectCachedRoomIds,
  purgeDeletedGroupFromStorage,
  purgeDeletedRoomsFromStatus,
  purgeDeletedSessionFromStorage,
  purgeRoomCredentialsFromStorage,
} from '../../lib/localLifecycle';
import { Capacitor } from '@capacitor/core';
import { Camera as CapCamera, CameraResultType, CameraSource } from '@capacitor/camera';

const PASTEL_COLORS = [
  { bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-800 dark:text-slate-200' },
  { bg: 'bg-amber-100 dark:bg-amber-950/60', text: 'text-amber-700 dark:text-amber-300' },
  { bg: 'bg-brand-100 dark:bg-brand-950/60', text: 'text-brand-700 dark:text-brand-300' },
  { bg: 'bg-sky-100 dark:bg-sky-950/60', text: 'text-sky-700 dark:text-sky-300' },
  { bg: 'bg-brand-100 dark:bg-brand-950/60', text: 'text-brand-700 dark:text-brand-300' },
  { bg: 'bg-pink-100 dark:bg-pink-950/60', text: 'text-pink-700 dark:text-pink-300' },
  { bg: 'bg-zinc-100 dark:bg-zinc-800', text: 'text-zinc-700 dark:text-zinc-300' },
];

function PorcelainReceiptMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 48 54"
      className="h-[52px] w-12 shrink-0 drop-shadow-[0_8px_14px_rgba(37,33,111,0.16)]"
    >
      <path
        d="M5 3.5C5 1.57 6.57 0 8.5 0h31C41.43 0 43 1.57 43 3.5V48l-4.75-4-4.75 4-4.75-4L24 48l-4.75-4-4.75 4-4.75-4L5 48V3.5Z"
        fill="#F7F6FC"
      />
      <path d="M14 16h20M14 24h16M14 32h12" stroke="#302DA4" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

async function convergeGuestRoomCaches(storage: Storage) {
  const { sessionIds, groupIds } = collectCachedRoomIds(storage);
  if (sessionIds.length === 0 && groupIds.length === 0) {
    return { deletedSessions: [], deletedGroups: [], closedGroups: [], settledSessions: [], reopenedSessions: [] };
  }
  const deletedSessions: string[] = [];
  const deletedGroups: string[] = [];
  const closedGroups: any[] = [];
  const settledSessions: string[] = [];
  const reopenedSessions: string[] = [];
  const roomRefs = [
    ...sessionIds.map((id: string) => ({ kind: 'session', id })),
    ...groupIds.map((id: string) => ({ kind: 'group', id })),
  ];
  for (let offset = 0; offset < roomRefs.length; offset += 50) {
    const batch = roomRefs.slice(offset, offset + 50);
    const response = await fetch(apiUrl('/api/rooms/status'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-EasySplit-Client-Id': getOrCreateRoomClientId(),
      },
      body: JSON.stringify({
        sessionIds: batch.filter((entry) => entry.kind === 'session').map((entry) => entry.id),
        groupIds: batch.filter((entry) => entry.kind === 'group').map((entry) => entry.id),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not validate cached rooms');
    const purged = purgeDeletedRoomsFromStatus(storage, data);
    deletedSessions.push(...purged.deletedSessions);
    deletedGroups.push(...purged.deletedGroups);
    closedGroups.push(...(purged.closedGroups || []));
    settledSessions.push(...(purged.settledSessions || []));
    reopenedSessions.push(...(purged.reopenedSessions || []));
  }
  return { deletedSessions, deletedGroups, closedGroups, settledSessions, reopenedSessions };
}

export default function HomePage() {
  const router = useRouter();
  const {
    t,
    language,
    setLanguage,
    currency,
    setCurrency,
    theme,
    setTheme,
    profile,
    setProfile,
    formatPrice,
    formatDual,
    isRtl,
    firebaseUser,
    isAuthenticating,
    loginWithGoogle,
    logout
  } = useLanguage();

  const [activeTab, setActiveTab] = useState<'history' | 'sessions' | 'settings'>('sessions');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab');
      if (tab === 'history' || tab === 'sessions' || tab === 'settings') {
        setActiveTab(tab);
        // Clean up the URL search params so it doesn't persist on page refresh
        const newUrl = window.location.pathname;
        window.history.replaceState({}, '', newUrl);
      }
    }
  }, []);

  const [universalJoinCode, setUniversalJoinCode] = useState('');
  const [showCamera, setShowCamera] = useState(false);
  const [showManualModal, setShowManualModal] = useState(false);
  const [pendingReceiptDraft, setPendingReceiptDraft] = useState<any>(null);
  const [pendingScanId, setPendingScanId] = useState('');
  const [pendingRecoveryToken, setPendingRecoveryToken] = useState('');
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [selectedGroupForModal, setSelectedGroupForModal] = useState<any | null>(null);
  const [groupModalTab, setGroupModalTab] = useState<'options' | 'details'>('options');
  const [userGroups, setUserGroups] = useState<any[]>([]);
  const [closedGroups, setClosedGroups] = useState<any[]>([]);
  const [activeSession, setActiveSession] = useState<any>(null);
  const [historyList, setHistoryList] = useState<any[]>([]);
  const [showQrModal, setShowQrModal] = useState(false);
  const [showStartSplitModal, setShowStartSplitModal] = useState(false);
  const [showJoinSessionModal, setShowJoinSessionModal] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android' || !showStartSplitModal) return;

    const consumeNativeBack = (event: Event) => {
      event.preventDefault();
      setShowStartSplitModal(false);
    };
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, consumeNativeBack);
    return () => window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, consumeNativeBack);
  }, [showStartSplitModal]);

  // Swipe-down to dismiss gestures for start split & group modals
  const [splitModalDragY, setSplitModalDragY] = useState(0);
  const splitTouchStartY = useRef<number | null>(null);

  const handleSplitTouchStart = (e: React.TouchEvent) => {
    splitTouchStartY.current = e.touches[0].clientY;
  };
  const handleSplitTouchMove = (e: React.TouchEvent) => {
    if (splitTouchStartY.current === null) return;
    const diff = e.touches[0].clientY - splitTouchStartY.current;
    if (diff > 0) setSplitModalDragY(diff);
  };
  const handleSplitTouchEnd = () => {
    if (splitModalDragY > 75) {
      setShowStartSplitModal(false);
    }
    setSplitModalDragY(0);
    splitTouchStartY.current = null;
  };

  const [groupModalDragY, setGroupModalDragY] = useState(0);
  const groupTouchStartY = useRef<number | null>(null);

  const closeGroupModal = () => {
    setSelectedGroupForModal(null);
    setGroupModalTab('options');
    setGroupModalDragY(0);
    groupTouchStartY.current = null;
  };

  const handleGroupTouchStart = (e: React.TouchEvent) => {
    groupTouchStartY.current = e.touches[0].clientY;
  };
  const handleGroupTouchMove = (e: React.TouchEvent) => {
    if (groupTouchStartY.current === null) return;
    const diff = e.touches[0].clientY - groupTouchStartY.current;
    if (diff > 0) setGroupModalDragY(diff);
  };
  const handleGroupTouchEnd = () => {
    if (groupModalDragY > 75) {
      closeGroupModal();
      return;
    }
    setGroupModalDragY(0);
    groupTouchStartY.current = null;
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const avatarFileInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const base64 = await compressAvatarImage(file);
      if (base64) {
        setProfile((prev) => ({
          ...prev,
          avatarUrl: base64
        }));
        triggerHaptic('success');
      }
    } catch (err) {
      console.error('Error uploading avatar:', err);
      alert('Failed to process profile image.');
    }
  };

  const handleResetPhoto = () => {
    setProfile((prev) => {
      const { avatarUrl, ...rest } = prev;
      return rest;
    });
    triggerHaptic('medium');
    if (avatarFileInputRef.current) {
      avatarFileInputRef.current.value = '';
    }
  };

  const handleScanCamera = async () => {
    if (Capacitor.isNativePlatform()) {
      try {
        const photo = await CapCamera.getPhoto({
          quality: 90,
          allowEditing: false,
          resultType: CameraResultType.Base64,
          source: CameraSource.Camera,
        });
        if (photo.base64String) {
          setIsUploading(true);
          try {
            const dataUrl = `data:image/${photo.format || 'jpeg'};base64,${photo.base64String}`;
            const draft = await createReceiptDraft(dataUrl, profile.displayName || 'Host');
            setPendingReceiptDraft({ ...draft.receipt, imageQuality: draft.imageQuality, _previewImages: draft.previewImages });
            setPendingScanId(draft.scanId);
            setPendingRecoveryToken(draft.recoveryToken);
            setShowManualModal(true);
          } catch (err: any) {
            console.error(err);
            alert(err?.message || receiptScanUserMessage(t));
          } finally {
            setIsUploading(false);
          }
          return;
        }
      } catch (e) {
        console.warn('Native camera cancelled or failed:', e);
        return;
      }
    }
    const hasMediaDevices = typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
    if (hasMediaDevices) {
      setShowCamera(true);
      return;
    }
    if (cameraInputRef.current) {
      cameraInputRef.current.click();
      return;
    }
    setShowCamera(true);
  };

  const [nameInput, setNameInput] = useState(profile.displayName || '');
  const [phoneInput, setPhoneInput] = useState(profile.phoneNumber || '');
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    setNameInput(profile.displayName || '');
    setPhoneInput(profile.phoneNumber || '');
  }, [profile]);

  useEffect(() => {
    const lastSession = localStorage.getItem('billsplit_active_session');
    if (lastSession) {
      try {
        const parsed = JSON.parse(lastSession);
        fetch(apiUrl(`/api/session/${parsed.id}`), { headers: roomHeaders('session', parsed.id, false) })
          .then(async (res) => ({ status: res.status, data: await res.json().catch(() => ({})) }))
          .then(({ status, data }) => {
            if (data && data.session && data.session.status !== 'settled' && !data.session.groupId) {
              setActiveSession(parsed);
            } else {
              if (status === 404) purgeDeletedSessionFromStorage(localStorage, parsed.id);
              else localStorage.removeItem('billsplit_active_session');
              setActiveSession(null);
            }
          })
          .catch(() => {
            setActiveSession(parsed);
          });
      } catch (e) {
        localStorage.removeItem('billsplit_active_session');
      }
    }

    if (!profile.displayName) {
      setUserGroups([]);
      setHistoryList([]);
      return;
    }

    const rawName = profile.displayName.trim();
    const userKey = rawName.toLowerCase();
    const userGroupsKey = `billsplit_user_groups_${userKey}`;

    // Load local groups immediately (user-specific with global fallback)
    const savedGroups = localStorage.getItem(userGroupsKey) 
      || localStorage.getItem(`billsplit_user_groups_${rawName}`)
      || localStorage.getItem('billsplit_user_groups')
      || getCookie('billsplit_user_groups');
    if (savedGroups) {
      try {
        const parsed = typeof savedGroups === 'string' ? JSON.parse(savedGroups) : savedGroups;
        if (Array.isArray(parsed)) {
          const localDeleted = localStorage.getItem('billsplit_deleted_group_ids');
          const deletedIds = localDeleted ? JSON.parse(localDeleted) : [];
          setUserGroups(parsed.filter((g: any) => !deletedIds.includes(g.id)));
        }
      } catch (e) {}
    } else {
      setUserGroups([]);
    }

    // Load local history immediately (user-specific with fallback)
    const rawLocalHist = localStorage.getItem(`billsplit_history_${userKey}`)
      || localStorage.getItem(`billsplit_history_${rawName}`)
      || localStorage.getItem('billsplit_history');
    if (rawLocalHist) {
      try {
        const parsed = JSON.parse(rawLocalHist);
        if (Array.isArray(parsed)) {
          const localDeleted = localStorage.getItem('billsplit_deleted_history_ids');
          const deletedIds = localDeleted ? JSON.parse(localDeleted) : [];
          setHistoryList(parsed.filter((item: any) => !deletedIds.includes(item.id)));
        }
      } catch (e) {}
    }

    const queryParams = new URLSearchParams({
      userName: rawName,
      phone: profile.phoneNumber || ''
    }).toString();

    // Fetch user-specific active groups from server
    fetchPaginatedAccountData('/api/user/groups', queryParams, 'groups')
      .then((groups) => {
        if (Array.isArray(groups)) {
          const localDeleted = localStorage.getItem('billsplit_deleted_group_ids');
          const deletedIds = localDeleted ? JSON.parse(localDeleted) : [];
          const filtered = groups.filter((g: any) => !deletedIds.includes(g.id));
          setUserGroups((prev) => {
            // A successful account response is authoritative for known account records,
            // while merging local active joined groups ensures guests and new joins are preserved.
            const rawSaved = localStorage.getItem(userGroupsKey)
              || localStorage.getItem(`billsplit_user_groups_${rawName}`)
              || localStorage.getItem('billsplit_user_groups')
              || getCookie('billsplit_user_groups');
            let localSavedList: any[] = [];
            try {
              localSavedList = rawSaved ? (typeof rawSaved === 'string' ? JSON.parse(rawSaved) : rawSaved) : [];
            } catch (_) {}
            const activeLocalList = Array.isArray(localSavedList) ? localSavedList : [];

            const combinedMap = new Map<string, any>();
            // Add server groups first
            filtered.forEach((g: any) => {
              if (g?.id && !deletedIds.includes(g.id)) combinedMap.set(g.id, g);
            });
            // Merge in local active groups so unauthenticated or guest joined groups are preserved
            [...(Array.isArray(prev) ? prev : []), ...activeLocalList].forEach((g: any) => {
              if (g?.id && !deletedIds.includes(g.id) && !combinedMap.has(g.id)) {
                combinedMap.set(g.id, g);
              }
            });
            const merged = Array.from(combinedMap.values());
            localStorage.setItem(userGroupsKey, JSON.stringify(merged));
            localStorage.setItem(`billsplit_user_groups_${rawName}`, JSON.stringify(merged));
            localStorage.setItem('billsplit_user_groups', JSON.stringify(merged));
            setCookie('billsplit_user_groups', merged);
            return merged;
          });
        }
      })
      .catch(() => {});

    // Fetch user-specific history from server and merge with local history
    fetchPaginatedAccountData('/api/history', queryParams, 'history')
      .then((serverHistory) => {
        const localDeleted = localStorage.getItem('billsplit_deleted_history_ids');
        const deletedIds = localDeleted ? JSON.parse(localDeleted) : [];

        // Once the authenticated account response succeeds, Firestore is the
        // authority. Local-only entries are used only in the guest/offline
        // catch path, otherwise a remotely deleted session can resurrect.
        const mergedList = Array.isArray(serverHistory) ? [...serverHistory] : [];

        const filtered = mergedList
          .filter((item: any) => !deletedIds.includes(item.id))
          .sort((first: any, second: any) => {
            const firstTime = Number(first.settledAt || first.createdAt || (first.date ? new Date(first.date).getTime() : 0));
            const secondTime = Number(second.settledAt || second.createdAt || (second.date ? new Date(second.date).getTime() : 0));
            return secondTime - firstTime || String(first.id || '').localeCompare(String(second.id || ''));
          });
        setHistoryList(filtered);
        localStorage.setItem(`billsplit_history_${userKey}`, JSON.stringify(filtered));
        localStorage.setItem('billsplit_history', JSON.stringify(filtered));
      })
      .catch(() => {
        const rawLocal = localStorage.getItem(`billsplit_history_${userKey}`)
          || localStorage.getItem(`billsplit_history_${rawName}`)
          || localStorage.getItem('billsplit_history');
        if (rawLocal) {
          try {
            const localDeleted = localStorage.getItem('billsplit_deleted_history_ids');
            const deletedIds = localDeleted ? JSON.parse(localDeleted) : [];
            const parsed = JSON.parse(rawLocal);
            const filtered = parsed.filter((item: any) => !deletedIds.includes(item.id));
            setHistoryList(filtered);
          } catch (e) {}
        }
      });

    const applyGuestCacheConvergence = () => {
      void convergeGuestRoomCaches(localStorage)
        .then(({
          deletedSessions,
          deletedGroups,
          closedGroups: newlyClosedGroups,
          settledSessions,
          reopenedSessions,
        }) => {
          if (deletedSessions.length) {
            const deleted = new Set(deletedSessions);
            setHistoryList((current) => current.filter((entry: any) => !deleted.has(entry.id)));
            setActiveSession((current: any) => (current?.id && deleted.has(current.id) ? null : current));
          }
          if (deletedGroups.length) {
            const deleted = new Set(deletedGroups);
            setUserGroups((current) => current.filter((entry: any) => !deleted.has(entry.id)));
            setClosedGroups((current) => current.filter((entry: any) => !deleted.has(entry.id)));
            setHistoryList((current) => current.filter((entry: any) => !deleted.has(entry.groupId)));
          }
          if (newlyClosedGroups.length) {
            const closedIds = new Set(newlyClosedGroups.map((entry: any) => entry.id));
            setUserGroups((current) => current.filter((entry: any) => !closedIds.has(entry.id)));
            setClosedGroups((current) => [
              ...newlyClosedGroups,
              ...current.filter((entry: any) => !closedIds.has(entry.id)),
            ]);
          }
          if (settledSessions.length) {
            const settled = new Set(settledSessions);
            setActiveSession((current: any) => (current?.id && settled.has(current.id) ? null : current));
          }
          if (reopenedSessions.length) {
            const reopened = new Set(reopenedSessions);
            setHistoryList((current) => current.filter((entry: any) => !reopened.has(entry.id)));
          }
        })
        .catch(() => {});
    };
    applyGuestCacheConvergence();
    const convergenceInterval = window.setInterval(applyGuestCacheConvergence, 15_000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') applyGuestCacheConvergence();
    };
    window.addEventListener('online', applyGuestCacheConvergence);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(convergenceInterval);
      window.removeEventListener('online', applyGuestCacheConvergence);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [profile.displayName]);


  useEffect(() => {
    if (activeTab !== 'history') return;
    if (!profile.displayName) {
      setClosedGroups([]);
      return;
    }

    const userKey = profile.displayName.trim().toLowerCase();
    const localClosedRaw = localStorage.getItem(`billsplit_closed_groups_${userKey}`)
      || localStorage.getItem('billsplit_closed_groups');
    if (localClosedRaw) {
      try {
        const localClosed = JSON.parse(localClosedRaw);
        const deletedIds = JSON.parse(localStorage.getItem('billsplit_deleted_group_ids') || '[]');
        if (Array.isArray(localClosed)) setClosedGroups(localClosed.filter((group: any) => !deletedIds.includes(group.id)));
      } catch (_) {}
    }

    const queryParams = new URLSearchParams({
      userName: profile.displayName.trim(),
      phone: profile.phoneNumber || '',
      scope: 'closed',
    }).toString();

    fetchPaginatedAccountData('/api/user/groups', queryParams, 'groups')
      .then((groups) => setClosedGroups(Array.isArray(groups) ? groups : []))
      .catch(() => {});
  }, [activeTab, profile.displayName, profile.phoneNumber]);

  const currentMonthName = useMemo(() => {
    return new Date().toLocaleString(language === 'he' ? 'he-IL' : 'en-US', { month: 'long' });
  }, [language]);

  const financialStats = useMemo(() => {
    let totalSpent = 0;
    const categories: Record<string, { amount: number; count: number; icon: any; color: string; stroke: string; label: string }> = {
      Food: { amount: 0, count: 0, icon: Utensils, color: 'bg-orange-500', stroke: '#F97316', label: t('categoryFood', undefined, isRtl ? 'אוכל ומסעדות 🍕' : 'Food & Dining 🍕') },
      Coffee: { amount: 0, count: 0, icon: Coffee, color: 'bg-amber-600', stroke: '#D97706', label: t('categoryCoffee', undefined, isRtl ? 'קפה ומשקאות ☕' : 'Coffee & Drinks ☕') },
      Groceries: { amount: 0, count: 0, icon: Box, color: 'bg-emerald-500', stroke: '#10B981', label: t('categoryGroceries', undefined, isRtl ? 'סופר וקניות 🛒' : 'Groceries 🛒') },
      Travel: { amount: 0, count: 0, icon: Plane, color: 'bg-cyan-500', stroke: '#06B6D4', label: t('categoryTravel', undefined, isRtl ? 'טיולים וחופשות ✈️' : 'Travel & Trips ✈️') },
      Other: { amount: 0, count: 0, icon: Sparkles, color: 'bg-brand-500', stroke: '#5B52D6', label: t('categoryOther', undefined, isRtl ? 'כללי / אחר 🏷️' : 'General / Other 🏷️') },
    };

    historyList.forEach((item: any) => {
      const shareVal = item.userShare !== undefined ? item.userShare : item.totalAmount;
      const amount = typeof shareVal === 'number' ? shareVal : parseFloat(shareVal) || 0;
      totalSpent += amount;

      const titleLower = (item.storeName || item.title || '').toLowerCase();
      const explicitCat = (item.category || '').toLowerCase();

      if (explicitCat === 'coffee' || explicitCat.includes('coffee') || explicitCat.includes('drink') || explicitCat.includes('קפה') || titleLower.includes('cafe') || titleLower.includes('coffee') || titleLower.includes('starbucks') || titleLower.includes('קפה') || titleLower.includes('aroma') || titleLower.includes('drinks') || titleLower.includes('juice') || titleLower.includes('מיץ') || titleLower.includes('tea') || titleLower.includes('תה')) {
        categories.Coffee.amount += amount;
        categories.Coffee.count += 1;
      } else if (explicitCat === 'food' || explicitCat.includes('food') || explicitCat.includes('dining') || explicitCat.includes('restaurant') || explicitCat.includes('אוכל') || explicitCat.includes('מסעד') || titleLower.includes('pizza') || titleLower.includes('burger') || titleLower.includes('sushi') || titleLower.includes('restaurant') || titleLower.includes('food') || titleLower.includes('dinner') || titleLower.includes('bar') || titleLower.includes('מסעדה') || titleLower.includes('פאב') || titleLower.includes('בשר') || titleLower.includes('גריל') || titleLower.includes('שניצל') || titleLower.includes('שווארמה') || titleLower.includes('פלאפל') || titleLower.includes('פסטה')) {
        categories.Food.amount += amount;
        categories.Food.count += 1;
      } else if (explicitCat === 'groceries' || explicitCat.includes('grocer') || explicitCat.includes('סופר') || titleLower.includes('super') || titleLower.includes('market') || titleLower.includes('grocer') || titleLower.includes('shufersal') || titleLower.includes('rami levy') || titleLower.includes('סופר') || titleLower.includes('שופרסל') || titleLower.includes('יוחננוף') || titleLower.includes('מכולת') || titleLower.includes('ויקטורי')) {
        categories.Groceries.amount += amount;
        categories.Groceries.count += 1;
      } else if (explicitCat === 'travel' || explicitCat.includes('travel') || explicitCat.includes('trip') || explicitCat.includes('flight') || explicitCat.includes('מלון') || explicitCat.includes('טיול') || titleLower.includes('hotel') || titleLower.includes('airbnb') || titleLower.includes('trip') || titleLower.includes('flight') || titleLower.includes('booking') || titleLower.includes('vacation') || titleLower.includes('uber') || titleLower.includes('taxi') || titleLower.includes('train') || titleLower.includes('מונית') || titleLower.includes('רכבת') || titleLower.includes('gas') || titleLower.includes('דלק') || titleLower.includes('טיסה')) {
        categories.Travel.amount += amount;
        categories.Travel.count += 1;
      } else {
        categories.Other.amount += amount;
        categories.Other.count += 1;
      }
    });

    return {
      totalSpent,
      categories,
      splitsCount: historyList.length,
      groupsCount: userGroups.length
    };
  }, [historyList, userGroups, t, isRtl]);

  const handleClearActiveSession = async () => {
    const sessionId = activeSession?.id;
    if (activeSession?.isHost && sessionId) {
      try {
        const response = await fetch(apiUrl(`/api/session/${encodeURIComponent(sessionId)}`), {
          method: 'DELETE',
          headers: roomHeaders('session', sessionId, false),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not delete the session');
        purgeDeletedSessionFromStorage(localStorage, sessionId);
      } catch (error) {
        alert(error instanceof Error ? error.message : 'Could not delete the session');
        return false;
      }
    } else if (sessionId) {
      // Leaving a live room locally must revoke every ID/code alias without
      // hiding a future settled history entry for this participant.
      purgeRoomCredentialsFromStorage(localStorage, 'session', sessionId);
    }
    localStorage.removeItem('billsplit_active_session');
    setActiveSession(null);
    return true;
  };

  const handleReenterActiveSession = () => {
    if (!activeSession) return;
    router.push(`/session/${activeSession.id}`);
  };

  const handleOpenActiveSessionQr = async () => {
    if (!activeSession?.id) return;
    try {
      const response = await fetch(apiUrl(`/api/session/${activeSession.id}/refresh-invite`), {
        method: 'POST',
        headers: roomHeaders('session', activeSession.id),
        body: JSON.stringify({
          inviteToken: getSessionInviteToken(activeSession.id) || activeSession.inviteToken || '',
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.code) throw new Error(data.error || 'Could not refresh the session invitation');
      if (data.inviteToken) saveSessionInviteToken(activeSession.id, data.inviteToken);
      else clearSessionInviteToken(activeSession.id);
      const refreshed = {
        ...activeSession,
        code: data.code,
        inviteToken: data.inviteToken || undefined,
      };
      setActiveSession(refreshed);
      localStorage.setItem('billsplit_active_session', JSON.stringify(refreshed));
      setShowQrModal(true);
    } catch (error) {
      console.error('Could not refresh the active session invitation:', error);
      alert(error instanceof Error ? error.message : 'Could not refresh the session invitation');
    }
  };

  const handleUniversalJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = universalJoinCode.trim();
    if (!/^(?:\d{4}|\d{5}|\d{8})$/.test(code)) return;

    setIsUploading(true);
    if (code.length === 8 || code.length === 4) {
      try {
        // Code length routes new invites without doubling NAT rate-limit usage;
        // four digits remain a legacy-only group-first fallback.
        const grpRes = await fetch(apiUrl(`/api/groups/${code}`), {
          headers: { 'X-EasySplit-Client-Id': getOrCreateRoomClientId() },
        });
        const grpData = await grpRes.json();
        if (grpData.group) {
          saveGroupToLocalList({
            id: grpData.group.id,
            code: grpData.group.code,
            name: grpData.group.name
          });
          triggerHaptic('success');
          router.push(`/group/${grpData.group.id}`);
          return;
        }
      } catch (err) {
        // legacy fallback and continue
      }
    }

    if (code.length === 5 || code.length === 4 || code.length === 8) {
      try {
        // Eight digits are a session fallback only for legacy rooms created
        // before five-digit session codes shipped.
        const sessRes = await fetch(apiUrl(`/api/session/${code}`), {
          headers: { 'X-EasySplit-Client-Id': getOrCreateRoomClientId() },
        });
        const sessData = await sessRes.json();
        if (sessData.session) {
          localStorage.setItem(
            'billsplit_active_session',
            JSON.stringify({
              id: sessData.session.id,
              code: sessData.session.code,
              storeName: sessData.session.storeName,
              isHost: false
            })
          );
          triggerHaptic('success');
          router.push(`/session/${sessData.session.id}?code=${encodeURIComponent(code)}`);
          return;
        }
      } catch (err) {
        // ignore
      } finally {
        setIsUploading(false);
      }
    } else {
      setIsUploading(false);
    }

    triggerHaptic('warning');
    alert(t('codeNotFound', undefined, 'Code not found. Please check the room code.'));
  };

  const handleScanComplete = (scanResult: any) => {
    setShowCamera(false);
    if (scanResult.receipt?.items?.length) {
      setPendingReceiptDraft(scanResult.receipt);
      setPendingScanId(scanResult.scanId || '');
      setPendingRecoveryToken(scanResult.recoveryToken || '');
      setShowManualModal(true);
    }
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const draft = await createReceiptDraft(file, profile.displayName || 'Host');
      setPendingReceiptDraft({ ...draft.receipt, imageQuality: draft.imageQuality, _previewImages: draft.previewImages });
      setPendingScanId(draft.scanId);
      setPendingRecoveryToken(draft.recoveryToken);
      setShowManualModal(true);
    } catch (err: any) {
      console.error(err);
      alert(err?.message || receiptScanUserMessage(t));
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (cameraInputRef.current) cameraInputRef.current.value = '';
    }
  };

  const launchManualSession = async (
    billData: { storeName: string; restaurant?: Record<string, unknown>; date?: string; currency: string; items: any[] },
  ): Promise<boolean> => {
    try {
      const receiptDraft = pendingReceiptDraft;
      const scanId = pendingScanId;
      const recoveryToken = pendingRecoveryToken;
      const res = await fetch(apiUrl('/api/receipt/scan'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parsedBill: {
            ...receiptConfirmationPayload(receiptDraft),
            ...billData,
          },
          hostName: profile.displayName || 'Host',
          hostPhone: profile.phoneNumber || '',
          clientId: getOrCreateRoomClientId(),
          scanId: scanId || undefined,
          recoveryToken: recoveryToken || undefined,
          confirmedByUser: true,
          imageQuality: receiptDraft?.imageQuality || undefined,
        })
      });

      const data = await res.json();
      if (data.success && data.sessionId) {
        saveRoomCredentials('session', data.sessionId, data.memberId || data.hostId, data.accessToken);
        if (data.inviteToken) saveSessionInviteToken(data.sessionId, data.inviteToken);
        localStorage.setItem(
          'billsplit_active_session',
          JSON.stringify({
            id: data.sessionId,
            code: data.code,
            storeName: data.session?.storeName || billData.storeName,
            isHost: true,
            hostId: data.hostId,
            inviteToken: data.inviteToken || undefined,
          })
        );
        setShowManualModal(false);
        setPendingReceiptDraft(null);
        setPendingScanId('');
        setPendingRecoveryToken('');
        router.push(`/session/${data.sessionId}`);
        return true;
      } else {
        alert(data.error || 'Failed to create manual session.');
        return false;
      }
    } catch (err) {
      console.error(err);
      alert('Error creating manual session.');
      return false;
    }
  };

  const handleLaunchManualSession = async (billData: { storeName: string; restaurant?: Record<string, unknown>; date?: string; currency: string; items: any[] }) => {
    await launchManualSession(billData);
  };

  const saveGroupToLocalList = (newGroup: any) => {
    setUserGroups((prev) => {
      const exists = prev.some((g) => g.id === newGroup.id);
      const updated = exists
        ? prev.map((g) => (g.id === newGroup.id ? { ...g, ...newGroup } : g))
        : [{ id: newGroup.id, code: newGroup.code, name: newGroup.name, membersCount: newGroup.membersCount || 1 }, ...prev];
      const rawName = (profile.displayName || '').trim();
      const userKey = rawName.toLowerCase();
      if (rawName) {
        localStorage.setItem(`billsplit_user_groups_${rawName}`, JSON.stringify(updated));
      }
      if (userKey) {
        localStorage.setItem(`billsplit_user_groups_${userKey}`, JSON.stringify(updated));
      }
      localStorage.setItem('billsplit_user_groups', JSON.stringify(updated));
      setCookie('billsplit_user_groups', updated);
      return updated;
    });
  };

  const createGroup = async (
    groupData: { name: string; currency: string },
  ): Promise<boolean> => {
    try {
      setIsUploading(true);
      const res = await fetch(apiUrl('/api/groups'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: groupData.name,
          currency: groupData.currency,
          hostName: profile.displayName || 'Host',
          hostPhone: profile.phoneNumber || '',
          clientId: getOrCreateRoomClientId(),
        })
      });

      const data = await res.json();
      if (data.success && data.groupId) {
        saveRoomCredentials('group', data.groupId, data.memberId || data.hostId, data.accessToken);
        saveGroupToLocalList({
          id: data.groupId,
          code: data.code,
          name: groupData.name
        });
        setShowCreateGroupModal(false);
        router.push(`/group/${data.groupId}`);
        return true;
      } else {
        alert(data.error || 'Failed to create group.');
        return false;
      }
    } catch (err) {
      console.error(err);
      alert('Error creating group.');
      return false;
    } finally {
      setIsUploading(false);
    }
  };

  const handleCreateGroup = async (groupData: { name: string; currency: string }) => {
    await createGroup(groupData);
  };



  const handleDeleteHistory = async (id: string) => {
    try {
      const response = await fetch(apiUrl(`/api/history/${id}`), { method: 'DELETE' });
      if (!response.ok && response.status !== 401) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Could not remove history item');
      }
      const localDeleted = localStorage.getItem('billsplit_deleted_history_ids');
      const deletedIds = localDeleted ? JSON.parse(localDeleted) : [];
      if (!deletedIds.includes(id)) {
        deletedIds.push(id);
        localStorage.setItem('billsplit_deleted_history_ids', JSON.stringify(deletedIds));
      }
      setHistoryList((prev) => prev.filter((item) => item.id !== id));
      return true;
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Could not remove history item');
      return false;
    }
  };

  const handleDeleteClosedGroup = async (groupId: string) => {
    try {
      const res = await fetch(apiUrl(`/api/user/groups/${groupId}/history`), {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 401) throw new Error(data.error || 'Could not remove group history');
      setClosedGroups((groups) => groups.filter((candidate) => candidate.id !== groupId));
      purgeDeletedGroupFromStorage(localStorage, groupId);
      return true;
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not remove group history');
      return false;
    }
  };

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = nameInput.trim() || 'User';
    const finalPhone = cleanIsraeliPhone(phoneInput.trim());
    if (!isValidIsraeliPhone(finalPhone)) {
      alert(isRtl ? 'יש להזין מספר נייד ישראלי תקין.' : 'Please enter a valid Israeli mobile number.');
      return;
    }

    setProfile((prev) => ({
      ...prev,
      displayName: finalName,
      phoneNumber: finalPhone,
    }));

    if (finalPhone) {
      localStorage.setItem('billsplit_phone', finalPhone);
    } else {
      localStorage.removeItem('billsplit_phone');
    }

    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2000);
  };

  const handleSignOutClick = async () => {
    try {
      await logout();
      triggerHaptic('medium');
    } catch (err) {
      console.error('Sign-Out error:', err);
    }
  };

  const userInitials = (profile.displayName || 'User').substring(0, 2).toUpperCase();

  // Tab index calculation for LTR / RTL slider
  const activeTabIndex = activeTab === 'history' ? 0 : activeTab === 'sessions' ? 1 : 2;

  return (
    <div className="app-surface flex flex-col h-full min-h-0 flex-1 transition-colors duration-300 dark:text-white">
      {/* OCR Animated Progress Screen */}
      <OCRProgressOverlay isVisible={isUploading} />

      {/* Hidden File Input */}
      <input
        type="file"
        ref={fileInputRef}
        accept="image/*"
        onChange={handlePhotoUpload}
        className="hidden"
      />

      {/* Camera Viewfinder Modal */}
      {showCamera && (
        <CameraViewfinder
          onScanComplete={handleScanComplete}
          onCancel={() => setShowCamera(false)}
          onManualEntry={() => {
            setShowCamera(false);
            setPendingReceiptDraft(null);
            setPendingScanId('');
            setPendingRecoveryToken('');
            setShowManualModal(true);
          }}
          hostName={profile.displayName || 'Host'}
        />
      )}

      {/* QR Code Modal */}
      {showQrModal && activeSession && (
        <QRCodeModal
          isOpen={showQrModal}
          onClose={() => setShowQrModal(false)}
          sessionCode={activeSession.code}
          sessionId={activeSession.id}
          inviteToken={activeSession.inviteToken || ''}
        />
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-6 px-4 pt-4 pb-4">
        {/* TAB 2: SESSIONS (Middle tab) */}
        {activeTab === 'sessions' && (
          <div className="space-y-6 animate-fadeIn">
            {/* Brand header */}
            <header className="flex items-center justify-between pt-7 sm:pt-8 pb-2 mb-1">
              <h1 className="text-[29px] sm:text-[33px] leading-none text-left rtl:text-right">
                <EasySplitWordmark />
              </h1>

              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                  className="brand-tap w-10 h-10 rounded-full bg-white/90 dark:bg-brand-900 border border-brand-100 dark:border-brand-800 shadow-sm flex items-center justify-center text-brand-800 dark:text-brand-100 hover:bg-brand-50 dark:hover:bg-brand-800 transition-colors"
                  title="Toggle Light/Dark Theme"
                >
                  {theme === 'dark' ? <Sun className="w-4 h-4 text-peach-300" /> : <Moon className="w-4 h-4 text-brand-700" />}
                </button>

                {/* Avatar Profile Image / Icon Button */}
                <button
                  onClick={() => {
                    setActiveTab('settings');
                    triggerHaptic('light');
                  }}
                  className="brand-tap relative w-11 h-11 sm:w-12 sm:h-12 rounded-full p-0.5 bg-brand-50 dark:bg-brand-900 border-2 border-brand-100 dark:border-brand-800 overflow-hidden shadow-xs hover:scale-105 transition-all focus:outline-none shrink-0 flex items-center justify-center"
                  title={profile.displayName || 'User'}
                >
                  {profile.avatarUrl && !profile.avatarUrl.includes('unsplash') ? (
                    <img
                      src={profile.avatarUrl}
                      alt={profile.displayName || 'User Avatar'}
                      className="w-full h-full rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full rounded-full bg-brand-100 dark:bg-brand-800 flex items-center justify-center text-brand-700 dark:text-brand-100">
                      <User className="w-5 h-5 sm:w-6 sm:h-6" />
                    </div>
                  )}
                </button>
              </div>
            </header>

            {/* Compact Swipe-To-Delete Active Session Card */}
            {activeSession && (
              <SwipeableCard
                onDelete={handleClearActiveSession}
                confirmationTitle={isRtl ? 'למחוק את הסשן החי?' : 'Delete the live session?'}
                confirmationDescription={activeSession.isHost
                  ? (isRtl ? 'הסשן יימחק מיד לכל המשתתפים.' : 'The session will be deleted immediately for everyone.')
                  : (isRtl ? 'הסשן יוסר רק מהמכשיר שלך.' : 'The session will only be removed from this device.')}
              >
                <div className="brand-card p-3.5 rounded-[20px] space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-mint-500 animate-pulse" />
                      <LockOpen className="w-3.5 h-3.5 text-brand-600 dark:text-brand-300" />
                      <span className="text-[10px] font-black uppercase tracking-wider text-brand-900 dark:text-white">
                        {t('activeSplitTitle', undefined, 'Active Split')}
                      </span>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleOpenActiveSessionQr();
                      }}
                      className="brand-tap p-1.5 rounded-full bg-brand-50 dark:bg-brand-900 text-brand-700 dark:text-brand-200 hover:bg-brand-100"
                      title="Share QR Code"
                    >
                      <QrCode className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <h3 className="text-base font-bold text-brand-950 dark:text-white leading-tight">{activeSession.storeName}</h3>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">#{activeSession.code}</p>
                    </div>

                    <button
                      onClick={handleReenterActiveSession}
                      className="w-full py-3.5 px-5 photo-btn-dark text-sm flex items-center justify-center gap-2 shadow-md"
                    >
                      <Play className="w-4 h-4 fill-current" />
                      <span>{t('reenterActiveSession', undefined, 'Re-Enter Active Session')}</span>
                    </button>
                  </div>
                </div>
              </SwipeableCard>
            )}

            {/* Hidden Photo / Camera Inputs */}
            <input
              type="file"
              ref={cameraInputRef}
              accept="image/*"
              capture="environment"
              onChange={handlePhotoUpload}
              className="hidden"
            />

            {/* 3 Main Action Cards Layout */}
            <div className="grid grid-cols-2 gap-3.5 pt-1">
              {/* Left Column: Tall Purple Card (start split) */}
              <button
                type="button"
                data-testid="start-split-button"
                onClick={() => {
                  handleScanCamera();
                  triggerHaptic('medium');
                }}
                className="home-start-card brand-tap relative rounded-[24px] p-5 flex flex-col justify-between overflow-hidden cursor-pointer group min-h-[256px] select-none text-left rtl:text-right"
              >
                <div className="relative z-10 transition-transform duration-150 group-active:translate-y-px">
                  <PorcelainReceiptMark />
                </div>

                {/* Card Typography Content */}
                <div className="relative z-10 mt-auto pt-6">
                  <h2 className="text-xl sm:text-2xl font-black text-white leading-tight tracking-tight whitespace-nowrap">
                    {t('startSplitCard', undefined, 'Split a bill')}
                  </h2>
                  <p className="text-xs font-medium text-white/80 mt-1.5 leading-tight">
                    {t('letTryItNow', undefined, 'Scan or upload a receipt')}
                  </p>
                </div>
              </button>

              {/* Right Column: 2 Stacked Action Cards */}
              <div className="flex flex-col gap-3.5">
                {/* Top Card: Join by code (Matching Pic 1) */}
                <button
                  type="button"
                  onClick={() => {
                    setShowJoinSessionModal(true);
                    triggerHaptic('light');
                  }}
                  className="home-secondary-action brand-tap relative rounded-[22px] bg-white dark:bg-brand-900 p-4 flex flex-col justify-between overflow-hidden border border-slate-200/80 dark:border-brand-800 shadow-[0_8px_20px_-18px_rgba(37,33,111,0.28)] transition-all duration-150 cursor-pointer group flex-1 min-h-[120px] select-none text-left rtl:text-right"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-brand-50 dark:bg-brand-800/70 border border-brand-100 dark:border-brand-700 flex items-center justify-center text-brand-700 dark:text-brand-200 shrink-0 transition-transform duration-150 group-active:translate-y-px">
                      <QrCode className="w-5 h-5" />
                    </div>
                    <h3 className="text-sm sm:text-base font-extrabold text-slate-900 dark:text-white leading-tight">
                      {t('joinSessionViaCode', undefined, 'Join by code')}
                    </h3>
                  </div>

                  <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 mt-2 font-normal leading-relaxed whitespace-nowrap truncate">
                    {t('joinSessionSubtitle', undefined, 'join friends session')}
                  </p>
                </button>

                {/* Bottom Card: Create a group */}
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateGroupModal(true);
                    triggerHaptic('light');
                  }}
                  className="home-secondary-action brand-tap relative rounded-[22px] bg-white dark:bg-brand-900 p-4 flex flex-col justify-between overflow-hidden border border-slate-200/80 dark:border-brand-800 shadow-[0_8px_20px_-18px_rgba(37,33,111,0.28)] transition-all duration-150 cursor-pointer group flex-1 min-h-[120px] select-none text-left rtl:text-right"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-peach-50 dark:bg-peach-700/15 border border-peach-100 dark:border-peach-700/30 flex items-center justify-center text-peach-700 dark:text-peach-300 shrink-0 transition-transform duration-150 group-active:translate-y-px">
                      <Users className="w-5 h-5" />
                    </div>
                    <h3 className="text-sm sm:text-base font-extrabold text-slate-900 dark:text-white leading-tight">
                      {t('createAGroupCard', undefined, 'Shared budget')}
                    </h3>
                  </div>

                  <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 mt-2 font-normal leading-relaxed whitespace-nowrap truncate">
                    {t('createGroupSubtitle', undefined, 'start a group with friends')}
                  </p>
                </button>
              </div>
            </div>

            {/* YOUR ACTIVE GROUPS LIST (Real user-joined groups only) */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  {t('yourActiveGroupsHeader', undefined, 'Your active groups')}
                </h3>
              </div>

              {userGroups.length === 0 ? (
                <button
                  type="button"
                  onClick={() => setShowCreateGroupModal(true)}
                  className="brand-tap w-full p-5 sm:p-6 rounded-3xl brand-card border-dashed text-center space-y-3 cursor-pointer hover:bg-brand-50/70 dark:hover:bg-brand-900 transition-all group shadow-xs"
                >
                  <div className="flex items-center justify-center py-1 group-hover:scale-105 transition-transform duration-300">
                    <SleepingPandaIllustration className="w-44 h-28" />
                  </div>
                  <p className="text-sm font-bold text-slate-800 dark:text-slate-200">
                    {t('noActiveGroupsYet', undefined, 'No active groups yet')}
                  </p>
                  <p className="text-xs text-slate-400 dark:text-slate-400 max-w-xs mx-auto">
                    {t('createOrJoinGroupPrompt', undefined, 'Create a group or join via code to split bills together')}
                  </p>
                </button>
              ) : (
                <div className="space-y-2.5">
                  {userGroups.map((g: any, idx: number) => {
                    const GroupIcon = g.icon || (idx % 2 === 0 ? Utensils : Users);

                    // Distinctive Colorful Badge Palette
                    const GROUP_COLOR_PALETTES = [
                      { bg: 'bg-orange-500/15 dark:bg-orange-500/25', text: 'text-orange-600 dark:text-orange-400', border: 'border-orange-500/30' },
                      { bg: 'bg-brand-500/15 dark:bg-brand-500/25', text: 'text-brand-600 dark:text-brand-400', border: 'border-brand-500/30' },
                      { bg: 'bg-pink-500/15 dark:bg-pink-500/25', text: 'text-pink-600 dark:text-pink-400', border: 'border-pink-500/30' },
                      { bg: 'bg-sky-500/15 dark:bg-sky-500/25', text: 'text-sky-600 dark:text-sky-400', border: 'border-sky-500/30' },
                      { bg: 'bg-purple-500/15 dark:bg-purple-500/25', text: 'text-purple-600 dark:text-purple-400', border: 'border-purple-500/30' },
                      { bg: 'bg-amber-500/15 dark:bg-amber-500/25', text: 'text-amber-600 dark:text-amber-400', border: 'border-amber-500/30' },
                      { bg: 'bg-teal-500/15 dark:bg-teal-500/25', text: 'text-teal-600 dark:text-teal-400', border: 'border-teal-500/30' },
                      { bg: 'bg-rose-500/15 dark:bg-rose-500/25', text: 'text-rose-600 dark:text-rose-400', border: 'border-rose-500/30' },
                    ];
                    const colorPalette = GROUP_COLOR_PALETTES[idx % GROUP_COLOR_PALETTES.length];

                    return (
                      <div
                        key={g.id}
                        onClick={() => router.push(`/group/${g.id}`)}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            router.push(`/group/${g.id}`);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        className="brand-tap p-3.5 rounded-2xl brand-card flex items-center justify-between hover:bg-brand-50 dark:hover:bg-brand-900 transition-all cursor-pointer shadow-xs group"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-11 h-11 rounded-full ${colorPalette.bg} flex items-center justify-center shrink-0 border ${colorPalette.border} group-hover:scale-110 group-active:scale-95 transition-all shadow-xs`}>
                            <GroupIcon className={`w-5 h-5 ${colorPalette.text}`} />
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <h4 className="font-extrabold text-sm text-slate-900 dark:text-white leading-tight truncate">
                                {g.name}
                              </h4>
                              {g.status === 'settling' && (
                                <span className="shrink-0 px-2 py-0.5 rounded-full bg-brand-50 dark:bg-brand-900 text-brand-700 dark:text-brand-200 border border-brand-100 dark:border-brand-800 text-[9px] font-black">
                                  {isRtl ? 'בסגירה' : 'Settling'}
                                </span>
                              )}
                            </div>
                            {g.billsCount !== undefined ? (() => {
                              const total = formatDual ? formatDual(Number(g.totalSpent || 0), g.currency || currency) : { primary: `${Number(g.totalSpent || 0).toFixed(2)} ${g.currency || currency}` };
                              return (
                                <p className="text-[10px] text-slate-500 dark:text-slate-400 font-semibold mt-1 truncate">
                                  {g.membersCount || 1} {isRtl ? 'משתתפים' : 'members'} · {g.billsCount || 0} {isRtl ? 'חלוקות' : 'splits'} · {total.primary}
                                </p>
                              );
                            })() : (
                              <p className="text-[10px] text-slate-500 dark:text-slate-400 font-semibold mt-1">
                                {g.membersCount || 1} {isRtl ? 'משתתפים' : 'members'}
                              </p>
                            )}
                            {g.status === 'settling' && Number(g.paymentsRemaining || 0) > 0 && (
                              <p className="text-[9px] text-brand-600 dark:text-brand-300 font-bold mt-0.5">
                                {Number(g.paymentsRemaining || 0)} {isRtl ? 'תשלומים נותרו' : 'payments left'}
                              </p>
                            )}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedGroupForModal(g);
                            setGroupModalTab('options');
                          }}
                          className="p-2 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                          title="Group options"
                        >
                          <span className="font-black text-sm tracking-widest leading-none">•••</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 1: HISTORY (Picture 2: Compact Financial Dashboard at Top with Pie/Donut Chart & Total Expenses, followed by Recent Bills) */}
        {activeTab === 'history' && (() => {
          const totalSpentDual = formatDual ? formatDual(financialStats.totalSpent, currency) : { primary: `${financialStats.totalSpent.toFixed(2)} ${currency}` };
          
          // Compact Donut SVG parameters
          const radius = 44;
          const circumference = 2 * Math.PI * radius; // ~276.46
          let accumulatedOffset = 0;

          // Non-zero categories
          const activeCategories = Object.entries(financialStats.categories).filter(([_, c]) => c.amount > 0);
          const hasSpending = financialStats.totalSpent > 0 && activeCategories.length > 0;

          return (
            <div className="space-y-5 animate-fadeIn pb-4">
              {/* Top Header for History Tab */}
              <header className="flex items-center justify-between pt-8 sm:pt-10 pb-3 mb-2">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-800 dark:text-brand-200">
                    <History className="h-5 w-5" />
                  </span>
                  <h1 className="font-rounded font-semibold text-2xl sm:text-[26px] text-slate-800 dark:text-slate-100 tracking-tight leading-tight">
                    {t('tabHistory', undefined, 'History')}
                  </h1>
                </div>

                <div className="flex items-center gap-2.5">
                  <button
                    onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                    className="w-10 h-10 rounded-full bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 shadow-sm flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                    title="Toggle Light/Dark Theme"
                  >
                    {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-700" />}
                  </button>
                </div>
              </header>

              {/* Financial Dashboard Card (Top) - Compact & Elegant with Centered Total Above Pie */}
              <div className="photo-card p-5 bg-white dark:bg-brand-900 border border-slate-200/80 dark:border-white/5 shadow-md shadow-slate-950/10 rounded-2xl space-y-3 flex flex-col items-center justify-center">
                {/* Header: Total expenses & Amount Centered Right Above Pie Graph */}
                <div className="text-center flex flex-col items-center justify-center pt-1">
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 block tracking-wide">
                    {t('totalExpenses', undefined, 'Total expenses')}
                  </span>
                  <div className="flex items-baseline justify-center gap-2 mt-1">
                    <span className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                      {totalSpentDual.primary}
                    </span>
                    {totalSpentDual.secondary && (
                      <span className="text-xs font-bold text-slate-400">
                        {totalSpentDual.secondary}
                      </span>
                    )}
                  </div>
                </div>

                {/* Donut Chart with Segmented Arcs & Center Label */}
                <div className="flex flex-col items-center justify-center pt-1">
                  <div className="relative w-36 h-36 flex items-center justify-center">
                    <svg className="w-full h-full -rotate-90" viewBox="0 0 110 110">
                      {/* Background track circle */}
                      <circle
                        cx="55"
                        cy="55"
                        r={radius}
                        fill="transparent"
                        stroke="currentColor"
                        className="text-slate-100 dark:text-slate-800/60"
                        strokeWidth="10"
                      />

                      {/* Dynamic Category Segments */}
                      {hasSpending ? (
                        activeCategories.map(([key, cat]) => {
                          const pct = (cat.amount / financialStats.totalSpent);
                          const strokeLen = Math.max(1, pct * circumference - (activeCategories.length > 1 ? 6 : 0));
                          const strokeDasharray = `${strokeLen} ${circumference - strokeLen}`;
                          const strokeDashoffset = -accumulatedOffset;
                          accumulatedOffset += pct * circumference;

                          return (
                            <circle
                              key={key}
                              cx="55"
                              cy="55"
                              r={radius}
                              fill="transparent"
                              stroke={cat.stroke}
                              strokeWidth="10"
                              strokeDasharray={strokeDasharray}
                              strokeDashoffset={strokeDashoffset}
                              strokeLinecap="round"
                              className="transition-all duration-500 ease-out"
                            />
                          );
                        })
                      ) : (
                        <circle
                          cx="55"
                          cy="55"
                          r={radius}
                          fill="transparent"
                          stroke="#10B981"
                          strokeWidth="10"
                          strokeDasharray="30 250"
                          strokeLinecap="round"
                          className="opacity-40"
                        />
                      )}
                    </svg>

                    {/* Center Text inside Donut */}
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center">
                      <span className="text-[9px] font-semibold text-slate-400 dark:text-slate-400">
                        {t('totalExpenses', undefined, 'Total expenses')}
                      </span>
                      <span className="text-xs font-black text-slate-900 dark:text-white capitalize mt-0.5">
                        {currentMonthName}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Category Breakdown Chips / Legend */}
                <div className="flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1.5 pt-1.5 border-t border-slate-100 dark:border-slate-800/80">
                  {Object.entries(financialStats.categories).map(([key, cat]) => {
                    const pct = financialStats.totalSpent > 0 ? Math.round((cat.amount / financialStats.totalSpent) * 100) : 0;
                    if (financialStats.totalSpent > 0 && cat.amount <= 0) return null;
                    return (
                      <div key={key} className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700 dark:text-slate-300">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${cat.color}`} />
                        <span>{cat.label}</span>
                        <span className="text-slate-400 dark:text-slate-500 font-mono text-[10px]">{pct}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>


              {closedGroups.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="font-extrabold text-base text-slate-900 dark:text-white">
                      {isRtl ? 'קבוצות שהסתיימו' : 'Closed groups'}
                    </h3>
                    <span className="text-[11px] font-extrabold text-slate-400">{closedGroups.length}</span>
                  </div>
                  <div className="space-y-2.5">
                    {closedGroups.map((closedGroup: any) => {
                      const total = formatDual ? formatDual(Number(closedGroup.totalSpent || 0), closedGroup.currency || currency) : { primary: `${Number(closedGroup.totalSpent || 0).toFixed(2)} ${closedGroup.currency || currency}` };
                      return (
                        <SwipeableCard
                          key={closedGroup.id}
                          onDelete={() => handleDeleteClosedGroup(closedGroup.id)}
                          confirmationTitle={isRtl ? 'להסיר מההיסטוריה?' : 'Remove from history?'}
                          confirmationDescription={isRtl ? 'הקבוצה תוסתר רק מההיסטוריה שלך.' : 'This group will be hidden only from your history.'}
                        >
                          <button
                            type="button"
                            onClick={() => router.push(`/group/${closedGroup.id}`)}
                            className="brand-tap w-full p-3.5 rounded-2xl brand-card flex items-center justify-between text-left rtl:text-right hover:bg-brand-50 dark:hover:bg-brand-900 transition-all shadow-xs"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="w-10 h-10 rounded-full bg-mint-500/10 text-mint-600 dark:text-mint-400 border border-mint-500/20 flex items-center justify-center shrink-0">
                                <Check className="w-4 h-4" />
                              </div>
                              <div className="min-w-0">
                                <h4 className="font-extrabold text-sm text-slate-900 dark:text-white truncate">{closedGroup.name}</h4>
                                <p className="text-[10px] text-slate-500 dark:text-slate-400 font-semibold mt-0.5">
                                  {closedGroup.billsCount || 0} {isRtl ? 'חלוקות' : 'splits'} · {total.primary}
                                </p>
                              </div>
                            </div>
                            <span className="text-[9px] font-black text-mint-600 dark:text-mint-400">{isRtl ? 'נסגרה' : 'Closed'}</span>
                          </button>
                        </SwipeableCard>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Recent Bills Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                  <h3 className="font-extrabold text-base text-slate-900 dark:text-white">
                    {t('recentBills', undefined, 'Recent bills')}
                  </h3>
                  <span className="text-[11px] font-extrabold text-slate-400">
                    {t('splitsCountLabel', { n: historyList.length }, `${historyList.length} Splits`)}
                  </span>
                </div>

                {historyList.length === 0 ? (
                  <div className="photo-card p-6 bg-white dark:bg-brand-900 text-center text-slate-400 space-y-2.5 rounded-2xl border border-slate-200/80 dark:border-white/5">
                    <span className="mx-auto mb-1 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-500 dark:bg-brand-800 dark:text-brand-200">
                      <Receipt className="h-6 w-6" />
                    </span>
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                      {t('noHistoryYet', undefined, 'No settled splits yet.')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {historyList.map((item) => {
                      const shareVal = item.userShare !== undefined ? item.userShare : item.totalAmount;
                      const dual = formatDual ? formatDual(shareVal || 0, item.currency || 'NIS') : { primary: `${shareVal || 0}` };
                      const totalDual = formatDual ? formatDual(item.totalAmount || 0, item.currency || 'NIS') : null;
                      const isShareDifferent = item.userShare !== undefined && Math.abs(item.userShare - item.totalAmount) > 0.01;

                      // Helper to find category icon/colors
                      const titleLower = (item.storeName || '').toLowerCase();
                      let ItemIcon = Utensils;
                      let iconBg = 'bg-orange-50 dark:bg-orange-950/40 text-orange-600 dark:text-orange-400 border-orange-200/60 dark:border-orange-800/40';

                      if (titleLower.includes('uber') || titleLower.includes('taxi') || titleLower.includes('flight') || titleLower.includes('train')) {
                        ItemIcon = Plane;
                        iconBg = 'bg-cyan-50 dark:bg-cyan-950/40 text-cyan-600 dark:text-cyan-400 border-cyan-200/60 dark:border-cyan-800/40';
                      } else if (titleLower.includes('zara') || titleLower.includes('nike') || titleLower.includes('dkny') || titleLower.includes('shop')) {
                        ItemIcon = ShoppingCart;
                        iconBg = 'bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 border-purple-200/60 dark:border-purple-800/40';
                      } else if (titleLower.includes('hotel') || titleLower.includes('airbnb') || titleLower.includes('trip')) {
                        ItemIcon = Globe;
                        iconBg = 'bg-brand-50 dark:bg-brand-950/40 text-brand-600 dark:text-brand-400 border-brand-200/60 dark:border-brand-800/40';
                      } else if (titleLower.includes('super') || titleLower.includes('market') || titleLower.includes('grocer')) {
                        ItemIcon = Box;
                        iconBg = 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 border-slate-200/60 dark:border-slate-700/60';
                      }

                      return (
                        <SwipeableCard
                          key={item.id}
                          onDelete={() => handleDeleteHistory(item.id)}
                          confirmationTitle={isRtl ? 'להסיר מההיסטוריה?' : 'Remove from history?'}
                          confirmationDescription={isRtl ? 'הרשומה תוסר רק מההיסטוריה שלך.' : 'This record will only be removed from your history.'}
                        >
                          <div
                            onClick={() => {
                              if (item.isGroupBill && item.groupId) {
                                router.push(`/group/${item.groupId}`);
                              } else if (item.id) {
                                router.push(`/session/${item.id}`);
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return;
                              event.preventDefault();
                              if (item.isGroupBill && item.groupId) {
                                router.push(`/group/${item.groupId}`);
                              } else if (item.id) {
                                router.push(`/session/${item.id}`);
                              }
                            }}
                            role="button"
                            tabIndex={0}
                            className="photo-card p-3.5 bg-white dark:bg-brand-900 border border-slate-200/70 dark:border-white/5 shadow-xs flex items-center justify-between hover:bg-slate-50/50 dark:hover:bg-slate-800/40 transition-all cursor-pointer rounded-2xl"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              {/* Brand / Category Avatar Icon */}
                              <div className={`w-10 h-10 rounded-full border flex items-center justify-center shrink-0 shadow-xs ${iconBg}`}>
                                <ItemIcon className="w-5 h-5" />
                              </div>

                              <div className="space-y-0.5 min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  {item.status === 'active' || item.status === 'open' ? (
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5 text-amber-500 shrink-0" aria-label="Active">
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 1 1 9 0v3.75M3.75 21.75h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H3.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                                    </svg>
                                  ) : (
                                    <Check className="w-3.5 h-3.5 text-slate-900 dark:text-white shrink-0" aria-label="Settled" />
                                  )}
                                  <h4 className="font-extrabold text-sm text-slate-900 dark:text-white leading-tight truncate">
                                    {item.storeName}
                                  </h4>
                                </div>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium truncate flex items-center gap-1">
                                  <span>{item.date}</span>
                                  {item.isGroupBill && (
                                    <span className="inline-flex items-center gap-0.5">
                                      <span>•</span>
                                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3 h-3 inline">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                                      </svg>
                                      <span>{item.groupName || t('groupFallbackLabel', {}, 'Group')}</span>
                                    </span>
                                  )}
                                </p>
                              </div>
                            </div>

                            {/* Right side Amount with Minus Sign */}
                            <div className="text-right shrink-0 flex flex-col items-end">
                              <span className="font-black text-slate-900 dark:text-white text-sm">
                                -{dual.primary}
                              </span>
                              {dual.secondary && (
                                <span className="text-[10px] text-slate-400 font-medium block">
                                  -{dual.secondary}
                                </span>
                              )}
                              {isShareDifferent && totalDual && (
                                <span className="text-[9px] text-slate-400 font-medium block">
                                  (Total: {totalDual.primary})
                                </span>
                              )}
                            </div>
                          </div>
                        </SwipeableCard>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* TAB 3: SETTINGS / PROFILE */}
        {activeTab === 'settings' && (
          <div className="space-y-5 animate-fadeIn pb-6 pt-8 sm:pt-10">
            {/* Top Right Controls: Theme Toggle */}
            <div className="flex items-center justify-end px-1 pb-1">
              <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className="w-10 h-10 rounded-full bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 shadow-sm flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                title="Toggle Light/Dark Theme"
              >
                {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-700" />}
              </button>
            </div>

            {/* Profile Avatar Centered with Edit Badge */}
            <div className="flex flex-col items-center justify-center space-y-2 py-2">
              <div className="relative group cursor-pointer" onClick={() => avatarFileInputRef.current?.click()}>
                <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-full p-1 bg-white dark:bg-[#1A2333] border-4 border-slate-100 dark:border-[#222C3D] flex items-center justify-center overflow-hidden shadow-lg transition-transform duration-200 group-hover:scale-105 active:scale-95">
                  {profile.avatarUrl && !profile.avatarUrl.includes('unsplash') ? (
                    <img
                      src={profile.avatarUrl}
                      alt="Profile Avatar"
                      className="w-full h-full rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500">
                      <User className="w-14 h-14 sm:w-16 sm:h-16" />
                    </div>
                  )}
                </div>

                {/* Floating Rounded-Square Pencil Edit Badge (Bottom Right) */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    avatarFileInputRef.current?.click();
                  }}
                  className="absolute bottom-0 right-0 p-2.5 rounded-2xl bg-white dark:bg-[#1E293B] text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-700 shadow-md hover:scale-110 active:scale-90 transition-all"
                  title={t('changePhotoBtn', undefined, 'Change Profile Photo')}
                >
                  <Pencil className="w-4 h-4 stroke-[2.5]" />
                </button>
              </div>

              {profile.avatarUrl && (
                <button
                  type="button"
                  onClick={handleResetPhoto}
                  className="text-[11px] font-bold text-rose-500 hover:text-rose-600 dark:text-rose-400 hover:underline pt-0.5"
                >
                  {t('removePhotoBtn', undefined, 'Remove Photo')}
                </button>
              )}

              <input
                type="file"
                ref={avatarFileInputRef}
                accept="image/*"
                onChange={handleAvatarUpload}
                className="hidden"
              />
            </div>

            <form onSubmit={handleSaveSettings} className="space-y-4">
              {/* Google Account Card */}
              {firebaseUser ? (
                <div className="photo-card p-3.5 bg-white dark:bg-[#15142A] border border-slate-200/90 dark:border-[#2A2847] shadow-xs rounded-2xl flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 overflow-hidden">
                    {firebaseUser.photoURL ? (
                      <img
                        src={firebaseUser.photoURL}
                        alt="Google"
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
                  >
                    {isAuthenticating ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : null}
                    <span>{t('switchGoogleAccount', undefined, 'Switch Account')}</span>
                  </button>
                </div>
              ) : (
                <div className="photo-card p-4 bg-white dark:bg-brand-900 border border-slate-200/80 dark:border-white/5 shadow-md shadow-slate-950/10 space-y-3 rounded-2xl">
                  <div className="flex items-start gap-3">
                    <div className="p-2.5 rounded-xl bg-brand-50 dark:bg-brand-950 text-brand-600 dark:text-brand-300 shrink-0">
                      <svg className="w-5 h-5" viewBox="0 0 24 24">
                        <path fill="#EA4335" d="M12 5.04c1.66 0 3.2.57 4.38 1.69l3.27-3.27C17.68 1.54 14.98 1 12 1 7.24 1 3.2 3.73 1.24 7.72l3.96 3.07C6.16 7.6 8.85 5.04 12 5.04z"/>
                        <path fill="#4285F4" d="M23.49 12.27c0-.81-.07-1.59-.2-2.33H12v4.42h6.45c-.28 1.47-1.11 2.71-2.36 3.56l3.66 2.84c2.14-1.97 3.38-4.88 3.38-8.49z"/>
                        <path fill="#FBBC05" d="M5.2 10.79c-.25-.72-.39-1.49-.39-2.29s.14-1.57.39-2.29L1.24 3.14C.45 4.73 0 6.51 0 8.5s.45 3.77 1.24 5.36l3.96-3.07z"/>
                        <path fill="#34A853" d="M12 23c3.24 0 5.97-1.07 7.96-2.92l-3.66-2.84c-1.01.68-2.31 1.09-4.3 1.09-3.15 0-5.84-2.56-6.8-5.75L1.24 13.65C3.2 17.64 7.24 23 12 23z"/>
                      </svg>
                    </div>
                    <div className="flex-1">
                      <h4 className="font-extrabold text-xs text-slate-900 dark:text-white">
                        {t('connectGoogleAccount', undefined, 'Connect Google Account')}
                      </h4>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                        {t('connectGoogleDesc', undefined, 'Sign in with Google to sync your groups, splits, and history across all your devices.')}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loginWithGoogle()}
                    disabled={isAuthenticating}
                    className="w-full py-2.5 px-4 rounded-xl bg-slate-50 hover:bg-slate-100 dark:bg-[#1C2638] dark:hover:bg-[#222E45] border border-slate-200 dark:border-[#2a374f] text-slate-800 dark:text-slate-100 text-xs font-bold shadow-xs transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isAuthenticating ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-brand-600 dark:text-brand-400" />
                        <span>{language === 'he' ? 'מתחבר ל-Google...' : 'Connecting with Google...'}</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                          <path fill="#EA4335" d="M12 5.04c1.66 0 3.2.57 4.38 1.69l3.27-3.27C17.68 1.54 14.98 1 12 1 7.24 1 3.2 3.73 1.24 7.72l3.96 3.07C6.16 7.6 8.85 5.04 12 5.04z"/>
                          <path fill="#4285F4" d="M23.49 12.27c0-.81-.07-1.59-.2-2.33H12v4.42h6.45c-.28 1.47-1.11 2.71-2.36 3.56l3.66 2.84c2.14-1.97 3.38-4.88 3.38-8.49z"/>
                          <path fill="#FBBC05" d="M5.2 10.79c-.25-.72-.39-1.49-.39-2.29s.14-1.57.39-2.29L1.24 3.14C.45 4.73 0 6.51 0 8.5s.45 3.77 1.24 5.36l3.96-3.07z"/>
                          <path fill="#34A853" d="M12 23c3.24 0 5.97-1.07 7.96-2.92l-3.66-2.84c-1.01.68-2.31 1.09-4.3 1.09-3.15 0-5.84-2.56-6.8-5.75L1.24 13.65C3.2 17.64 7.24 23 12 23z"/>
                        </svg>
                        <span>{t('signInWithGoogle', undefined, 'Sign in with Google')}</span>
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Personal Info Card */}
              <div className="photo-card p-5 bg-white dark:bg-brand-900 border border-slate-200/80 dark:border-white/5 shadow-md shadow-slate-950/10 space-y-4 rounded-2xl">
                <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2">
                  <h3 className="font-extrabold text-slate-900 dark:text-white text-sm flex items-center gap-2">
                    <User className="w-4 h-4 text-slate-700 dark:text-slate-300" />
                    <span>{t('personalInfoSection', undefined, 'Personal info')}</span>
                  </h3>
                  <button
                    type="submit"
                    className="text-xs font-bold text-slate-900 dark:text-white hover:underline"
                  >
                    {t('editLabel', undefined, 'Edit')}
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block mb-1">
                      {t('displayNameLabel', undefined, 'Display Name')}
                    </label>
                    <input
                      type="text"
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      placeholder={t('nameInputPlaceholder', undefined, 'e.g. Naor')}
                      className="w-full py-2.5 px-3.5 rounded-xl photo-input text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80 text-slate-900 dark:text-slate-100"
                      required
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block mb-1">
                      {t('phoneNumberLabel', undefined, 'Phone Number')}
                    </label>
                    <input
                      type="tel"
                      dir={isRtl ? 'rtl' : 'ltr'}
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      placeholder={t('phoneInputPlaceholder', undefined, '050-1234567')}
                      className={`w-full py-2.5 px-3.5 rounded-xl photo-input text-xs font-semibold font-mono bg-slate-50 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80 text-slate-900 dark:text-slate-100 ${isRtl ? 'text-right' : 'text-left'}`}
                    />
                  </div>
                </div>
              </div>

              <div className="photo-card p-4 bg-white dark:bg-brand-900 border border-slate-200/80 dark:border-white/5 shadow-md shadow-slate-950/10 space-y-5">
                <h3 className="font-bold text-slate-900 dark:text-white text-sm flex items-center gap-1.5">
                  <Globe className="w-4 h-4 text-slate-700 dark:text-slate-300" />
                  <span>{t('preferencesSection', undefined, 'Preferences')}</span>
                </h3>

                <div>
                  <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 block mb-1.5">
                    {t('themeModeLabel', undefined, 'App Theme Mode')}
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setTheme('light')}
                      className={`flex-1 py-2 rounded-full border text-[11px] font-extrabold flex items-center justify-center gap-1 transition-all ${
                        theme === 'light'
                          ? 'bg-slate-900 dark:bg-white border-slate-900 dark:border-white text-white dark:text-slate-900 shadow-xs'
                          : 'bg-slate-100/50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      <Sun className="w-3.5 h-3.5" />
                      <span>{t('lightModeBtn', undefined, 'Light')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTheme('dark')}
                      className={`flex-1 py-2 rounded-full border text-[11px] font-extrabold flex items-center justify-center gap-1 transition-all ${
                        theme === 'dark'
                          ? 'bg-slate-900 dark:bg-white border-slate-900 dark:border-white text-white dark:text-slate-900 shadow-xs'
                          : 'bg-slate-100/50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      <Moon className="w-3.5 h-3.5" />
                      <span>{t('darkModeBtn', undefined, 'Dark')}</span>
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 block mb-1.5">
                    {t('preferredCurrencyLabel', undefined, 'Preferred Currency')}
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['NIS', 'USD', 'EUR'] as const).map((curr) => (
                      <button
                        key={curr}
                        type="button"
                        onClick={() => setCurrency(curr)}
                        className={`py-2 rounded-full border text-[11px] font-black transition-all ${
                          currency === curr
                            ? 'bg-slate-900 dark:bg-white border-slate-900 dark:border-white text-white dark:text-slate-900 shadow-xs'
                            : 'bg-slate-100/50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                      >
                        {curr === 'NIS' ? 'NIS ₪' : curr === 'USD' ? 'USD $' : 'EUR €'}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 block mb-1.5">
                    {t('appLanguageLabel', undefined, 'App Language')}
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setLanguage('en')}
                      className={`flex-1 py-2 rounded-full border text-[11px] font-black flex items-center justify-center gap-1.5 transition-all ${
                        language === 'en'
                          ? 'bg-slate-900 dark:bg-white border-slate-900 dark:border-white text-white dark:text-slate-900 shadow-xs'
                          : 'bg-slate-100/50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      <span>English 🇺🇸</span>
                      {language === 'en' && <Check className="w-3 h-3" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setLanguage('he')}
                      className={`flex-1 py-2 rounded-full border text-[11px] font-black flex items-center justify-center gap-1.5 transition-all ${
                        language === 'he'
                          ? 'bg-slate-900 dark:bg-white border-slate-900 dark:border-white text-white dark:text-slate-900 shadow-xs'
                          : 'bg-slate-100/50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      <span>עברית 🇮🇱</span>
                      {language === 'he' && <Check className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
              </div>

              <button
                type="submit"
                className="w-full py-3 photo-btn-dark text-xs flex items-center justify-center gap-1.5"
              >
                {savedSuccess ? <Check className="w-4 h-4 text-white" /> : null}
                <span>{savedSuccess ? t('settingsSavedMsg', undefined, 'Settings Saved!') : t('saveSettingsBtn', undefined, 'Save Settings')}</span>
              </button>

              {(firebaseUser || profile.displayName) && (
                <button
                  type="button"
                  onClick={handleSignOutClick}
                  className="w-full mt-2 py-3 px-4 rounded-xl border border-rose-200 dark:border-rose-950/40 bg-rose-50/50 dark:bg-rose-950/10 text-rose-600 dark:text-rose-400 text-xs font-bold transition-all hover:bg-rose-100/60 dark:hover:bg-rose-950/20 flex items-center justify-center gap-1.5"
                >
                  <LogOut className="w-4 h-4" />
                  <span>{t('signOutBtn', undefined, 'Sign Out')}</span>
                </button>
              )}
            </form>
          </div>
        )}
      </div>

      {/* Ultra-Smooth LTR & RTL Animated Sliding Modern Navbar */}
      <nav className="safe-bottom-nav shrink-0 w-full z-40 p-2.5 bg-white/90 dark:bg-[#100E2C] border-t border-brand-100/80 dark:border-brand-900/60 backdrop-blur-xl shadow-[0_-8px_28px_rgba(37,33,111,0.08)] mt-auto">
        <div className="relative grid grid-cols-3 gap-2 p-1 bg-brand-50/90 dark:bg-[#181643] rounded-full border border-brand-100 dark:border-brand-800/80">
          
          {/* Animated Sliding Pill Indicator */}
          <div
            className="absolute top-1 bottom-1 rounded-full bg-brand-600 dark:bg-brand-300 shadow-brand transition-all duration-350 ease-out nav-slider"
            style={{
              width: 'calc((100% - 16px) / 3)',
              transform: `translateX(calc(${activeTabIndex * (isRtl ? -1 : 1)} * (100% + 8px)))`
            }}
          />
 
          {/* TAB 1: HISTORY */}
          <button
            onClick={() => {
              setActiveTab('history');
              triggerHaptic('light');
            }}
            className={`relative z-10 flex flex-col items-center justify-center py-2 rounded-full transition-colors duration-200 font-bold active:scale-95 ${
              activeTab === 'history'
                ? 'text-white dark:text-brand-950 font-extrabold'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            }`}
          >
            <History className="w-3.5 h-3.5 mb-0.5" />
            <span className="text-[10px]">{t('tabHistory', undefined, 'History')}</span>
          </button>
 
          {/* TAB 2: SESSIONS / SPLIT */}
          <button
            onClick={() => {
              setActiveTab('sessions');
              triggerHaptic('light');
            }}
            className={`relative z-10 flex flex-col items-center justify-center py-2 rounded-full transition-colors duration-200 font-bold active:scale-95 ${
              activeTab === 'sessions'
                ? 'text-white dark:text-brand-950 font-extrabold'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mb-0.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="m9 14.25 6-6m4.5-3.493V21.75l-3.75-1.5-3.75 1.5-3.75-1.5-3.75 1.5V4.757c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0c1.1.128 1.907 1.077 1.907 2.185ZM9.75 9h.008v.008H9.75V9Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm4.125 4.5h.008v.008h-.008V13.5Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
            </svg>
            <span className="text-[10px]">{t('tabSessions', undefined, 'Sessions')}</span>
          </button>
 
          {/* TAB 3: SETTINGS */}
          <button
            onClick={() => {
              setActiveTab('settings');
              triggerHaptic('light');
            }}
            className={`relative z-10 flex flex-col items-center justify-center py-2 rounded-full transition-colors duration-200 font-bold active:scale-95 ${
              activeTab === 'settings'
                ? 'text-white dark:text-brand-950 font-extrabold'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            }`}
          >
            <Settings className="w-3.5 h-3.5 mb-0.5" />
            <span className="text-[10px]">{t('tabSettings', undefined, 'Settings')}</span>
          </button>
        </div>
      </nav>
      {/* Manual Bill Creation Modal */}
      <ManualBillModal
        isOpen={showManualModal}
        isLoading={isUploading}
        onClose={() => {
          setShowManualModal(false);
          setPendingReceiptDraft(null);
          setPendingScanId('');
          setPendingRecoveryToken('');
        }}
        onLaunchSession={handleLaunchManualSession}
        initialData={pendingReceiptDraft}
      />

      {/* Create Group Modal */}
      <CreateGroupModal
        isOpen={showCreateGroupModal}
        isLoading={isUploading}
        onClose={() => setShowCreateGroupModal(false)}
        onCreateGroup={handleCreateGroup}
      />

      {/* Start Split Options Popup Modal */}
      {showStartSplitModal && (
        <div
          data-testid="start-split-sheet"
          className="fixed inset-0 z-50 flex flex-col justify-end bg-slate-950/60 backdrop-blur-xs animate-fadeIn"
          onClick={() => setShowStartSplitModal(false)}
        >
          <div 
            style={{
              transform: splitModalDragY > 0 ? `translateY(${splitModalDragY}px)` : undefined,
              transition: splitModalDragY === 0 ? 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)' : 'none'
            }}
            className="w-full max-w-md mx-auto rounded-t-[32px] p-6 pb-8 bg-white dark:bg-brand-900 text-slate-900 dark:text-white space-y-4 shadow-2xl animate-bottomSheet border-t border-slate-200/80 dark:border-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Visual Drag Handle Pill with Touch events */}
            <div 
              onTouchStart={handleSplitTouchStart}
              onTouchMove={handleSplitTouchMove}
              onTouchEnd={handleSplitTouchEnd}
              className="py-2 -mt-3 mb-1 cursor-grab active:cursor-grabbing touch-none select-none flex justify-center"
            >
              <div className="w-12 h-1.5 rounded-full bg-slate-300 dark:bg-slate-700 opacity-80" />
            </div>

            {/* Header with Touch events */}
            <div 
              onTouchStart={handleSplitTouchStart}
              onTouchMove={handleSplitTouchMove}
              onTouchEnd={handleSplitTouchEnd}
              className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 touch-none select-none"
            >
              <div className="text-left rtl:text-right">
                <h3 className="text-lg sm:text-xl font-black text-slate-900 dark:text-white tracking-tight">{t('startSplitTitle', undefined, 'Start a New Split')}</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{t('startSplitSubtitle', undefined, 'Choose how to add your bill')}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowStartSplitModal(false)}
                className="p-2 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Options List */}
            <div className="space-y-3 pt-2">
              {/* Option 1: Scan Camera */}
              <button
                type="button"
                onClick={() => {
                  setShowStartSplitModal(false);
                  handleScanCamera();
                }}
                className="w-full p-4 rounded-2xl border border-slate-200 dark:border-[#222C3D] hover:border-brand-500/50 hover:bg-brand-50/40 dark:hover:bg-brand-950/20 transition-all flex items-center gap-4 text-left rtl:text-right active:scale-[0.98] shadow-2xs"
              >
                <div className="p-3 rounded-2xl bg-brand-50 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400 border border-brand-100 dark:border-brand-900/40 shrink-0">
                  <Camera className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1 text-left rtl:text-right">
                  <h4 className="font-black text-sm sm:text-base text-slate-900 dark:text-white leading-snug">{t('scanCameraOption', undefined, isRtl ? 'סריקת קבלה' : 'Scan Receipt')}</h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-0.5">{t('scanCameraDesc', undefined, isRtl ? 'צילום ישיר במצלמה' : 'Snap photo with camera')}</p>
                </div>
              </button>

              {/* Option 2: Upload Photo */}
              <button
                type="button"
                onClick={() => {
                  setShowStartSplitModal(false);
                  fileInputRef.current?.click();
                }}
                className="w-full p-4 rounded-2xl border border-slate-200 dark:border-[#222C3D] hover:border-brand-500/50 hover:bg-brand-50/40 dark:hover:bg-brand-950/20 transition-all flex items-center gap-4 text-left rtl:text-right active:scale-[0.98] shadow-2xs"
              >
                <div className="p-3 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 shrink-0">
                  <Upload className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1 text-left rtl:text-right">
                  <h4 className="font-black text-sm sm:text-base text-slate-900 dark:text-white leading-snug">{t('uploadPhotoOption', undefined, isRtl ? 'העלאת תמונה' : 'Upload Image')}</h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-0.5">{t('uploadPhotoDesc', undefined, isRtl ? 'בחירה מתוך הגלריה' : 'Select from gallery')}</p>
                </div>
              </button>

              {/* Option 3: Manual Split */}
              <button
                type="button"
                onClick={() => {
                  setShowStartSplitModal(false);
                  setPendingReceiptDraft(null);
                  setPendingScanId('');
                  setPendingRecoveryToken('');
                  setShowManualModal(true);
                }}
                className="w-full p-4 rounded-2xl border border-slate-200 dark:border-[#222C3D] hover:border-brand-500/50 hover:bg-brand-50/40 dark:hover:bg-brand-950/20 transition-all flex items-center gap-4 text-left rtl:text-right active:scale-[0.98] shadow-2xs"
              >
                <div className="p-3 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 shrink-0">
                  <FilePlus className="w-6 h-6 text-brand-500" />
                </div>
                <div className="min-w-0 flex-1 text-left rtl:text-right">
                  <h4 className="font-black text-sm sm:text-base text-slate-900 dark:text-white leading-snug">{t('manualSplitOption', undefined, isRtl ? 'יצירה ידנית' : 'Create Manually')}</h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-0.5">{t('manualSplitDesc', undefined, isRtl ? 'הזנת פריטים ומחירים' : 'Type items & prices')}</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Join Session Modal popup */}
      {showJoinSessionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs animate-fadeIn" onClick={() => setShowJoinSessionModal(false)}>
          <div 
            className="w-full max-w-sm rounded-3xl p-5 bg-white dark:bg-brand-900 text-slate-900 dark:text-white space-y-4 shadow-2xl animate-scaleUp"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <QrCode className="w-5 h-5 text-slate-900 dark:text-white" />
                <h3 className="font-extrabold text-sm text-slate-900 dark:text-white">{t('joinViaCode', undefined, 'Join Split or Group')}</h3>
              </div>
              <button
                onClick={() => setShowJoinSessionModal(false)}
                className="p-1 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Input Form */}
            <form 
              onSubmit={(e) => {
                setShowJoinSessionModal(false);
                handleUniversalJoin(e);
              }} 
              className="space-y-3"
            >
              <input
                type="text"
                maxLength={8}
                placeholder={t('enterUniversalCodePlaceholder', undefined, 'Enter room code')}
                value={universalJoinCode}
                onChange={(e) => setUniversalJoinCode(e.target.value.replace(/\D/g, ''))}
                className="w-full py-2.5 px-3.5 rounded-xl photo-input text-center text-sm font-mono tracking-widest font-extrabold text-slate-900 dark:text-white placeholder:text-slate-400 placeholder:font-sans placeholder:text-xs placeholder:tracking-normal"
              />

              <button
                type="submit"
                disabled={!/^(?:\d{4}|\d{5}|\d{8})$/.test(universalJoinCode)}
                className="w-full py-3 px-4 photo-btn-indigo text-xs flex items-center justify-center gap-1.5 disabled:opacity-40"
              >
                <span>{t('joinSessionBtn', undefined, 'Join')}</span>
                <ArrowRight className={`w-3.5 h-3.5 ${isRtl ? 'rotate-180' : ''}`} />
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Active Group Context Modal */}
      {selectedGroupForModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-md animate-fadeIn text-slate-900 dark:text-white"
          onClick={closeGroupModal}
        >
          <div
            style={{
              transform: groupModalDragY > 0 ? `translateY(${groupModalDragY}px)` : undefined,
              transition: groupModalDragY === 0 ? 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)' : 'none',
            }}
            onClick={(event) => event.stopPropagation()}
            className="relative w-full max-w-xs rounded-3xl bg-white dark:bg-brand-950 border border-slate-200 dark:border-slate-800 p-5 pt-3 shadow-2xl space-y-4"
          >
            <div
              onTouchStart={handleGroupTouchStart}
              onTouchMove={handleGroupTouchMove}
              onTouchEnd={handleGroupTouchEnd}
              className="-mt-1 -mb-2 py-2 cursor-grab active:cursor-grabbing touch-none select-none flex justify-center"
              aria-hidden="true"
            >
              <div className="w-12 h-1.5 rounded-full bg-slate-300 dark:bg-slate-700 opacity-80" />
            </div>
            <div
              onTouchStart={handleGroupTouchStart}
              onTouchMove={handleGroupTouchMove}
              onTouchEnd={handleGroupTouchEnd}
              className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3 touch-none select-none"
            >
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-brand-600 dark:bg-brand-300 text-white dark:text-brand-950 flex items-center justify-center font-black text-xs">
                  {(selectedGroupForModal.name || 'G').substring(0, 2).toUpperCase()}
                </div>
                <div>
                  <h3 className="font-extrabold text-sm text-slate-900 dark:text-white">{selectedGroupForModal.name}</h3>
                  <span className="text-[10px] font-mono text-slate-400 font-bold">#{selectedGroupForModal.code}</span>
                </div>
              </div>

              <button
                onClick={closeGroupModal}
                className="p-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {groupModalTab === 'options' ? (
              <div className="space-y-2.5">
                <button
                  type="button"
                  onClick={async () => {
                    if (confirm(`Are you sure you want to leave group "${selectedGroupForModal.name}"?`)) {
                      try {
                        const groupId = selectedGroupForModal.id;
                        const res = await fetch(apiUrl(`/api/groups/${groupId}/leave`), {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            ...roomHeaders('group', groupId, true),
                          },
                          body: JSON.stringify({
                            name: profile?.displayName || '',
                          }),
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Could not leave group');

                        const localDeleted = localStorage.getItem('billsplit_deleted_group_ids');
                        const deletedIds = localDeleted ? JSON.parse(localDeleted) : [];
                        if (!deletedIds.includes(groupId)) {
                          deletedIds.push(groupId);
                          localStorage.setItem('billsplit_deleted_group_ids', JSON.stringify(deletedIds));
                        }

                        const updated = userGroups.filter((g: any) => g.id !== groupId);
                        setUserGroups(updated);
                        setCookie('billsplit_user_groups', updated);
                        localStorage.setItem('billsplit_user_groups', JSON.stringify(updated));
                        const rawName = (profile?.displayName || '').trim();
                        const userKey = rawName.toLowerCase();
                        if (rawName) localStorage.setItem(`billsplit_user_groups_${rawName}`, JSON.stringify(updated));
                        if (userKey) localStorage.setItem(`billsplit_user_groups_${userKey}`, JSON.stringify(updated));
                        clearRoomCredentials('group', groupId);
                        closeGroupModal();
                        triggerHaptic('success');
                      } catch (err) {
                        alert(err instanceof Error ? err.message : 'Could not leave group');
                      }
                    }
                  }}
                  className="w-full py-3 px-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-xs sm:text-sm font-bold flex items-center justify-between transition-colors active:scale-[0.98]"
                >
                  <span className="flex items-center gap-2.5">
                    <LogOut className="w-4 h-4 text-amber-500" />
                    <span>{t('leaveGroupItem', undefined, 'Leave Group')}</span>
                  </span>
                  <span className="text-sm">🚪</span>
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    if (confirm(`Are you sure you want to delete group "${selectedGroupForModal.name}"? This cannot be undone.`)) {
                      try {
                        const groupId = selectedGroupForModal.id;
                        const res = await fetch(apiUrl(`/api/groups/${groupId}`), {
                          method: 'DELETE',
                          headers: roomHeaders('group', groupId, false),
                        });
                        const data = await res.json().catch(() => ({}));
                        if (res.status === 403) {
                          if (confirm(`Only the host can delete this group for everyone. Do you want to remove it from your device?`)) {
                            await fetch(apiUrl(`/api/groups/${groupId}/leave`), {
                              method: 'POST',
                              headers: {
                                'Content-Type': 'application/json',
                                ...roomHeaders('group', groupId, true),
                              },
                              body: JSON.stringify({ name: profile?.displayName || '' }),
                            }).catch(() => {});
                          } else {
                            return;
                          }
                        } else if (!res.ok) {
                          throw new Error(data.error || 'Could not delete group');
                        }

                        const localDeleted = localStorage.getItem('billsplit_deleted_group_ids');
                        const deletedIds = localDeleted ? JSON.parse(localDeleted) : [];
                        if (!deletedIds.includes(groupId)) {
                          deletedIds.push(groupId);
                          localStorage.setItem('billsplit_deleted_group_ids', JSON.stringify(deletedIds));
                        }

                        const updated = userGroups.filter((g: any) => g.id !== groupId);
                        setUserGroups(updated);
                        setCookie('billsplit_user_groups', updated);
                        localStorage.setItem('billsplit_user_groups', JSON.stringify(updated));
                        const rawName = (profile?.displayName || '').trim();
                        const userKey = rawName.toLowerCase();
                        if (rawName) localStorage.setItem(`billsplit_user_groups_${rawName}`, JSON.stringify(updated));
                        if (userKey) localStorage.setItem(`billsplit_user_groups_${userKey}`, JSON.stringify(updated));
                        clearRoomCredentials('group', groupId);
                        closeGroupModal();
                        triggerHaptic('success');
                      } catch (err) {
                        alert(err instanceof Error ? err.message : 'Could not delete group');
                      }
                    }
                  }}
                  className="w-full py-3 px-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/40 text-rose-700 dark:text-rose-300 text-xs sm:text-sm font-bold flex items-center justify-between transition-colors active:scale-[0.98]"
                >
                  <span className="flex items-center gap-2.5">
                    <Trash2 className="w-4 h-4 text-rose-500" />
                    <span>{t('deleteGroupItem', undefined, 'Delete Group')}</span>
                  </span>
                  <span className="text-sm">🗑️</span>
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    const groupUrl = publicWebUrl(`/group/${selectedGroupForModal.id}`);
                    const result = await shareInvite({
                      title: `Join Group ${selectedGroupForModal.name}`,
                      text: `Join our group ${selectedGroupForModal.name} with code ${selectedGroupForModal.code}!`,
                      url: groupUrl,
                      dialogTitle: t('shareGroupItem', undefined, 'Share Group'),
                    });
                    if (result === 'unavailable') {
                      const copied = await copyText(groupUrl);
                      if (copied && !Capacitor.isNativePlatform()) {
                        alert('Group invite link copied to clipboard! 🔗');
                      }
                    }
                    closeGroupModal();
                  }}
                  className="w-full py-3 px-3.5 rounded-xl bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-900 dark:text-white text-xs sm:text-sm font-bold flex items-center justify-between transition-colors active:scale-[0.98]"
                >
                  <span className="flex items-center gap-2.5">
                    <Share2 className="w-4 h-4 text-brand-500" />
                    <span>{t('shareGroupItem', undefined, 'Share Group')}</span>
                  </span>
                  <span className="text-xs text-slate-400">🔗</span>
                </button>

                <button
                  type="button"
                  onClick={() => setGroupModalTab('details')}
                  className="w-full py-3 px-3.5 rounded-xl bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-900 dark:text-white text-xs sm:text-sm font-bold flex items-center justify-between transition-colors active:scale-[0.98]"
                >
                  <span className="flex items-center gap-2.5">
                    <Users className="w-4 h-4 text-slate-700 dark:text-slate-300" />
                    <span>{t('seeGroupDetails', undefined, 'See Group Details')}</span>
                  </span>
                  <span className="text-xs text-slate-400">📋</span>
                </button>
              </div>
            ) : (
              <div className="space-y-3 text-xs">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 space-y-1.5">
                  <div className="flex justify-between">
                    <span className="text-slate-400">{t('codeLabel', undefined, 'Group Code')}:</span>
                    <span className="font-mono font-bold">#{selectedGroupForModal.code}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">{t('preferredCurrencyLabel', undefined, 'Currency')}:</span>
                    <span className="font-bold">{selectedGroupForModal.currency === 'USD' ? '$ (USD)' : '₪ (NIS)'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">{t('membersCountLabel', { n: selectedGroupForModal.members?.length || 1 }, `${selectedGroupForModal.members?.length || 1} members`)}:</span>
                    <span className="font-bold">{selectedGroupForModal.members?.length || 1}</span>
                  </div>
                </div>

                <button
                  onClick={() => setGroupModalTab('options')}
                  className="w-full py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold text-xs"
                >
                  {t('backToOptions', undefined, 'חזור לאפשרויות')}
                </button>
              </div>
            )}

          </div>
        </div>
      )}
    </div>
  );
}
