'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ChevronLeft,
  Users,
  Plus,
  QrCode,
  ArrowRight,
  Pencil,
  Trash2,
  CheckCircle2,
  FileText,
  Sparkles,
  Camera,
  Upload,
  FilePlus,
  RefreshCw,
  Sun,
  Moon,
  ChevronDown,
  ChevronUp,
  LogOut,
  X,
  Share2,
  Copy,
  Check
} from 'lucide-react';
import { useLanguage } from '../../../components/LanguageContext';
import { QRCodeModal } from '../../../components/QRCodeModal';
import { ManualBillModal } from '../../../components/ManualBillModal';
import { CameraViewfinder } from '../../../components/CameraViewfinder';
import { OCRProgressOverlay } from '../../../components/OCRProgressOverlay';
import { SwipeableCard } from '../../../components/SwipeableCard';
import { createReceiptDraft, receiptConfirmationPayload, receiptScanUserMessage } from '../../../../lib/receiptScanClient';
import { getCookie, setCookie } from '../../../../lib/cookies';
import { formatCurrency } from '../../../../lib/i18n';
import { cleanIsraeliPhone, isValidIsraeliPhone, triggerBitPayment } from '../../../../lib/bitDeepLink';
import { triggerHaptic } from '../../../../lib/haptics';
import { clearRoomCredentials, getRoomMemberId, getRoomToken, roomHeaders, saveRoomCredentials } from '../../../../lib/roomTokens';

function createClientActionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `action_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

export default function GroupWorkspacePage() {
  const params = useParams();
  const router = useRouter();
  const groupId = (params?.id as string) || '';

  const { t, currency, formatPrice, formatDual, isRtl, theme, setTheme, profile } = useLanguage();

  const [group, setGroup] = useState<any>(null);
  const [currentMemberId, setCurrentMemberId] = useState<string>('');
  const [showQrModal, setShowQrModal] = useState(false);
  const [showCreateBillModal, setShowCreateBillModal] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [showStartSplitModal, setShowStartSplitModal] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [paymentLookupKey, setPaymentLookupKey] = useState('');

  // Edit Bill State
  const [editingBill, setEditingBill] = useState<any>(null);
  const [pendingReceiptDraft, setPendingReceiptDraft] = useState<any>(null);
  const [pendingScanId, setPendingScanId] = useState('');
  const [expandedBillId, setExpandedBillId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const paymentLookupRef = useRef(false);

  const persistGroupToLocal = (grp: any) => {
    if (!grp || !grp.id) return;
    try {
      const localDeleted = localStorage.getItem('billsplit_deleted_group_ids');
      const deletedIds = localDeleted ? JSON.parse(localDeleted) : [];
      if (deletedIds.includes(grp.id)) return;

      const cookieGroups = getCookie('billsplit_user_groups');
      const localGroups = localStorage.getItem('billsplit_user_groups');
      const rawGroups = cookieGroups || (localGroups ? JSON.parse(localGroups) : []);
      const list = Array.isArray(rawGroups) ? rawGroups : [];
      const exists = list.some((g: any) => g.id === grp.id);
      const item = {
        id: grp.id,
        code: grp.code,
        name: grp.name,
        currency: grp.currency,
        membersCount: Array.isArray(grp.members) ? grp.members.length : 1,
      };
      const updated = exists ? list.map((g: any) => (g.id === grp.id ? { ...g, ...item } : g)) : [item, ...list];
      setCookie('billsplit_user_groups', updated);
      localStorage.setItem('billsplit_user_groups', JSON.stringify(updated));

      const rawName = (profile?.displayName || '').trim();
      const userKey = rawName.toLowerCase();
      if (rawName) {
        localStorage.setItem(`billsplit_user_groups_${rawName}`, JSON.stringify(updated));
      }
      if (userKey) {
        localStorage.setItem(`billsplit_user_groups_${userKey}`, JSON.stringify(updated));
      }
    } catch (e) {}
  };

  const handleScanCamera = () => {
    const isMobile = typeof window !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const hasMediaDevices = typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    if (isMobile || !hasMediaDevices) {
      if (cameraInputRef.current) {
        cameraInputRef.current.click();
        return;
      }
    }
    setShowCamera(true);
  };

  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!groupId || !profile.displayName) return;
    let disposed = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const initializeGroup = async () => {
      try {
        const initialRes = await fetch(`/api/groups/${groupId}`, { headers: roomHeaders('group', groupId, false) });
        const initialData = await initialRes.json();
        if (!initialRes.ok || !initialData.group) throw new Error(initialData.error || 'Group not found');
        const resolvedId = initialData.group.id;
        const existingToken = getRoomToken('group', resolvedId) || getRoomToken('group', groupId);
        const persistedMemberId = getRoomMemberId('group', resolvedId) || getRoomMemberId('group', groupId);
        const existingMember = (initialData.group.members || []).find((m: any) => m.id === persistedMemberId);
        if (existingToken && existingMember) {
          saveRoomCredentials('group', resolvedId, existingMember.id, existingToken);
          if (!disposed) {
            setCurrentMemberId(existingMember.id);
            setGroup(initialData.group);
            persistGroupToLocal(initialData.group);
            setFetchError(null);
            connectWebSocket(resolvedId, existingToken);
            interval = setInterval(() => fetchGroupData(resolvedId), 15_000);
            if (resolvedId !== groupId) router.replace(`/group/${resolvedId}`);
          }
          return;
        }

        const joinRes = await fetch('/api/groups/join', {
          method: 'POST',
          headers: roomHeaders('group', resolvedId),
          body: JSON.stringify({
            groupId: resolvedId,
            name: profile.displayName || 'Member',
            phone: profile.phoneNumber || '',
          }),
        });
        const joined = await joinRes.json();
        if (!joinRes.ok || !joined.group || !joined.accessToken) {
          throw new Error(joined.error || 'Could not join group');
        }
        saveRoomCredentials('group', resolvedId, joined.memberId, joined.accessToken);
        if (resolvedId !== groupId) saveRoomCredentials('group', groupId, joined.memberId, joined.accessToken);

        if (!disposed) {
          setCurrentMemberId(joined.memberId);
          setGroup(joined.group);
          persistGroupToLocal(joined.group);
          setFetchError(null);
          connectWebSocket(resolvedId, joined.accessToken);
          interval = setInterval(() => fetchGroupData(resolvedId), 15_000);
          if (resolvedId !== groupId) router.replace(`/group/${resolvedId}`);
        }
      } catch (err) {
        console.error('Error initializing group:', err);
        if (!disposed) setFetchError(err instanceof Error ? err.message : 'Could not load group');
      }
    };

    initializeGroup();

    // Timeout safety for group loading
    const timeoutTimer = setTimeout(() => {
      setFetchError((prev) => (prev ? prev : 'Group taking too long to load or code invalid'));
    }, 6000);

    return () => {
      disposed = true;
      if (interval) clearInterval(interval);
      clearTimeout(timeoutTimer);
      if (socketRef.current) socketRef.current.close();
    };
  }, [groupId, profile.displayName, profile.phoneNumber]);

  const fetchGroupData = async (id: string) => {
    try {
      const res = await fetch(`/api/groups/${id}`, { headers: roomHeaders('group', id, false) });
      if (res.ok) {
        const data = await res.json();
        if (data.group) {
          setGroup(data.group);
          persistGroupToLocal(data.group);
          setFetchError(null);
          // Normalize a shared invite code to the durable group id.
          if (data.group.id && data.group.id !== id) {
            router.replace(`/group/${data.group.id}`);
          }
        }
      } else if (res.status === 404) {
        setFetchError('Group not found or code invalid');
      }
    } catch (err) {
      console.error('Error fetching group:', err);
    }
  };

  const connectWebSocket = (id: string, accessToken: string) => {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;
      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'SUBSCRIBE_GROUP',
            groupId: id,
            accessToken,
          })
        );
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'GROUP_UPDATE' && data.group) {
            setGroup(data.group);
            persistGroupToLocal(data.group);
          } else if (data.type === 'GROUP_DELETED') {
            clearRoomCredentials('group', id);
            router.push('/');
          }
        } catch (e) {
          console.error(e);
        }
      };
    } catch (err) {
      console.error('WebSocket connection error:', err);
    }
  };

  const handleAddBillToGroup = async (billData: { title: string; currency: string; items: any[]; payerId?: string; amount?: number; id?: string; date?: string; receipt?: any; scanId?: string; confirmedByUser?: boolean }) => {
    if (!group) return;

    try {
      const res = await fetch('/api/groups/bill', {
        method: 'POST',
        headers: roomHeaders('group', group.id),
        body: JSON.stringify({
          groupId: group.id,
          bill: {
            id: billData.id || (billData.scanId ? undefined : `bill_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`),
            expectedRevision: editingBill ? Number(editingBill.revision || 0) : undefined,
            title: billData.title,
            date: billData.date || editingBill?.date || new Date().toISOString().split('T')[0],
            payerId: billData.payerId || currentMemberId,
            currency: billData.currency || group.currency || 'NIS',
            amount: billData.amount || billData.items.reduce((acc, i) => acc + (i.price || 0), 0),
            items: billData.items,
            receipt: billData.receipt,
            scanId: billData.scanId,
            confirmedByUser: billData.confirmedByUser,
          }
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save bill to group');
      if (data.group) {
        setGroup(data.group);
        persistGroupToLocal(data.group);
        setShowCreateBillModal(false);
        setEditingBill(null);
        setPendingReceiptDraft(null);
        setPendingScanId('');

        // If a new live bill session was created, open the live item-claiming room!
        if (data.sessionId && !billData.id) {
          const groupToken = getRoomToken('group', group.id);
          saveRoomCredentials('session', data.sessionId, currentMemberId, groupToken);
          window.location.href = `/session/${data.sessionId}?groupId=${group.id}`;
        }
      }
    } catch (err) {
      console.error(err);
      alert('Failed to save bill to group.');
    }
  };

  const handleDeleteBill = async (billId: string) => {
    if (!group) return;
    const isPaymentLocked = group.bills?.find((b: any) => b.id === billId)?.status === 'settled';
    if (isPaymentLocked) {
      alert(t('cannotDeleteSettledBill', undefined, 'This bill is settled or has completed payments. It cannot be deleted.'));
      return;
    }
    const resolvedId = group.id || groupId;
    try {
      const res = await fetch(`/api/groups/bill/${resolvedId}/${billId}`, {
        method: 'DELETE',
        headers: roomHeaders('group', resolvedId),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete bill');
      if (data.group) {
        setGroup(data.group);
        persistGroupToLocal(data.group);
      }
    } catch (err) {
      console.error(err);
      alert('Failed to delete bill');
    }
  };

  const sendGroupBillAction = async (type: string, payload: any) => {
    if (!group) return;
    try {
      const res = await fetch('/api/groups/bill/action', {
        method: 'POST',
        headers: roomHeaders('group', group.id),
        body: JSON.stringify({
          groupId: group.id,
          type,
          payload,
          actionId: createClientActionId(),
          memberId: currentMemberId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to perform bill action');
      if (data.group) {
        setGroup(data.group);
        persistGroupToLocal(data.group);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not update bill');
    }
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const draft = await createReceiptDraft(file, profile.displayName || 'Member');
      setEditingBill(null);
      setPendingReceiptDraft({ ...draft.receipt, imageQuality: draft.imageQuality, _previewImages: draft.previewImages });
      setPendingScanId(draft.scanId);
      setShowCreateBillModal(true);
    } catch (err) {
      console.error(err);
      alert(receiptScanUserMessage(t));
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCameraScanComplete = async (scanResult: any) => {
    setShowCamera(false);
    const parsedReceipt = scanResult.receipt || scanResult.session;
    if (parsedReceipt) {
      setEditingBill(null);
      setPendingReceiptDraft(parsedReceipt);
      setPendingScanId(scanResult.scanId || '');
      setShowCreateBillModal(true);
    }
  };

  const validMembers = useMemo(() => {
    const raw = Array.isArray(group?.members) ? group.members.filter((member: any) => member && member.active !== false) : [];
    const seen = new Set();
    const result: any[] = [];
    for (const m of raw) {
      const key = (m.id || '') + '___' + (m.name || '').trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(m);
      }
    }
    return result;
  }, [group?.members]);

  const validBills = Array.isArray(group?.bills) ? group.bills : [];
  const minimizedTransactions = Array.isArray(group?.minimizedTransactions) ? group.minimizedTransactions : [];

  const balances = useMemo(() => {
    const raw = Array.isArray(group?.balances) ? group.balances : [];
    const seen = new Set();
    const result: any[] = [];
    for (const b of raw) {
      const key = (b.memberId || '') + '___' + (b.name || '').trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(b);
      }
    }
    return result;
  }, [group?.balances]);

  const unassignedAmount = Number(group?.unassignedAmount || 0);
  const isGroupHost = Boolean(validMembers.find((member: any) => member.id === currentMemberId)?.isHost);

  // Stable memoized modal data
  const initialModalData = useMemo(() => {
    if (editingBill) return editingBill;
    if (pendingReceiptDraft) return pendingReceiptDraft;
    return { currency: group?.currency || 'NIS' };
  }, [editingBill, pendingReceiptDraft, group?.currency]);

  if (!group) {
    if (fetchError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-white dark:bg-brand-950 text-slate-900 dark:text-white text-center space-y-4">
          <div className="p-4 rounded-full bg-rose-100 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400">
            <Users className="w-8 h-8" />
          </div>
          <h2 className="text-lg font-bold">{t('groupNotFoundTitle', undefined, 'Group Not Found')}</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs leading-relaxed">
            {t('groupNotFoundSub', undefined, 'The group code or link you entered does not exist or has expired.')}
          </p>
          <button
            onClick={() => router.push('/')}
            className="py-2.5 px-5 rounded-full bg-brand-600 dark:bg-brand-300 text-white dark:text-brand-950 text-xs font-bold flex items-center justify-center gap-2 shadow-md active:scale-95"
          >
            <span>{t('backToHomeBtn', undefined, 'Back to Home')}</span>
          </button>
        </div>
      );
    }

    return (
      <div className="app-surface flex flex-col items-center justify-center min-h-screen p-5 text-slate-900 dark:text-white">
        <RefreshCw className="w-8 h-8 animate-spin text-brand-500 mb-2" />
        <p className="text-xs font-bold text-slate-500">Loading Group Workspace...</p>
      </div>
    );
  }

  return (
    <div className="app-surface flex flex-col min-h-screen p-5 text-slate-900 dark:text-slate-100 space-y-5 transition-colors duration-300 pb-28" dir={isRtl ? 'rtl' : 'ltr'}>
      <OCRProgressOverlay isVisible={isUploading} />

      <input
        type="file"
        ref={fileInputRef}
        accept="image/*"
        onChange={handlePhotoUpload}
        className="hidden"
      />

      {/* Camera Viewfinder */}
      {showCamera && (
        <CameraViewfinder
          onScanComplete={handleCameraScanComplete}
          onCancel={() => setShowCamera(false)}
          parseOnly
          hostName={profile.displayName || 'Member'}
        />
      )}

      {/* QR Code Modal */}
      {showQrModal && (
        <QRCodeModal
          isOpen={showQrModal}
          onClose={() => setShowQrModal(false)}
          sessionCode={group.code || ''}
          sessionId={group.id || ''}
          isGroup={true}
        />
      )}

      {/* Manual Bill Builder Modal */}
      {showCreateBillModal && (
        <ManualBillModal
          isOpen={showCreateBillModal}
          isLoading={isUploading}
          onClose={() => {
            setShowCreateBillModal(false);
            setEditingBill(null);
            setPendingReceiptDraft(null);
            setPendingScanId('');
          }}
          onLaunchSession={(data) => {
            return handleAddBillToGroup({
              id: editingBill?.id,
              title: data.storeName,
              date: data.date || pendingReceiptDraft?.date || editingBill?.date,
              currency: data.currency,
              items: data.items,
              payerId: editingBill?.payerId || currentMemberId,
              receipt: pendingReceiptDraft
                ? { ...receiptConfirmationPayload(pendingReceiptDraft), scanId: pendingScanId, confirmedByUser: true }
                : undefined,
              scanId: pendingScanId || undefined,
              confirmedByUser: Boolean(pendingScanId),
            });
          }}
          initialData={initialModalData}
        />
      )}

      {/* Start Split Options Popup Modal */}
      {showStartSplitModal && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-slate-950/70 backdrop-blur-xs animate-fadeIn" onClick={() => setShowStartSplitModal(false)}>
          <div 
            className="w-full max-w-md mx-auto rounded-t-[32px] p-6 bg-white dark:bg-brand-950 text-slate-900 dark:text-white space-y-4 shadow-2xl animate-slideUp border-t border-slate-200 dark:border-slate-800"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h3 className="text-base font-extrabold text-slate-900 dark:text-white">{t('startSplitTitle', undefined, 'Start a New Split')}</h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">{t('startSplitSubtitle', undefined, 'Choose how you want to load the bill')}</p>
              </div>
              <button
                onClick={() => setShowStartSplitModal(false)}
                className="p-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Options List */}
            <div className="space-y-2.5 pt-1 text-left">
              {/* Option 1: Scan Camera */}
              <button
                onClick={() => {
                  setShowStartSplitModal(false);
                  handleScanCamera();
                }}
                className="w-full p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 hover:border-brand-500/50 hover:bg-brand-50/50 dark:hover:bg-brand-950/20 transition-all flex items-center gap-3.5 text-left active:scale-[0.98]"
              >
                <div className="p-2.5 rounded-xl bg-brand-50 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400 border border-brand-100 dark:border-brand-900/40">
                  <Camera className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-extrabold text-xs text-slate-900 dark:text-white leading-snug">{t('scanCameraOption', undefined, 'Scan Receipt Camera')}</h4>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 font-medium leading-none mt-0.5">{t('scanCameraDesc', undefined, 'Snap a photo of the bill instantly')}</p>
                </div>
              </button>

              {/* Option 2: Upload Photo */}
              <button
                onClick={() => {
                  setShowStartSplitModal(false);
                  fileInputRef.current?.click();
                }}
                className="w-full p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 hover:border-brand-500/50 hover:bg-brand-50/50 dark:hover:bg-brand-950/20 transition-all flex items-center gap-3.5 text-left active:scale-[0.98]"
              >
                <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                  <Upload className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-extrabold text-xs text-slate-900 dark:text-white leading-snug">{t('uploadPhotoOption', undefined, 'Upload Image from Gallery')}</h4>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 font-medium leading-none mt-0.5">{t('uploadPhotoDesc', undefined, 'Select a receipt screenshot or photo')}</p>
                </div>
              </button>

              {/* Option 3: Manual Split */}
              <button
                onClick={() => {
                  setShowStartSplitModal(false);
                  setPendingReceiptDraft(null);
                  setPendingScanId('');
                  setEditingBill(null);
                  setShowCreateBillModal(true);
                }}
                className="w-full p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 hover:border-brand-500/50 hover:bg-brand-50/50 dark:hover:bg-brand-950/20 transition-all flex items-center gap-3.5 text-left active:scale-[0.98]"
              >
                <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                  <FilePlus className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-extrabold text-xs text-slate-900 dark:text-white leading-snug">{t('manualSplitOption', undefined, 'Create Bill Manually')}</h4>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 font-medium leading-none mt-0.5">{t('manualSplitDesc', undefined, 'Type in the items and prices yourself')}</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header Bar */}
      <header className="flex items-center justify-between py-2 border-b border-slate-200/80 dark:border-slate-800">
        <button
          onClick={() => router.push('/')}
          className="w-10 h-10 rounded-full bg-white dark:bg-brand-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center transition-colors shadow-xs active:scale-95"
        >
          <ChevronLeft className={`w-5 h-5 ${isRtl ? 'rotate-180' : ''}`} />
        </button>

        <div className="text-center">
          <h1 className="font-extrabold text-base text-slate-900 dark:text-white tracking-tight">{group.name}</h1>
          <button
            onClick={() => setShowQrModal(true)}
            className="inline-flex items-center gap-1 text-xs font-mono text-brand-600 dark:text-brand-400 font-bold hover:underline"
            title="Tap to Share Group"
          >
            <QrCode className="w-3 h-3" />
            <span>#{group.code}</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="w-9 h-9 rounded-full bg-white dark:bg-brand-900 border border-slate-200 dark:border-slate-800 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shadow-xs"
            title="Toggle Theme"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-700" />}
          </button>

          <button
            onClick={() => setShowQrModal(true)}
            className="brand-tap py-1.5 px-3 rounded-full bg-brand-600 hover:bg-brand-700 dark:bg-brand-300 dark:text-brand-950 text-white flex items-center gap-1.5 transition-all shadow-brand font-bold text-xs"
            title="Share Group"
          >
            <Share2 className="w-3.5 h-3.5" />
            <span>{t('shareBtn', undefined, 'Share')}</span>
          </button>

          <button
            onClick={async () => {
              const confirmation = isGroupHost
                ? t('confirmDeleteGroup', undefined, 'Delete this group and all of its active bill rooms?')
                : t('confirmLeaveGroup', undefined, 'Are you sure you want to leave this group?');
              if (confirm(confirmation)) {
                try {
                  const res = await fetch(`/api/groups/${group.id}${isGroupHost ? '' : '/leave'}`, {
                    method: isGroupHost ? 'DELETE' : 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      ...roomHeaders('group', group.id, !isGroupHost),
                    },
                    body: isGroupHost ? undefined : JSON.stringify({
                      memberId: currentMemberId,
                      name: profile?.displayName || '',
                    }),
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || 'Could not leave group');

                  // Add to deleted group IDs so it never re-appears in active groups
                  const localDeleted = localStorage.getItem('billsplit_deleted_group_ids');
                  const deletedIds = localDeleted ? JSON.parse(localDeleted) : [];
                  if (!deletedIds.includes(group.id)) {
                    deletedIds.push(group.id);
                    localStorage.setItem('billsplit_deleted_group_ids', JSON.stringify(deletedIds));
                  }

                  const cookieGroups = getCookie('billsplit_user_groups');
                  const localGroups = localStorage.getItem('billsplit_user_groups');
                  const rawGroups = cookieGroups || (localGroups ? JSON.parse(localGroups) : []);
                  const updated = Array.isArray(rawGroups) ? rawGroups.filter((g: any) => g.id !== group.id) : [];
                  setCookie('billsplit_user_groups', updated);
                  localStorage.setItem('billsplit_user_groups', JSON.stringify(updated));

                  const userKey = (profile?.displayName || '').trim();
                  if (userKey) {
                    localStorage.setItem(`billsplit_user_groups_${userKey}`, JSON.stringify(updated));
                    localStorage.setItem(`billsplit_user_groups_${userKey.toLowerCase()}`, JSON.stringify(updated));
                  }

                  clearRoomCredentials('group', group.id);
                  router.push('/');

                } catch (err) {
                  alert(err instanceof Error ? err.message : 'Could not leave group');
                }
              }
            }}
            className="w-9 h-9 rounded-full bg-rose-50 dark:bg-rose-950/40 text-rose-500 hover:bg-rose-100 dark:hover:bg-rose-900/60 border border-rose-200 dark:border-rose-800/60 flex items-center justify-center transition-colors shadow-xs active:scale-95"
            title={isGroupHost ? 'Delete Group' : 'Leave Group'}
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Action Header Card — Add Bill to Group */}
      <div className="relative overflow-hidden rounded-[24px] p-5 bg-gradient-to-br from-brand-500 via-brand-700 to-brand-950 text-white border border-brand-700 shadow-brand space-y-4">
        <div className="brand-peach-glow absolute -top-16 -right-10 h-52 w-52 rounded-full opacity-70" aria-hidden="true" />
        <div className="flex items-center justify-between">
          <span className="px-2.5 py-0.5 rounded-full bg-brand-500/20 text-brand-300 border border-brand-500/30 text-[10px] font-extrabold uppercase tracking-wider">
            {t('tripExpenseTracker', undefined, 'Group Expense Tracker')}
          </span>
          <Sparkles className="w-4 h-4 text-brand-400" />
        </div>

        <div>
          <h2 className="text-lg font-black text-white tracking-tight leading-snug">
            {t('addBillsToGroup', { groupName: group.name }, `Add Bills to ${group.name}`)}
          </h2>
        </div>

        <div className="pt-1">
          <input
            type="file"
            ref={cameraInputRef}
            accept="image/*"
            capture="environment"
            onChange={handlePhotoUpload}
            className="hidden"
          />

          <button
            onClick={() => {
              setShowStartSplitModal(true);
              triggerHaptic('medium');
            }}
            className="w-full py-3.5 px-6 rounded-full bg-white hover:bg-slate-100 text-slate-950 font-black text-xs shadow-md active:scale-[0.98] transition-all flex items-center justify-center gap-2"
          >
            <Sparkles className="w-4 h-4 text-brand-600" />
            <span>{t('startSplitBtn', undefined, 'Start Split')}</span>
          </button>
        </div>
      </div>

      {/* SECTION 1: DEBT MINIMIZATION SUMMARY */}
      <div className="rounded-[24px] p-4 bg-white dark:bg-brand-950 border border-slate-200/80 dark:border-slate-800 shadow-sm space-y-3">
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-2">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-brand-50 dark:bg-brand-950/50 text-brand-600 dark:text-brand-400">
              <Users className="w-4 h-4" />
            </div>
            <h3 className="font-extrabold text-xs text-slate-900 dark:text-white">
              {t('debtMinimizationTitle', undefined, 'Debt Minimization Settlement')}
            </h3>
          </div>
        </div>

        {/* Member Avatars Live Net Balance Badges */}
        <div className="space-y-1.5">
          <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 block">
            {t('memberNetBalances', undefined, 'MEMBER NET BALANCES')}
          </span>
          <div className="grid grid-cols-2 gap-2.5 pt-0.5">
            {balances.map((b: any) => {
              const isCreditor = b.netBalance > 0.01;
              const isDebtor = b.netBalance < -0.01;

              return (
                <div
                  key={b.memberId}
                  className="flex items-center gap-2.5 p-3 rounded-2xl bg-slate-50 dark:bg-[#131B2A] border border-slate-200/80 dark:border-slate-800/80 shadow-xs transition-all duration-200"
                >
                  <div className="w-9 h-9 rounded-full flex items-center justify-center bg-white dark:bg-[#1B263B] text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 shrink-0 font-bold text-xs shadow-xs">
                    {(b.name || 'M').substring(0, 2).toUpperCase()}
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-black text-slate-900 dark:text-white leading-tight truncate">
                      {b.name}
                    </span>
                    <span
                      className={`text-[10px] font-extrabold font-mono mt-1 px-1.5 py-0.5 rounded-md leading-none border w-max ${
                        isCreditor
                          ? 'bg-mint-500/10 text-mint-600 dark:text-mint-400 border-mint-500/20'
                          : isDebtor
                          ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20'
                          : 'bg-slate-200/60 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-transparent'
                      }`}
                    >
                      {isCreditor ? `+${formatCurrency(b.netBalance, group.currency || 'NIS')}` : isDebtor ? `-${formatCurrency(Math.abs(b.netBalance), group.currency || 'NIS')}` : formatCurrency(0, group.currency || 'NIS')}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Minimized Transactions List */}
        {minimizedTransactions.length === 0 ? (
          <div className="flex items-center justify-center gap-1.5 text-xs text-slate-400 font-medium text-center py-2">
            {unassignedAmount > 0 ? (
              <span>{t('assignItemsToCalculate', undefined, 'Claim the remaining items to complete the settlement calculation.')}</span>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4 text-mint-500" />
                <span>{t('allExpensesSettled', undefined, 'All group expenses are settled! No debts owed.')}</span>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-1.5 pt-0.5">
            {minimizedTransactions.map((tx: any, idx: number) => {
              const canPayTransaction = tx.fromId === currentMemberId && Number(tx.amount) > 0;
              const paymentKey = `${tx.fromId}:${tx.toId}`;
              const fetchPaymentTarget = async () => {
                try {
                  const response = await fetch(
                    `/api/groups/${encodeURIComponent(group.id)}/payment-target/${encodeURIComponent(tx.toId)}`,
                    { headers: roomHeaders('group', group.id, false) },
                  );
                  const data = await response.json().catch(() => ({}));
                  const phone = cleanIsraeliPhone(data.phone || '');
                  const amount = Number(data.amount);
                  if (!response.ok || !isValidIsraeliPhone(phone) || !Number.isFinite(amount) || amount <= 0) {
                    alert(t('payerPhoneNotSetNote', { name: tx.toName }, `${tx.toName} has not added a valid payment phone number yet.`));
                    return null;
                  }
                  return { phone, amount };
                } catch (error) {
                  console.error('Payment target lookup failed:', error);
                  alert(t('payerPhoneNotSetNote', { name: tx.toName }, `${tx.toName} has not added a valid payment phone number yet.`));
                  return null;
                }
              };

              const handleOpenBit = async () => {
                if (paymentLookupRef.current) return;
                paymentLookupRef.current = true;
                setPaymentLookupKey(paymentKey);
                try {
                  const target = await fetchPaymentTarget();
                  if (!target) return;
                  triggerBitPayment({
                    phone: target.phone,
                    amount: target.amount,
                    title: `Settlement to ${tx.toName} (${group.name})`
                  });
                } finally {
                  paymentLookupRef.current = false;
                  setPaymentLookupKey('');
                }
              };

              const handleOpenPaybox = async () => {
                if (paymentLookupRef.current) return;
                paymentLookupRef.current = true;
                setPaymentLookupKey(paymentKey);
                try {
                  const target = await fetchPaymentTarget();
                  if (!target) return;
                  const amt = target.amount.toFixed(2);
                  try {
                    navigator.clipboard.writeText(`${target.phone} ${amt}`);
                  } catch (e) {}
                  alert(`Opening Paybox!\nRecipient: ${tx.toName} (${target.phone})\nAmount: ${formatCurrency(target.amount, group.currency || 'NIS')}\n(Copied to clipboard 📋)`);
                  const isMobile = typeof window !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
                  if (isMobile) {
                    window.location.href = `paybox://pay?phone=${target.phone}&amount=${amt}`;
                    setTimeout(() => {
                      window.open(`https://payboxapp.page.link/pay?phone=${target.phone}&amount=${amt}`, '_blank');
                    }, 800);
                  } else {
                    window.open(`https://payboxapp.page.link/pay?phone=${target.phone}&amount=${amt}`, '_blank');
                  }
                } finally {
                  paymentLookupRef.current = false;
                  setPaymentLookupKey('');
                }
              };

              return (
                <div
                  key={idx}
                  className="p-2.5 rounded-xl bg-slate-50 dark:bg-[#131B2A] border border-slate-200/80 dark:border-slate-800/80 flex items-center justify-between"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 text-xs font-bold">
                      <span className="text-rose-500 font-extrabold">{tx.fromName}</span>
                      <ArrowRight className="w-3 h-3 text-slate-400" />
                      <span className="text-slate-900 dark:text-white font-extrabold">{tx.toName}</span>
                    </div>
                    <span className="text-xs font-mono font-black text-slate-900 dark:text-white block">
                      {formatCurrency(tx.amount || 0, group.currency || 'NIS')}
                    </span>
                  </div>

                  {/* Payment settlement quick actions */}
                  {canPayTransaction && (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={handleOpenBit}
                        disabled={Boolean(paymentLookupKey)}
                        className="py-1 px-2.5 rounded-lg bg-[#7026FF] hover:bg-[#5C1FD4] text-white font-extrabold text-[10px] shadow-xs active:scale-95 transition-transform disabled:cursor-wait disabled:opacity-50"
                      >
                        Bit
                      </button>
                      <button
                        onClick={handleOpenPaybox}
                        disabled={Boolean(paymentLookupKey)}
                        className="py-1 px-2.5 rounded-lg bg-[#005082] hover:bg-[#003E66] text-white font-extrabold text-[10px] shadow-xs active:scale-95 transition-transform disabled:cursor-wait disabled:opacity-50"
                      >
                        Paybox
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* SECTION 2: PAST BILLS TIMELINE & INTERACTIVE CLAIMING */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-extrabold text-sm text-slate-900 dark:text-white flex items-center gap-2">
            <FileText className="w-4 h-4 text-brand-500" />
            <span>{t('groupPastBills', { n: validBills.length }, `Group Past Bills (${validBills.length})`)}</span>
          </h2>
          <span className="text-[11px] text-slate-400 font-medium">{t('tapPastBillNotice', undefined, 'Tap past bill to claim items')}</span>
        </div>

        {validBills.length === 0 ? (
          <div className="rounded-[24px] p-6 bg-white dark:bg-brand-950 border border-slate-200/80 dark:border-slate-800 text-center text-slate-400 space-y-2 shadow-xs">
            <FileText className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-1" />
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {t('noBillsYetGroup', undefined, 'No bills added to this group yet. Use the buttons above to scan or create a bill!')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {validBills.map((bill: any) => {
              const isExpanded = expandedBillId === bill.id;
              const activePayerMember = validMembers.find((m: any) => 
                m.id === bill.payerId || 
                (m.name && bill.payerId && m.name.trim().toLowerCase() === String(bill.payerId).trim().toLowerCase())
              ) || validMembers[0];
              const payerName = activePayerMember?.name || 'Group Member';
              const itemsList = Array.isArray(bill.items) ? bill.items : [];
              const isPaymentLocked = bill.status === 'settled'
                || (Array.isArray(bill.settledMemberIds) && bill.settledMemberIds.length > 0);
              const canManageBill = !isPaymentLocked && (isGroupHost || bill.createdByMemberId === currentMemberId);

              const handleToggleItemClaim = (itemId: string, memberIdToToggle: string, claimed: boolean) => {
                if (isPaymentLocked || memberIdToToggle !== currentMemberId) return;
                sendGroupBillAction('TOGGLE_CLAIM', { billId: bill.id, itemId, claimed });
              };

              const handleSetPayer = (newPayerId: string) => {
                sendGroupBillAction('SET_PAYER', { billId: bill.id, payerId: newPayerId });
              };

              const handleSplitAllItems = () => {
                sendGroupBillAction('SPLIT_ALL', { billId: bill.id });
              };

              return (
                <SwipeableCard
                  key={bill.id}
                  onDelete={() => isPaymentLocked ? false : handleDeleteBill(bill.id)}
                  className="shadow-xs"
                >
                  <div
                    className="rounded-[20px] bg-white dark:bg-brand-950 border border-slate-200/80 dark:border-slate-800 overflow-hidden transition-all shadow-xs"
                  >
                    <div
                      onClick={() => setExpandedBillId(isExpanded ? null : bill.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setExpandedBillId(isExpanded ? null : bill.id);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-expanded={isExpanded}
                      className="p-4 space-y-3 cursor-pointer hover:bg-slate-50/50 dark:hover:bg-[#131B2A]/50 transition-colors"
                    >
                      {/* Row 1: Title & Total Amount */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-0.5 min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {isPaymentLocked ? (
                              <span className="w-2 h-2 rounded-full bg-mint-500 shrink-0" />
                            ) : (
                              <span className="w-2 h-2 rounded-full bg-brand-500 animate-pulse shrink-0" />
                            )}
                            <h4 className="font-extrabold text-slate-900 dark:text-white text-xs leading-tight truncate">
                              {bill.title}
                            </h4>
                          </div>
                          <p className="text-[10px] text-slate-500 dark:text-slate-400 font-medium leading-tight">
                            {bill.date} • {t('paidByLabel', { name: payerName }, `Paid by ${payerName}`)}
                          </p>
                        </div>

                        <div className="shrink-0 text-right">
                          <span className="font-mono font-black text-slate-900 dark:text-white text-xs">
                            {formatCurrency(bill.amount || 0, group.currency || 'NIS')}
                          </span>
                        </div>
                      </div>

                      {/* Row 2: Bigger Centered Live Session Button */}
                      <div className="pt-0.5 flex items-center justify-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            const targetSessionId = bill.sessionId || `sess_g_${bill.id}`;
                            saveRoomCredentials('session', targetSessionId, currentMemberId, getRoomToken('group', group.id));
                            router.push(`/session/${targetSessionId}?groupId=${group.id}`);
                          }}
                          className="w-full py-2.5 px-4 rounded-xl bg-slate-950 hover:bg-slate-900 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-100 text-white font-extrabold text-xs shadow-xs transition-all flex items-center justify-center gap-2 active:scale-[0.98]"
                          title="Open Live Claiming Session"
                        >
                          <Sparkles className="w-3.5 h-3.5 text-brand-400 dark:text-brand-600" />
                          <span>{t('liveSessionBtn', undefined, 'Live Session')}</span>
                          <ArrowRight className={`w-3.5 h-3.5 ${isRtl ? 'rotate-180' : ''}`} />
                        </button>
                      </div>
                    </div>

                    {/* Expanded Interactive Item Claiming & Payer Selector */}
                    {isExpanded && (
                      <div className="p-3 bg-slate-50/80 dark:bg-[#131B2A]/60 border-t border-slate-100 dark:border-slate-800 space-y-2.5 text-xs">
                        {/* Payer Selector & Edit Action */}
                        <div className="flex items-center justify-between bg-white dark:bg-[#1A2333] p-2 rounded-xl border border-slate-200/80 dark:border-slate-700">
                          <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">{t('whoPaidUpfront', undefined, 'Who paid this bill upfront?')}</span>
                          <div className="flex items-center gap-1.5">
                            <select
                              value={activePayerMember?.id || validMembers[0]?.id}
                              onChange={(e) => handleSetPayer(e.target.value)}
                              disabled={!canManageBill}
                              className="py-1 px-2 rounded-lg bg-slate-100 dark:bg-slate-900 text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
                            >
                              {validMembers.map((m: any) => (
                                <option key={m.id} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                            </select>

                            {canManageBill && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPendingReceiptDraft(null);
                                  setPendingScanId('');
                                  setEditingBill(bill);
                                  setShowCreateBillModal(true);
                                }}
                                className="p-1 rounded-lg text-slate-500 hover:text-brand-600 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                                title="Edit Bill Details"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center justify-between">
                          <span className="font-extrabold uppercase text-[10px] text-slate-400 tracking-wider">
                            {t('tapMemberChipNotice', undefined, 'Tap member chip on an item to claim item share:')}
                          </span>
                          {canManageBill && (
                            <button
                              onClick={handleSplitAllItems}
                              className="px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-800 text-[10px] font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-300 transition-colors"
                            >
                              {t('splitAllEqually', undefined, 'Split All Equally')}
                            </button>
                          )}
                        </div>

                        {/* Items List with Interactive Member Claim Chips */}
                        <div className="space-y-2">
                          {itemsList.map((item: any) => {
                            const itemClaimants = Array.isArray(item.claimedBy) ? item.claimedBy : [];

                            return (
                              <div
                                key={item.id}
                                className="p-2.5 rounded-xl bg-white dark:bg-[#1A2333] border border-slate-200/80 dark:border-slate-700 space-y-2"
                              >
                                <div className="flex justify-between items-center text-slate-900 dark:text-white">
                                  <span className="font-bold">{item.name}</span>
                                  <span className="font-mono font-extrabold">{formatCurrency(item.price || 0, group.currency || 'NIS')}</span>
                                </div>

                                {/* Member Claim Chips */}
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {validMembers.map((m: any) => {
                                    const isClaimed = itemClaimants.includes(m.id);
                                    const isMe = m.id === currentMemberId;

                                    return (
                                      <button
                                        key={m.id}
                                        onClick={() => handleToggleItemClaim(item.id, m.id, !isClaimed)}
                                        disabled={!isMe || isPaymentLocked}
                                        className={`px-2.5 py-1 rounded-full text-[10px] font-extrabold flex items-center gap-1 transition-all ${
                                          isClaimed
                                            ? 'bg-brand-600 dark:bg-brand-300 text-white dark:text-brand-950 shadow-xs'
                                            : 'bg-slate-100 dark:bg-slate-900 text-slate-500 border border-slate-200 dark:border-slate-700 hover:bg-slate-200'
                                        } ${!isMe ? 'cursor-default opacity-70' : ''}`}
                                      >
                                        <span>{m.name}</span>
                                        {isClaimed && <CheckCircle2 className="w-3 h-3 text-mint-400 dark:text-mint-600" />}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </SwipeableCard>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
