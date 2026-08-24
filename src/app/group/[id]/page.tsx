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
import { apiUrl, realtimeUrl } from '../../../../lib/platformTransport';

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
      if (String(grp.status || '').toLowerCase() === 'closed') {
        const updated = list.filter((g: any) => g.id !== grp.id);
        setCookie('billsplit_user_groups', updated);
        localStorage.setItem('billsplit_user_groups', JSON.stringify(updated));
        const rawName = (profile?.displayName || '').trim();
        const userKey = rawName.toLowerCase();
        if (rawName) localStorage.setItem(`billsplit_user_groups_${rawName}`, JSON.stringify(updated));
        if (userKey) localStorage.setItem(`billsplit_user_groups_${userKey}`, JSON.stringify(updated));
        return;
      }

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
        const initialRes = await fetch(apiUrl(`/api/groups/${groupId}`), { headers: roomHeaders('group', groupId, false) });
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

        const joinRes = await fetch(apiUrl('/api/groups/join'), {
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
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) socket.close();
    };
  }, [groupId, profile.displayName, profile.phoneNumber]);

  const fetchGroupData = async (id: string) => {
    try {
      const res = await fetch(apiUrl(`/api/groups/${id}`), { headers: roomHeaders('group', id, false) });
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
      if (socketRef.current) {
        try { socketRef.current.close(); } catch (_) {}
      }
      const ws = new WebSocket(realtimeUrl());
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
            socketRef.current = null;
            try { ws.close(); } catch (_) {}
            clearRoomCredentials('group', id);
            router.push('/');
          }
        } catch (e) {
          console.error(e);
        }
      };

      ws.onclose = () => {
        setTimeout(() => {
          if (socketRef.current === ws) connectWebSocket(id, accessToken);
        }, 2500);
      };
      ws.onerror = () => {
        try { ws.close(); } catch (_) {}
      };
    } catch (err) {
      console.error('WebSocket connection error:', err);
    }
  };

  const handleAddBillToGroup = async (billData: { title: string; currency: string; items: any[]; payerId?: string; amount?: number; id?: string; date?: string; receipt?: any; scanId?: string; confirmedByUser?: boolean }) => {
    if (!group) return;

    try {
      const res = await fetch(apiUrl('/api/groups/bill'), {
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
      const res = await fetch(apiUrl(`/api/groups/bill/${resolvedId}/${billId}`), {
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
      const res = await fetch(apiUrl('/api/groups/bill/action'), {
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
      return true;
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not update bill');
      return false;
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
  const isGroupBalanceConsistent = group?.isBalanced !== false;
  const isGroupHost = Boolean(validMembers.find((member: any) => member.id === currentMemberId)?.isHost);
  const groupStatus = String(group?.status || 'active').toLowerCase();
  const isGroupActive = groupStatus === 'active';
  const isGroupSettling = groupStatus === 'settling';
  const isGroupClosed = groupStatus === 'closed';
  const settlement = group?.settlement && typeof group.settlement === 'object' ? group.settlement : null;
  const settlementTransfers = Array.isArray(settlement?.transfers) ? settlement.transfers : [];
  const displayBalances = (isGroupSettling || isGroupClosed) && Array.isArray(settlement?.balances)
    ? settlement.balances
    : balances;
  const liveTransactions = minimizedTransactions;
  const financiallyOpenBills = validBills.filter((bill: any) => {
    const status = String(bill?.status || '').toLowerCase();
    return !status || status === 'active' || status === 'finalized';
  });
  const allOpenSplitsFinalized = financiallyOpenBills.length > 0
    && financiallyOpenBills.every((bill: any) => String(bill?.status || '').toLowerCase() === 'finalized');
  const totalGroupSpent = validBills.reduce((sum: number, bill: any) => sum + (Number(bill?.amount) || 0), 0);

  const openGroupTransferPayment = async (tx: any, method: 'bit' | 'paybox') => {
    if (!group?.id || tx?.paid || paymentLookupRef.current) return;
    paymentLookupRef.current = true;
    const paymentKey = `${tx.fromId}:${tx.toId}`;
    setPaymentLookupKey(paymentKey);
    try {
      const response = await fetch(
        apiUrl(`/api/groups/${encodeURIComponent(group.id)}/payment-target/${encodeURIComponent(tx.toId)}`),
        { headers: roomHeaders('group', group.id, false) },
      );
      const data = await response.json().catch(() => ({}));
      const phone = cleanIsraeliPhone(data.phone || '');
      const amount = Number(data.amount);
      if (!response.ok || !isValidIsraeliPhone(phone) || !Number.isFinite(amount) || amount <= 0) {
        alert(isRtl ? 'למקבל עדיין אין מספר טלפון תקין לתשלום.' : 'The recipient does not have a valid payment phone number yet.');
        return;
      }
      if (method === 'bit') {
        triggerBitPayment({ phone, amount, title: `${group.name} settlement` });
        return;
      }
      const formattedAmount = amount.toFixed(2);
      try { await navigator.clipboard.writeText(`${phone} ${formattedAmount}`); } catch (_) {}
      const isMobile = typeof window !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      if (isMobile) {
        window.location.href = `paybox://pay?phone=${phone}&amount=${formattedAmount}`;
        setTimeout(() => {
          window.open(`https://payboxapp.page.link/pay?phone=${phone}&amount=${formattedAmount}`, '_blank');
        }, 800);
      } else {
        window.open(`https://payboxapp.page.link/pay?phone=${phone}&amount=${formattedAmount}`, '_blank');
      }
    } finally {
      paymentLookupRef.current = false;
      setPaymentLookupKey('');
    }
  };

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

        <div className="text-center min-w-0 px-2">
          <h1 className="font-extrabold text-base text-slate-900 dark:text-white tracking-tight truncate">{group.name}</h1>
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
                  const res = await fetch(apiUrl(`/api/groups/${group.id}${isGroupHost ? '' : '/leave'}`), {
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

      {/* Group Overview — keep the same visual language, but lead with the event instead of debt math. */}
      <div className="relative overflow-hidden rounded-[24px] p-5 bg-gradient-to-br from-brand-500 via-brand-700 to-brand-950 text-white border border-brand-700 shadow-brand space-y-4">
        <div className="brand-peach-glow absolute -top-16 -right-10 h-52 w-52 rounded-full opacity-70" aria-hidden="true" />
        <div className="relative z-10 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-extrabold uppercase tracking-wider text-white/65">
              {isGroupClosed ? (isRtl ? 'קבוצה שהסתיימה' : 'Closed group') : isGroupSettling ? (isRtl ? 'התחשבנות סופית' : 'Final settlement') : (isRtl ? 'קבוצה פעילה' : 'Active group')}
            </p>
            <h2 className="text-2xl font-black text-white tracking-tight leading-tight mt-1">{formatCurrency(totalGroupSpent, group.currency || 'NIS')}</h2>
          </div>
          <div className="shrink-0 rounded-2xl bg-white/10 border border-white/15 px-3 py-2 text-center">
            <span className="block text-base font-black">{validBills.length}</span>
            <span className="block text-[9px] font-bold text-white/60">{isRtl ? 'חלוקות' : 'splits'}</span>
          </div>
        </div>

        <div className="relative z-10 flex items-center gap-2 text-[10px] font-bold text-white/75">
          <span>{validMembers.length} {isRtl ? 'משתתפים' : 'members'}</span>
          {isGroupSettling && Number(settlement?.paymentsRemaining || 0) > 0 && <><span>•</span><span>{settlement.paymentsRemaining} {isRtl ? 'תשלומים נותרו' : 'payments left'}</span></>}
        </div>

        {isGroupActive && (
          <button
            type="button"
            onClick={() => {
              setShowStartSplitModal(true);
              triggerHaptic('medium');
            }}
            className="relative z-10 w-full py-3.5 px-6 rounded-full bg-white hover:bg-slate-100 text-slate-950 font-black text-xs shadow-md active:scale-[0.98] transition-all flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4 text-brand-600" />
            <span>{isRtl ? 'חלוקה חדשה' : 'New Split'}</span>
          </button>
        )}

        {isGroupClosed && (
          <div className="relative z-10 flex items-center justify-center gap-2 rounded-xl bg-mint-400/15 border border-mint-300/20 py-2.5 text-xs font-black text-mint-100">
            <CheckCircle2 className="w-4 h-4" />
            <span>{isRtl ? 'הקבוצה נסגרה והתשלומים הושלמו' : 'Group closed and payments completed'}</span>
          </div>
        )}
      </div>

      {/* Splits — the group is an overview; item claiming stays in the live Split screen. */}
      <section className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h2 className="font-extrabold text-sm text-slate-900 dark:text-white flex items-center gap-2">
            <FileText className="w-4 h-4 text-brand-500" />
            <span>{isRtl ? `חלוקות (${validBills.length})` : `Splits (${validBills.length})`}</span>
          </h2>
          {isGroupActive && <span className="text-[10px] text-slate-400 font-semibold">{isRtl ? 'פתחו חלוקה כדי לבחור פריטים' : 'Open a split to claim items'}</span>}
        </div>

        {validBills.length === 0 ? (
          <div className="rounded-[24px] p-6 bg-white dark:bg-brand-950 border border-slate-200/80 dark:border-slate-800 text-center space-y-2 shadow-xs">
            <FileText className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600" />
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {isRtl ? 'עוד אין חלוקות בקבוצה. התחילו מהכפתור למעלה.' : 'No splits yet. Start the first one from the button above.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {validBills.map((bill: any) => {
              const rawStatus = String(bill?.status || 'active').toLowerCase();
              const billStatus = rawStatus === 'finalized' ? 'finalized' : rawStatus === 'active' ? 'active' : 'settled';
              const payer = validMembers.find((member: any) => member.id === bill.payerId) || validMembers[0];
              const canManageBill = isGroupActive && (isGroupHost || bill.createdByMemberId === currentMemberId);
              const hasLegacyPaidMembers = Array.isArray(bill.settledMemberIds) && bill.settledMemberIds.length > 0;
              const targetSessionId = bill.sessionId || `sess_g_${bill.id}`;
              const openLiveSplit = () => {
                saveRoomCredentials('session', targetSessionId, currentMemberId, getRoomToken('group', group.id));
                router.push(`/session/${targetSessionId}?groupId=${group.id}`);
              };

              const card = (
                <div className="rounded-[20px] bg-white dark:bg-brand-950 border border-slate-200/80 dark:border-slate-800 p-4 shadow-xs space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${billStatus === 'active' ? 'bg-brand-500' : billStatus === 'finalized' ? 'bg-amber-400' : 'bg-mint-500'}`} />
                          <h3 className="font-extrabold text-sm text-slate-900 dark:text-white truncate">{bill.title}</h3>
                        </div>
                        <p className="text-[10px] text-slate-500 dark:text-slate-400 font-medium mt-1">
                          {bill.date} · {isRtl ? 'שולם ע״י' : 'Paid by'} {payer?.name || (isRtl ? 'חבר בקבוצה' : 'Group member')}
                        </p>
                      </div>
                      <span className="font-mono font-black text-sm text-slate-900 dark:text-white shrink-0">
                        {formatCurrency(Number(bill.amount || 0), group.currency || 'NIS')}
                      </span>
                    </div>

                    {billStatus === 'active' && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={openLiveSplit}
                          className="flex-1 py-2.5 px-4 rounded-xl bg-slate-950 hover:bg-slate-900 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-100 text-white font-extrabold text-xs shadow-xs transition-all flex items-center justify-center gap-2 active:scale-[0.98]"
                        >
                          <span>{isRtl ? 'המשך חלוקה' : 'Continue Split'}</span>
                          <ArrowRight className={`w-3.5 h-3.5 ${isRtl ? 'rotate-180' : ''}`} />
                        </button>
                        {canManageBill && !hasLegacyPaidMembers && (
                          <button
                            type="button"
                            onClick={async () => {
                              const ok = await sendGroupBillAction('FINALIZE_BILL', { billId: bill.id });
                              if (ok) triggerHaptic('success');
                            }}
                            className="py-2.5 px-3.5 rounded-xl bg-brand-50 dark:bg-brand-900 text-brand-700 dark:text-brand-200 border border-brand-100 dark:border-brand-800 font-extrabold text-[10px] active:scale-95 transition-all"
                          >
                            {isRtl ? 'סיים חלוקה' : 'Finish Split'}
                          </button>
                        )}
                      </div>
                    )}

                    {billStatus === 'active' && hasLegacyPaidMembers && (
                      <p className="text-[10px] font-bold text-amber-600 dark:text-amber-300">
                        {isRtl ? 'יש סימוני תשלום ישנים בחלוקה הזו. פתחו אותה ובטלו אותם לפני סיום החלוקה.' : 'This split has legacy paid markers. Open it and reopen those shares before finishing the split.'}
                      </p>
                    )}

                    {billStatus === 'finalized' && (
                      <div className="flex items-center justify-between gap-2 rounded-xl bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200/70 dark:border-amber-900/40 px-3 py-2">
                        <span className="inline-flex items-center gap-1.5 text-[10px] font-black text-amber-700 dark:text-amber-300 min-w-0">
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{isRtl ? 'החלוקה הסתיימה ונכללת במאזן' : 'Split complete · included in group balance'}</span>
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <button type="button" onClick={openLiveSplit} className="text-[10px] font-extrabold text-slate-600 dark:text-slate-300 hover:text-brand-600">
                            {isRtl ? 'צפה' : 'View'}
                          </button>
                          {canManageBill && (
                            <button
                              type="button"
                              onClick={() => sendGroupBillAction('REOPEN_BILL', { billId: bill.id })}
                              className="text-[10px] font-extrabold text-slate-600 dark:text-slate-300 hover:text-brand-600"
                            >
                              {isRtl ? 'פתח מחדש' : 'Reopen'}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {billStatus === 'settled' && (
                      <div className="flex items-center justify-between gap-2">
                        <div className="inline-flex items-center gap-1.5 text-[10px] font-black text-mint-600 dark:text-mint-400">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>{isRtl ? 'שולם במסגרת הקבוצה' : 'Settled with the group'}</span>
                        </div>
                        <button type="button" onClick={openLiveSplit} className="text-[10px] font-extrabold text-slate-500 hover:text-brand-600">
                          {isRtl ? 'צפה' : 'View'}
                        </button>
                      </div>
                    )}
                </div>
              );

              return billStatus === 'active' && canManageBill ? (
                <SwipeableCard key={bill.id} onDelete={() => handleDeleteBill(bill.id)} className="shadow-xs">
                  {card}
                </SwipeableCard>
              ) : (
                <React.Fragment key={bill.id}>{card}</React.Fragment>
              );
            })}
          </div>
        )}
      </section>

      {/* Group Balance / Final Settlement — secondary to the splits, never the first thing users see. */}
      <section className="rounded-[24px] p-4 bg-white dark:bg-brand-950 border border-slate-200/80 dark:border-slate-800 shadow-sm space-y-3">
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-2">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-brand-50 dark:bg-brand-900 text-brand-600 dark:text-brand-300">
              <Users className="w-4 h-4" />
            </div>
            <h3 className="font-extrabold text-xs text-slate-900 dark:text-white">
              {isGroupSettling || isGroupClosed ? (isRtl ? 'התחשבנות סופית' : 'Final Group Settlement') : (isRtl ? 'מאזן הקבוצה' : 'Group Balance')}
            </h3>
          </div>
          {(isGroupSettling || isGroupClosed) && settlement && (
            <span className="text-[9px] font-black text-slate-400">{settlement.paymentsRemaining || 0} {isRtl ? 'נותרו' : 'left'}</span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          {displayBalances.map((balance: any) => {
            const isCreditor = Number(balance.netBalance || 0) > 0.01;
            const isDebtor = Number(balance.netBalance || 0) < -0.01;
            return (
              <div key={balance.memberId} className="p-3 rounded-2xl bg-slate-50 dark:bg-[#131B2A] border border-slate-200/80 dark:border-slate-800/80 min-w-0">
                <span className="text-xs font-black text-slate-900 dark:text-white truncate block">{balance.name}</span>
                <span className={`text-[10px] font-extrabold font-mono mt-1 inline-block ${isCreditor ? 'text-mint-600 dark:text-mint-400' : isDebtor ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400'}`}>
                  {isCreditor ? '+' : isDebtor ? '-' : ''}{formatCurrency(Math.abs(Number(balance.netBalance || 0)), group.currency || 'NIS')}
                </span>
              </div>
            );
          })}
        </div>

        {isGroupActive && (
          <>
            {liveTransactions.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {liveTransactions.map((tx: any, index: number) => (
                  <div key={`${tx.fromId}:${tx.toId}:${index}`} className="flex items-center justify-between rounded-xl bg-slate-50 dark:bg-[#131B2A] border border-slate-200/80 dark:border-slate-800 px-3 py-2.5">
                    <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">{tx.fromName} → {tx.toName}</span>
                    <span className="text-xs font-black font-mono text-slate-900 dark:text-white">{formatCurrency(tx.amount || 0, group.currency || 'NIS')}</span>
                  </div>
                ))}
              </div>
            )}

            {unassignedAmount > 0.009 && (
              <p className="text-[10px] text-amber-600 dark:text-amber-300 font-bold text-center">
                {isRtl ? 'יש עדיין פריטים שלא נבחרו. השלימו את החלוקות לפני סגירת הקבוצה.' : 'Some items are still unassigned. Finish the splits before settling the group.'}
              </p>
            )}


            {!isGroupBalanceConsistent && (
              <p className="text-[10px] text-amber-600 dark:text-amber-300 font-bold text-center">
                {isRtl ? 'מאזן הקבוצה דורש בדיקה. ודאו שבכל חלוקה מוגדר מי שילם לפני סגירת הקבוצה.' : 'The group balance needs review. Check who paid each split before settling the group.'}
              </p>
            )}

            {isGroupHost && allOpenSplitsFinalized && unassignedAmount <= 0.009 && isGroupBalanceConsistent && (
              <button
                type="button"
                onClick={async () => {
                  const ok = await sendGroupBillAction('START_GROUP_SETTLEMENT', {});
                  if (ok) triggerHaptic('success');
                }}
                className="brand-tap w-full py-3.5 px-5 rounded-full bg-brand-600 hover:bg-brand-700 dark:bg-brand-300 dark:hover:bg-brand-200 text-white dark:text-brand-950 font-black text-xs shadow-brand transition-all active:scale-[0.98]"
              >
                {isRtl ? 'סגור קבוצה וחשב התחשבנות סופית' : 'Settle Group'}
              </button>
            )}

            {isGroupHost && financiallyOpenBills.length > 0 && !allOpenSplitsFinalized && (
              <p className="text-[10px] text-slate-400 font-semibold text-center">
                {isRtl ? 'סיימו את כל החלוקות הפעילות כדי לפתוח התחשבנות סופית.' : 'Finish every active split to start the final settlement.'}
              </p>
            )}
          </>
        )}

        {(isGroupSettling || isGroupClosed) && settlement && (
          <div className="space-y-2 pt-1">
            {settlementTransfers.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-2 text-xs font-bold text-mint-600 dark:text-mint-400">
                <CheckCircle2 className="w-4 h-4" />
                <span>{isRtl ? 'אין צורך בהעברות בין החברים' : 'No transfers needed'}</span>
              </div>
            ) : settlementTransfers.map((tx: any) => {
              const canPay = !isGroupClosed && !tx.paid && tx.fromId === currentMemberId;
              const canUpdate = !isGroupClosed && (isGroupHost || tx.fromId === currentMemberId || tx.toId === currentMemberId);
              const paymentKey = `${tx.fromId}:${tx.toId}`;
              return (
                <div key={tx.id} className="rounded-xl bg-slate-50 dark:bg-[#131B2A] border border-slate-200/80 dark:border-slate-800 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-bold min-w-0">
                      <span className="text-rose-500 font-extrabold">{tx.fromName}</span>
                      <span className="text-slate-400 mx-1.5">→</span>
                      <span className="text-slate-900 dark:text-white font-extrabold">{tx.toName}</span>
                    </div>
                    <span className="font-mono font-black text-xs text-slate-900 dark:text-white">{formatCurrency(tx.amount || 0, group.currency || 'NIS')}</span>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[9px] font-black ${tx.paid ? 'text-mint-600 dark:text-mint-400' : 'text-amber-600 dark:text-amber-300'}`}>
                      {tx.paid ? (isRtl ? 'שולם ✓' : 'Paid ✓') : (isRtl ? 'ממתין לתשלום' : 'Pending')}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {canPay && (
                        <>
                          <button disabled={Boolean(paymentLookupKey)} onClick={() => openGroupTransferPayment(tx, 'bit')} className="py-1.5 px-2.5 rounded-lg bg-[#7026FF] text-white font-extrabold text-[10px] disabled:opacity-50">Bit</button>
                          <button disabled={Boolean(paymentLookupKey)} onClick={() => openGroupTransferPayment(tx, 'paybox')} className="py-1.5 px-2.5 rounded-lg bg-[#005082] text-white font-extrabold text-[10px] disabled:opacity-50">Paybox</button>
                        </>
                      )}
                      {canUpdate && (
                        <button
                          type="button"
                          onClick={() => sendGroupBillAction('SET_GROUP_TRANSFER_PAID', { transferId: tx.id, paid: !tx.paid })}
                          className="py-1.5 px-2.5 rounded-lg bg-white dark:bg-brand-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 font-extrabold text-[10px]"
                        >
                          {tx.paid ? (isRtl ? 'בטל סימון' : 'Undo') : (isRtl ? 'סמן ששולם' : 'Mark paid')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {isGroupSettling && isGroupHost && !settlement.paymentActivityAt && (
              <button
                type="button"
                onClick={() => sendGroupBillAction('REOPEN_GROUP_SETTLEMENT', {})}
                className="w-full text-center text-[10px] font-extrabold text-slate-500 hover:text-brand-600 py-1"
              >
                {isRtl ? 'פתח את הקבוצה מחדש' : 'Reopen group'}
              </button>
            )}

            {isGroupSettling && isGroupHost && Number(settlement.paymentsRemaining || 0) === 0 && (
              <button
                type="button"
                onClick={async () => {
                  const ok = await sendGroupBillAction('CLOSE_GROUP', {});
                  if (ok) {
                    triggerHaptic('success');
                    router.push('/?tab=history');
                  }
                }}
                className="brand-tap w-full py-3.5 px-5 rounded-full bg-mint-500 hover:bg-mint-600 text-brand-950 font-black text-xs shadow-sm transition-all active:scale-[0.98]"
              >
                {isRtl ? 'סגור קבוצה' : 'Close Group'}
              </button>
            )}
          </div>
        )}
      </section>

    </div>
  );
}
