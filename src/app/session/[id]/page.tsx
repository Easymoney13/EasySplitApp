'use client';

import React, { useState, useEffect, useRef, useMemo, Suspense, Component, ErrorInfo, ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import confetti from 'canvas-confetti';
import {
  QrCode,
  Users,
  Plus,
  Zap,
  CheckCircle2,
  ChevronLeft,
  Sparkles,
  UserPlus,
  X,
  Sun,
  Moon,
  Utensils,
  GlassWater,
  Tag,
  ShoppingBag,
  Cookie,
  Check,
  RefreshCw,
  Pencil,
  Trash2,
  Link2,
  Share2,
  CreditCard,
  Loader2
} from 'lucide-react';
import { useLanguage } from '../../../components/LanguageContext';
import { QRCodeModal } from '../../../components/QRCodeModal';
import { AttachToGroupModal } from '../../../components/AttachToGroupModal';
import { ReceiptSkeleton } from '../../../components/SkeletonLoader';
import { getCookie, setCookie } from '../../../../lib/cookies';
import { isValidIsraeliPhone, triggerBitPayment } from '../../../../lib/bitDeepLink';
import { triggerHaptic } from '../../../../lib/haptics';
import { getRoomMemberId, getRoomToken, roomHeaders, saveRoomCredentials } from '../../../../lib/roomTokens';
import { getReceiptPayableTotal } from '../../../../lib/receiptMath';
import { allocateCentsProportionally, allocateTipAdjustedCents, splitCents, toCents } from '../../../../lib/debtMinimizer';
import { fetchPaginatedAccountData } from '../../../../lib/accountClient';

function createClientActionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `action_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class SessionErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false
  };

  public static getDerivedStateFromError(_: Error): ErrorBoundaryState {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Session ErrorBoundary caught an exception:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-white text-center space-y-4">
          <div className="p-4 rounded-full bg-brand-100 dark:bg-slate-800 text-brand-600 dark:text-brand-400">
            <Sparkles className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold">Session Workspace Ready</h2>
          <p className="text-xs text-slate-500 max-w-xs">
            Connecting to real-time session room... Click refresh to load workspace.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="py-3 px-6 photo-btn-indigo text-xs font-bold flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Reload Session</span>
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

function SessionWorkspaceInner() {
  const params = useParams();
  const router = useRouter();
  const sessionId = (params?.id as string) || '';

  const langCtx = useLanguage();
  const t = langCtx?.t || ((k: string, p?: any, d?: string) => d || k);
  const formatPrice = langCtx?.formatPrice || ((a: number) => `${a || 0}`);
  const formatDual = langCtx?.formatDual || ((a: number) => ({ primary: `${a || 0}` }));
  const profile = langCtx?.profile || { displayName: 'User', avatarColor: '#4DE1A1' };
  const isRtl = langCtx?.isRtl || false;
  const theme = langCtx?.theme || 'light';
  const setTheme = langCtx?.setTheme || (() => {});

  // Connection & state management
  const [session, setSession] = useState<any>(null);
  const [currentMemberId, setCurrentMemberId] = useState<string>('');
  
  // Modals & Triggers
  const [showAddItemModal, setShowAddItemModal] = useState<boolean>(false);
  const [showEditItemModal, setShowEditItemModal] = useState<boolean>(false);
  const [showSettleModal, setShowSettleModal] = useState<boolean>(false);
  const [showCompletionReaction, setShowCompletionReaction] = useState<boolean>(false);
  const [isRounded, setIsRounded] = useState<boolean>(false);
  const [showQrModal, setShowQrModal] = useState<boolean>(false);
  const [showAttachGroupModal, setShowAttachGroupModal] = useState<boolean>(false);
  const [userGroups, setUserGroups] = useState<any[]>([]);
  const [isSettling, setIsSettling] = useState<'idle' | 'loading' | 'success'>('idle');

  // Input states
  const [newItemName, setNewItemName] = useState('');
  const [newItemPrice, setNewItemPrice] = useState('');
  const [newItemCategory, setNewItemCategory] = useState('Food');

  const [editingItemId, setEditingItemId] = useState('');
  const [editItemName, setEditItemName] = useState('');
  const [editItemPrice, setEditItemPrice] = useState('');
  const [editItemCategory, setEditItemCategory] = useState('Food');
  const [tipPercentage, setTipPercentage] = useState<number>(0);
  const [customTipInput, setCustomTipInput] = useState<string>('');

  useEffect(() => {
    setTipPercentage(Number(session?.tipPercentage || 0));
  }, [session?.tipPercentage]);

  const handleBackNavigation = () => {
    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const targetGroupId = urlParams?.get('groupId') || session?.groupId;
    if (targetGroupId) {
      router.push(`/group/${targetGroupId}`);
    } else {
      router.push('/');
    }
  };

  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId || !profile.displayName) return;
    let disposed = false;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const initializeSession = async () => {
      try {
        const initialRes = await fetch(`/api/session/${sessionId}`, { headers: roomHeaders('session', sessionId, false) });
        if (initialRes.status === 404) {
          if (!disposed) setSessionNotFound(true);
          return;
        }
        const initialData = await initialRes.json();
        if (!initialRes.ok || !initialData.session) throw new Error(initialData.error || 'Could not load session');

        const resolvedId = initialData.session.id;
        const urlParams = new URLSearchParams(window.location.search);
        const linkedGroupId = urlParams.get('groupId') || initialData.session.groupId;
        const existingToken = getRoomToken('session', resolvedId)
          || (linkedGroupId ? getRoomToken('group', linkedGroupId) : '');
        if (existingToken && !getRoomToken('session', resolvedId)) {
          saveRoomCredentials('session', resolvedId, '', existingToken);
        }

        if (initialData.session.status === 'settled') {
          if (!disposed) setSession(initialData.session);
          return;
        }

        const joinRes = await fetch(`/api/session/${resolvedId}/join`, {
          method: 'POST',
          headers: roomHeaders('session', resolvedId),
          body: JSON.stringify({ name: profile?.displayName || 'Guest' }),
        });
        const joined = await joinRes.json();
        if (!joinRes.ok || !joined.session || !joined.accessToken) {
          throw new Error(joined.error || 'Could not join session');
        }
        saveRoomCredentials('session', resolvedId, joined.memberId, joined.accessToken);
        if (resolvedId !== sessionId) saveRoomCredentials('session', sessionId, joined.memberId, joined.accessToken);

        if (!disposed) {
          setCurrentMemberId(joined.memberId);
          setSession(joined.session);
          setSessionNotFound(false);
          connectWebSocket(resolvedId, joined.accessToken);
          pollInterval = setInterval(() => fetchSessionData(resolvedId), 15_000);
        }
      } catch (err) {
        console.error('Error initializing session:', err);
        if (!disposed) setSessionNotFound(true);
      }
    };

    initializeSession();

    // Load user groups from Cookie / LocalStorage
    const cookieGroups = getCookie('billsplit_user_groups');
    const localGroups = localStorage.getItem('billsplit_user_groups');
    const rawGroups = cookieGroups || (localGroups ? JSON.parse(localGroups) : []);
    if (Array.isArray(rawGroups)) {
      setUserGroups(rawGroups);
    }

    return () => {
      disposed = true;
      if (pollInterval) clearInterval(pollInterval);
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, [sessionId, profile.displayName]);

  useEffect(() => {
    if (!profile.displayName) {
      setUserGroups([]);
      return;
    }

    const queryParams = new URLSearchParams({
      userName: profile.displayName || '',
      phone: ''
    }).toString();

    fetchPaginatedAccountData('/api/user/groups', queryParams, 'groups')
      .then((groups) => {
        setUserGroups(groups);
      })
      .catch((err) => {
        console.error('Error fetching user groups:', err);
        // Fallback to local storage if offline/error
        const cookieGroups = getCookie('billsplit_user_groups');
        const localGroups = localStorage.getItem('billsplit_user_groups');
        const rawGroups = cookieGroups || (localGroups ? JSON.parse(localGroups) : []);
        if (Array.isArray(rawGroups)) {
          setUserGroups(rawGroups);
        }
      });
  }, [profile.displayName]);

  const handleAttachToGroup = async (targetGroupId: string) => {
    if (!session) return;
    try {
      const groupRes = await fetch(`/api/groups/${targetGroupId}`, { headers: roomHeaders('group', targetGroupId, false) });
      const groupData = await groupRes.json();
      if (!groupRes.ok || !groupData.group) throw new Error(groupData.error || 'Group not found');
      const resolvedGroupId = groupData.group.id;
      if (!getRoomToken('group', resolvedGroupId)) {
        const joinRes = await fetch('/api/groups/join', {
          method: 'POST',
          headers: roomHeaders('group', targetGroupId),
          body: JSON.stringify({ groupId: resolvedGroupId, name: profile.displayName || 'Member' }),
        });
        const joined = await joinRes.json();
        if (!joinRes.ok || !joined.accessToken) throw new Error(joined.error || 'Could not join group');
        saveRoomCredentials('group', resolvedGroupId, joined.memberId, joined.accessToken);
      }
      const res = await fetch('/api/groups/bill', {
        method: 'POST',
        headers: roomHeaders('group', resolvedGroupId),
        body: JSON.stringify({
          groupId: resolvedGroupId,
          bill: {
            id: session.billId || session.id,
            title: session.storeName || 'Uploaded Bill',
            currency: session.currency || 'NIS',
            payerId: getRoomMemberId('group', resolvedGroupId) || groupData.group.members?.[0]?.id,
            sourceSessionId: session.id,
            sourceSessionToken: getRoomToken('session', session.id),
            amount: session.items?.reduce((acc: number, i: any) => acc + (i.price || 0), 0) || 0,
            items: session.items || []
          }
        })
      });

      const data = await res.json();
      if (data.success) {
        saveRoomCredentials('session', session.id, getRoomMemberId('group', resolvedGroupId), getRoomToken('group', resolvedGroupId));
        setSession((prev: any) => ({ ...prev, groupId: resolvedGroupId }));
        setShowAttachGroupModal(false);
        alert(`Bill successfully attached to group! 🔗`);
      } else {
        alert(data.error || 'Could not attach bill to group.');
      }
    } catch (err) {
      console.error(err);
      alert('Error attaching bill to group.');
    }
  };

  // Persist active session in local storage for re-entry ONLY IF session is active and NOT settled/group bill
  useEffect(() => {
    if (session && session.id) {
      if (session.status === 'settled' || session.groupId) {
        localStorage.removeItem('billsplit_active_session');
      } else {
        const validMembers = Array.isArray(session.members) ? session.members : [];
        const isHost = validMembers.find((m: any) => m?.id === currentMemberId)?.isHost;
        localStorage.setItem(
          'billsplit_active_session',
          JSON.stringify({
            id: session.id,
            code: session.code,
            storeName: session.storeName,
            isHost: !!isHost,
            memberId: currentMemberId
          })
        );
      }
    }
  }, [session, currentMemberId]);

  // Auto-add group to user's saved active groups ONLY IF user hasn't explicitly left/deleted it
  useEffect(() => {
    const targetGroupId = session?.groupId;
    if (targetGroupId) {
      const localDeleted = localStorage.getItem('billsplit_deleted_group_ids');
      const deletedIds = localDeleted ? JSON.parse(localDeleted) : [];
      if (deletedIds.includes(targetGroupId)) return;

      fetch(`/api/groups/${targetGroupId}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.success && data.group) {
            const cookieGroups = getCookie('billsplit_user_groups');
            const localGroups = localStorage.getItem('billsplit_user_groups');
            const rawGroups = cookieGroups || (localGroups ? JSON.parse(localGroups) : []);
            const groupList = Array.isArray(rawGroups) ? rawGroups : [];
            const exists = groupList.some((g: any) => g.id === data.group.id);
            if (!exists) {
              const updated = [...groupList, data.group];
              setCookie('billsplit_user_groups', updated);
              localStorage.setItem('billsplit_user_groups', JSON.stringify(updated));
            }
          }
        })
        .catch(() => {});
    }
  }, [session?.groupId]);

  useEffect(() => {
    if (session?.status === 'settled') {
      localStorage.removeItem('billsplit_active_session');
    }
  }, [session?.status]);

  const [sessionNotFound, setSessionNotFound] = useState(false);

  const fetchSessionData = async (id: string) => {
    try {
      const res = await fetch(`/api/session/${id}`, { headers: roomHeaders('session', id, false) });
      if (res.ok) {
        const data = await res.json();
        if (data.session) {
          setSession(data.session);
          setSessionNotFound(false);
        }
      } else if (res.status === 404) {
        setSessionNotFound(true);
      }
    } catch (err) {
      console.error('Error fetching session:', err);
    }
  };

  const connectWebSocket = (id: string, accessToken: string) => {
    try {
      if (socketRef.current) {
        try { socketRef.current.close(); } catch (_) {}
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;
      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'SUBSCRIBE',
            sessionId: id,
            accessToken,
          })
        );
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'SESSION_UPDATE' && data.session) {
            setSession(data.session);
          }
        } catch (e) {
          console.error(e);
        }
      };

      ws.onclose = () => {
        setTimeout(() => {
          if (socketRef.current === ws) {
            connectWebSocket(id, accessToken);
          }
        }, 2500);
      };

      ws.onerror = () => {
        try { ws.close(); } catch (_) {}
      };
    } catch (err) {
      console.error('WebSocket connection error:', err);
    }
  };

  const sendAction = async (action: string, payload: any = {}) => {
    triggerHaptic(action === 'SETTLE_ALL' ? 'success' : action === 'SPLIT_EVERYONE' ? 'medium' : 'light');
    
    // Instant Optimistic UI Update for zero-latency local feedback
    if (action === 'TOGGLE_CLAIM' && payload.itemId) {
      setSession((prev: any) => {
        if (!prev || !Array.isArray(prev.items)) return prev;
        const targetMember = currentMemberId;
        const updatedItems = prev.items.map((it: any) => {
          if (it.id === payload.itemId) {
            const claimants = Array.isArray(it.claimedBy) ? it.claimedBy : [];
            const hasClaimed = payload.claimed !== undefined ? !payload.claimed : claimants.includes(targetMember);
            return {
              ...it,
              claimedBy: hasClaimed
                ? claimants.filter((c: string) => c !== targetMember)
                : [...claimants, targetMember]
            };
          }
          return it;
        });
        return { ...prev, items: updatedItems };
      });
    }

    try {
      const res = await fetch('/api/session/action', {
        method: 'POST',
        headers: roomHeaders('session', session?.id || sessionId),
        body: JSON.stringify({
          sessionId: session?.id || sessionId,
          action,
          actionId: createClientActionId(),
          payload: { ...payload, memberId: currentMemberId },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Action failed');
      if (data.session) setSession(data.session);
      return true;
    } catch (err) {
      console.error('Session action failed:', err);
      fetchSessionData(session?.id || sessionId);
      alert(err instanceof Error ? err.message : 'Could not update the session.');
      return false;
    }
  };


  const handleAddItemSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItemName || !newItemPrice) return;

    sendAction('ADD_ITEM', {
      itemId: `item_${createClientActionId()}`,
      name: newItemName,
      price: parseFloat(newItemPrice) || 0,
      category: newItemCategory,
    });
    setNewItemName('');
    setNewItemPrice('');
    setShowAddItemModal(false);
  };

  const handleOpenEditModal = (item: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingItemId(item.id);
    setEditItemName(item.name || '');
    setEditItemPrice(item.price ? String(item.price) : '');
    setEditItemCategory(item.category || 'Food');
    setShowEditItemModal(true);
  };

  const handleEditItemSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItemId || !editItemName || !editItemPrice) return;

    sendAction('EDIT_ITEM', {
      itemId: editingItemId,
      name: editItemName,
      price: parseFloat(editItemPrice) || 0,
      category: editItemCategory,
    });
    setShowEditItemModal(false);
  };

  const handleDeleteItem = (itemId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(t('confirmDeleteItem', undefined, 'Delete this item from receipt?'))) {
      sendAction('DELETE_ITEM', { itemId });
      setShowEditItemModal(false);
    }
  };

  // Category Icon Resolver
  const getItemIcon = (category: string) => {
    const catLower = (category || '').toLowerCase();
    if (catLower.includes('drink') || catLower.includes('beverage') || catLower.includes('coke') || catLower.includes('beer')) {
      return <GlassWater className="w-4 h-4 text-sky-500 shrink-0" />;
    } else if (catLower.includes('dessert') || catLower.includes('sweet') || catLower.includes('ice')) {
      return <Cookie className="w-4 h-4 text-amber-500 shrink-0" />;
    } else if (catLower.includes('service') || catLower.includes('tax') || catLower.includes('tip')) {
      return <Tag className="w-4 h-4 text-brand-500 shrink-0" />;
    } else if (catLower.includes('food') || catLower.includes('main') || catLower.includes('appetizer')) {
      return <Utensils className="w-4 h-4 text-brand-400 shrink-0" />;
    }
    return <ShoppingBag className="w-4 h-4 text-slate-400 shrink-0" />;
  };

  const validMembers = Array.isArray(session?.members) ? session.members : [];
  const validItems = Array.isArray(session?.items) ? session.items : [];

  // Bulletproof Calculations
  const memberCalculations = useMemo(() => {
    if (!session || !validItems.length) {
      return { myShare: 0, subtotal: 0, itemSubtotal: 0, receiptAdjustment: 0, totalSubtotal: 0, grandTotal: 0, itemsCount: 0 };
    }

    const itemWeights = validItems.map((item: any) => toCents(item?.price));
    const totalItemCents = itemWeights.reduce((sum: number, cents: number) => sum + cents, 0);
    const payableTotal = getReceiptPayableTotal(session);
    const payableItemCents = allocateCentsProportionally(toCents(payableTotal) || totalItemCents, itemWeights);
    let myItemSubtotalCents = 0;
    const activeMemberIds: string[] = validMembers
      .filter((member: any) => member?.id && member.active !== false)
      .map((member: any) => String(member.id));
    const activeMemberSet = new Set(activeMemberIds);
    const payableByMember = new Map<string, number>(activeMemberIds.map((memberId) => [memberId, 0]));

    validItems.forEach((item: any, index: number) => {
      const claimants = [...new Set(
        (Array.isArray(item?.claimedBy) ? item.claimedBy : []).filter((memberId: string) => activeMemberSet.has(memberId))
      )] as string[];
      if (claimants.includes(currentMemberId)) {
        myItemSubtotalCents += splitCents(itemWeights[index], claimants)
          .find((share: any) => share.memberId === currentMemberId)?.cents || 0;
      }
      splitCents(payableItemCents[index], claimants).forEach(({ memberId, cents }: { memberId: string; cents: number }) => {
        payableByMember.set(memberId, (payableByMember.get(memberId) || 0) + cents);
      });
    });

    const baseShareCents = activeMemberIds.map((memberId: string) => payableByMember.get(memberId) || 0);
    const tippedShareCents = allocateTipAdjustedCents(baseShareCents, tipPercentage);
    const currentMemberIndex = activeMemberIds.indexOf(currentMemberId);
    const myPayableSubtotalCents = currentMemberIndex >= 0 ? baseShareCents[currentMemberIndex] : 0;
    const myTippedShareCents = currentMemberIndex >= 0 ? tippedShareCents[currentMemberIndex] : 0;
    const itemSubtotal = myItemSubtotalCents / 100;
    const mySubtotal = myPayableSubtotalCents / 100;
    const tipMultiplier = 1 + (tipPercentage || 0) / 100;

    return {
      myShare: myTippedShareCents / 100,
      subtotal: mySubtotal,
      itemSubtotal,
      receiptAdjustment: (myPayableSubtotalCents - myItemSubtotalCents) / 100,
      totalSubtotal: totalItemCents / 100,
      grandTotal: Math.round(toCents(payableTotal) * tipMultiplier) / 100,
      itemsCount: validItems.length,
    };
  }, [session, validItems, currentMemberId, tipPercentage]);

  const currentMember = validMembers.find((m: any) => m?.id === currentMemberId);
  const hostMember = validMembers.find((m: any) => m?.isHost) || validMembers[0];
  const isCurrentUserHost = Boolean(currentMember?.isHost);
  const isSessionClosed = session?.status === 'settled';
  const hasSettledMembers = validMembers.some((member: any) => member?.settled === true);
  const isCurrentMemberSettled = Boolean(currentMember?.settled);
  const isAccountingLocked = isSessionClosed || hasSettledMembers;

  const activePayerId = session?.payerId || 'each';
  const isEachPaid = activePayerId === 'each';
  const payerMember = !isEachPaid ? validMembers.find((m: any) => m?.id === activePayerId) : null;
  const activePayerName = payerMember?.name || (isEachPaid ? t('eachPaidShare', undefined, 'Each paid their own share') : (session?.hostName || hostMember?.name || 'Host'));
  const activePayerPhone = payerMember?.phone || (payerMember?.isHost ? session?.hostPhone : (hostMember?.phone || ''));
  const isMePayer = !isEachPaid && activePayerId === currentMemberId;
  const canPayPayer = isValidIsraeliPhone(activePayerPhone);

  const triggerCelebration = () => {
    setShowCompletionReaction(true);
    triggerHaptic('success');
    try {
      confetti({
        particleCount: 160,
        spread: 80,
        origin: { y: 0.5 }
      });
    } catch (e) {
      // ignore
    }
  };

  if (!session) {
    if (sessionNotFound) {
      return (
        <div className="app-surface flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center text-slate-900 dark:text-white">
          <h2 className="text-xl font-extrabold">{t('sessionNotFoundTitle', undefined, 'Session not found')}</h2>
          <p className="max-w-sm text-sm text-slate-500">{t('sessionNotFoundText', undefined, 'This link or code is invalid, expired, or the room was deleted.')}</p>
          <button onClick={() => router.push('/')} className="photo-btn-indigo px-6 py-3 text-sm font-bold">
            {t('backToHomeBtn', undefined, 'Back to Home')}
          </button>
        </div>
      );
    }
    return (
      <div className="app-surface flex flex-col min-h-screen p-5">
        <ReceiptSkeleton />
      </div>
    );
  }

  return (
    <div className="app-surface flex flex-col min-h-screen p-5 text-slate-900 dark:text-slate-100 space-y-6 transition-colors duration-300 pb-28">
      {/* Header Bar */}
      <header className="flex items-center justify-between py-2 border-b border-slate-200/80 dark:border-slate-800">
        <button
          onClick={handleBackNavigation}
          className="w-10 h-10 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 flex items-center justify-center transition-colors shadow-sm active:scale-95"
        >
          <ChevronLeft className={`w-5 h-5 ${isRtl ? 'rotate-180' : ''}`} />
        </button>

        <div className="text-center">
          <h1 className="font-extrabold text-base text-slate-900 dark:text-white">{session.storeName || 'Bill Session'}</h1>
          <p className="text-xs font-mono text-slate-600 dark:text-slate-400 font-bold mt-0.5">
            {t('codeLabel', undefined, 'Code')}: #{session.code || ''}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="w-10 h-10 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 transition-colors shadow-sm"
            title="Toggle Theme"
          >
            {theme === 'dark' ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5 text-slate-700" />}
          </button>

          <button
            onClick={() => setShowQrModal(true)}
            className="brand-tap w-10 h-10 rounded-full bg-brand-600 dark:bg-brand-300 text-white dark:text-brand-950 flex items-center justify-center hover:bg-brand-700 dark:hover:bg-brand-200 transition-colors shadow-brand font-bold"
            title="Share & Invite"
          >
            <Share2 className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Share / QR Modal */}
      <QRCodeModal
        isOpen={showQrModal}
        onClose={() => setShowQrModal(false)}
        sessionCode={session.code || ''}
        sessionId={session.groupId || session.id || ''}
        isGroup={Boolean(session.groupId)}
        hideCode={Boolean(session.groupId)}
      />

      {/* Real-Time Members List - Vibrant Modern Design */}
      <div className="photo-card p-4 bg-white dark:bg-[#141B28] border border-slate-200/80 dark:border-white/10 shadow-md space-y-3.5 rounded-2xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-brand-500/15 text-brand-600 dark:text-brand-400 flex items-center justify-center border border-brand-500/20">
              <Users className="w-4 h-4" />
            </div>
            <h3 className="font-extrabold text-sm text-slate-900 dark:text-white">{t('roomMembersTitle', undefined, 'Room Members')}</h3>
            <span className="px-2 py-0.5 rounded-full bg-brand-500/10 dark:bg-brand-500/20 text-brand-600 dark:text-brand-400 text-xs font-black border border-brand-500/20">
              {validMembers.length}
            </span>
          </div>

          <button
            onClick={() => setShowQrModal(true)}
            className="py-1.5 px-3.5 rounded-full bg-brand-600 hover:bg-brand-700 text-white text-xs font-black flex items-center gap-1.5 transition-all shadow-md shadow-brand-600/20 active:scale-95"
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>{t('inviteBtn', undefined, 'Invite')}</span>
          </button>
        </div>

        {/* Member Avatars Horizontal Scroll */}
        <div className="flex items-center gap-2.5 overflow-x-auto pb-1 pt-0.5 scrollbar-none">
          {validMembers.map((member: any, mIdx: number) => {
            const isMe = member?.id === currentMemberId;
            const validName = member?.name && member?.name.trim() !== '?' ? member.name.trim() : 'Guest';
            const MEMBER_PALETTES = [
              { bg: 'bg-brand-500/15 dark:bg-brand-500/25 text-brand-700 dark:text-brand-300 border-brand-500/30', icon: 'bg-brand-500 text-white' },
              { bg: 'bg-orange-500/15 dark:bg-orange-500/25 text-orange-700 dark:text-orange-300 border-orange-500/30', icon: 'bg-orange-500 text-white' },
              { bg: 'bg-mint-500/15 dark:bg-mint-500/25 text-mint-700 dark:text-mint-300 border-mint-500/30', icon: 'bg-mint-500 text-white' },
              { bg: 'bg-pink-500/15 dark:bg-pink-500/25 text-pink-700 dark:text-pink-300 border-pink-500/30', icon: 'bg-pink-500 text-white' },
              { bg: 'bg-sky-500/15 dark:bg-sky-500/25 text-sky-700 dark:text-sky-300 border-sky-500/30', icon: 'bg-sky-500 text-white' },
              { bg: 'bg-purple-500/15 dark:bg-purple-500/25 text-purple-700 dark:text-purple-300 border-purple-500/30', icon: 'bg-purple-500 text-white' },
            ];
            const palette = MEMBER_PALETTES[mIdx % MEMBER_PALETTES.length];

            return (
              <div
                key={member?.id}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${palette.bg} border shrink-0 text-xs font-bold shadow-2xs transition-all hover:scale-105`}
              >
                <div className={`w-5 h-5 rounded-full flex items-center justify-center ${palette.icon} text-[10px] font-black shrink-0 shadow-xs`}>
                  {validName.charAt(0).toUpperCase()}
                </div>

                <span>{validName} {isMe ? t('youSuffix', undefined, '(You)') : ''}</span>

                {member?.isHost && (
                  <span className="px-1.5 py-0.5 rounded-md bg-gradient-to-r from-amber-500 to-orange-500 text-[9px] font-black text-white shadow-2xs uppercase tracking-wider">
                    {t('hostBadge', undefined, 'HOST')}
                  </span>
                )}
                {member?.settled && (
                  <span className="w-4 h-4 rounded-full bg-mint-500 text-white flex items-center justify-center text-[10px] font-black shadow-xs">✓</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Dedicated Clean Attach to Group Bar */}
        {session.groupId ? (
          <div className="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-brand-500/10 dark:bg-brand-500/15 border border-brand-500/25 text-brand-900 dark:text-brand-200 text-xs font-extrabold">
            <span className="flex items-center gap-2">
              <Link2 className="w-4 h-4 text-brand-600 dark:text-brand-400" />
              <span>{t('billAttachedToGroup', undefined, 'Bill Attached to Group')}</span>
            </span>
            <span className="text-[10px] font-black uppercase px-2.5 py-0.5 rounded-full bg-brand-600 text-white shadow-xs">
              {t('linkedBadge', undefined, 'LINKED ✓')}
            </span>
          </div>
        ) : (
          <button
            onClick={() => setShowAttachGroupModal(true)}
            className="w-full py-2.5 px-3 rounded-xl bg-slate-50 dark:bg-[#1A2232] hover:bg-brand-50/50 dark:hover:bg-brand-950/30 text-slate-700 dark:text-slate-200 hover:text-brand-600 dark:hover:text-brand-300 text-xs font-extrabold flex items-center justify-center gap-2 transition-all border border-dashed border-slate-300 dark:border-white/10 hover:border-brand-400 dark:hover:border-brand-500/40 active:scale-95 shadow-2xs group"
          >
            <Link2 className="w-4 h-4 text-brand-500 group-hover:scale-110 transition-transform" />
            <span>{t('attachBillTitle', undefined, 'Attach Bill to Group')} 🔗</span>
          </button>
        )}

        {/* Dedicated "Who paid?" Selector Bar */}
        <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-[#1A2232] border border-slate-200/80 dark:border-white/5 text-xs gap-2">
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-6 h-6 rounded-md bg-purple-500/15 text-purple-600 dark:text-purple-400 flex items-center justify-center border border-purple-500/20">
              <CreditCard className="w-3.5 h-3.5" />
            </div>
            <span className="font-extrabold text-slate-900 dark:text-white text-xs">
              {t('whoPaidShort', undefined, 'Who paid?')}
            </span>
          </div>

          <select
            value={activePayerId}
            onChange={(e) => sendAction('SET_PAYER', { payerId: e.target.value })}
            disabled={!isCurrentUserHost || isAccountingLocked}
            className="py-1.5 px-3 rounded-lg bg-white dark:bg-brand-900 text-xs font-bold border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white shadow-2xs focus:ring-2 focus:ring-brand-500/30 cursor-pointer max-w-[220px] truncate"
          >
            <option value="each">👥 {t('eachPaidShareOption', undefined, 'Each paid their share')}</option>
            {validMembers.map((m: any) => (
              <option key={m.id} value={m.id}>
                👤 {m.name} {m.id === currentMemberId ? t('youSuffix', undefined, '(You)') : ''} {m.isHost ? `[${t('hostBadge', undefined, 'HOST')}]` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>


      {/* Shared Receipt Items Section */}
      <div className="flex-1 space-y-4 pt-1">
        {isSessionClosed && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-center text-sm font-bold text-slate-800 dark:border-slate-700 dark:bg-slate-900/30 dark:text-slate-200">
            {t('sessionClosedNotice', undefined, 'This session is settled and is now read-only.')}
          </div>
        )}
        {!isSessionClosed && hasSettledMembers && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-center text-xs font-bold text-slate-700 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200">
            {t('paymentAllocationLocked', undefined, 'Items, payer and tip are locked while a member is marked paid. That member can reopen their share before further edits.')}
          </div>
        )}
        
        <div className="flex items-center justify-between px-1">
          <div>
            <h2 className="font-black text-lg text-slate-900 dark:text-white tracking-tight">{t('receiptItemsTitle', undefined, 'Receipt Items')}</h2>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('tapItemToClaim', undefined, 'Tap item to claim & split cost')}</p>
          </div>

          {isCurrentUserHost && !hasSettledMembers && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAddItemModal(true)}
                className="py-1.5 px-3 rounded-full bg-white dark:bg-[#1A2232] hover:bg-slate-100 dark:hover:bg-[#222C3D] text-slate-800 dark:text-slate-200 text-xs font-extrabold flex items-center gap-1 transition-all border border-slate-200/80 dark:border-white/10 active:scale-95 shadow-2xs"
              >
                <Plus className="w-3.5 h-3.5 text-brand-500" />
                <span>{t('addItemBtn', undefined, 'Add Item')}</span>
              </button>

              <button
                onClick={() => sendAction('SPLIT_EVERYONE', {})}
                className="brand-tap py-1.5 px-3.5 rounded-full bg-gradient-to-r from-brand-600 to-peach-500 hover:from-brand-700 hover:to-peach-600 text-white text-xs font-black flex items-center gap-1.5 transition-all shadow-md shadow-brand-500/20"
              >
                <Zap className="w-3.5 h-3.5 fill-current text-amber-300" />
                <span>{t('splitAllBtn', undefined, 'Split All')}</span>
              </button>
            </div>
          )}
        </div>

        {/* Item Cards List grouped inside a single container with rich styling */}
        <div className="bg-white dark:bg-[#141B28] rounded-2xl border border-slate-200/80 dark:border-white/10 divide-y divide-slate-100 dark:divide-white/5 overflow-hidden shadow-md">
          {validItems.map((item: any) => {
            const claimants = Array.isArray(item?.claimedBy) ? item.claimedBy : [];
            const isClaimedByMe = claimants.includes(currentMemberId);
            const splitCount = claimants.length;
            const itemPrice = typeof item?.price === 'number' ? item.price : parseFloat(item?.price) || 0;
            const splitPrice = splitCount > 0 ? itemPrice / splitCount : itemPrice;
            const activeCurr = session?.currency || langCtx?.currency || 'NIS';
            const claimantDetails = claimants.map((cId: string) => {
              const member = validMembers.find((candidate: any) => candidate?.id === cId);
              const isMe = cId === currentMemberId;
              const fullName = member?.name && member.name.trim() !== '?'
                ? member.name.trim()
                : (isMe ? (profile?.displayName || 'User') : 'Member');
              return { id: cId, fullName, isMe };
            });

            // Distinctive Category Styling
            const cat = (item?.category || '').toLowerCase();
            let catStyle = {
              iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
            };
            if (cat.includes('food') || cat.includes('dining') || cat.includes('אוכל') || cat.includes('מסעד')) {
              catStyle = {
                iconBg: 'bg-orange-500/15 text-orange-500 border-orange-500/25',
              };
            } else if (cat.includes('drink') || cat.includes('beverage') || cat.includes('bar') || cat.includes('שתיי') || cat.includes('בר')) {
              catStyle = {
                iconBg: 'bg-cyan-500/15 text-cyan-500 border-cyan-500/25',
              };
            } else if (cat.includes('dessert') || cat.includes('קינוח') || cat.includes('sweet') || cat.includes('מתוק')) {
              catStyle = {
                iconBg: 'bg-rose-500/15 text-rose-500 border-rose-500/25',
              };
            } else if (cat.includes('grocer') || cat.includes('סופר')) {
              catStyle = {
                iconBg: 'bg-mint-500/15 text-mint-500 border-mint-500/25',
              };
            } else if (cat.includes('travel') || cat.includes('טיול') || cat.includes('flight') || cat.includes('מלון')) {
              catStyle = {
                iconBg: 'bg-brand-500/15 text-brand-500 border-brand-500/25',
              };
            } else if (cat.includes('shop') || cat.includes('בגדים') || cat.includes('shopping')) {
              catStyle = {
                iconBg: 'bg-purple-500/15 text-purple-500 border-purple-500/25',
              };
            }

            return (
              <div
                key={item?.id}
                onClick={isAccountingLocked ? undefined : () => sendAction('TOGGLE_CLAIM', { itemId: item?.id, memberId: currentMemberId, claimed: !isClaimedByMe })}
                onKeyDown={isAccountingLocked ? undefined : (event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    sendAction('TOGGLE_CLAIM', { itemId: item?.id, memberId: currentMemberId, claimed: !isClaimedByMe });
                  }
                }}
                role={isAccountingLocked ? undefined : 'button'}
                tabIndex={isAccountingLocked ? undefined : 0}
                aria-pressed={isAccountingLocked ? undefined : isClaimedByMe}
                className={`relative p-4 sm:p-5 transition-all flex flex-col ${isAccountingLocked ? '' : 'cursor-pointer'} ${
                  isClaimedByMe
                    ? 'bg-brand-500/[0.07] dark:bg-brand-500/[0.12]'
                    : 'hover:bg-slate-50/70 dark:hover:bg-white/[0.02]'
                }`}
              >
                {/* Visual left accent bar when claimed */}
                {isClaimedByMe && (
                  <div className="absolute top-0 bottom-0 w-1.5 bg-gradient-to-b from-brand-500 to-peach-400 ltr:left-0 rtl:right-0 shadow-sm" />
                )}

                <div className="flex items-start justify-between mb-1">
                  <div className="flex items-center gap-3">
                    {/* Item Category Icon on the Left */}
                    <div className={`p-2.5 rounded-xl ${catStyle.iconBg} border shrink-0 group-hover:scale-105 transition-transform`}>
                      {getItemIcon(item?.category)}
                    </div>

                    <div>
                      <div className="flex items-center gap-1.5">
                        <h3 className="font-extrabold text-slate-900 dark:text-white text-sm sm:text-base leading-tight">
                          {item?.name || 'Item'}
                        </h3>

                        {/* Edit Item Pencil Button */}
                        {isCurrentUserHost && !hasSettledMembers && (
                          <button
                            type="button"
                            onClick={(e) => handleOpenEditModal(item, e)}
                            className="p-1 rounded-full text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-950/40 transition-colors"
                            title={t('editItemTitle', undefined, 'Edit Item')}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      {claimantDetails.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap mt-2" aria-label={t('claimedByLabel', { name: claimantDetails.map(({ fullName }: any) => fullName).join(', ') }, 'Claimed by')}>
                          {claimantDetails.map(({ id, fullName, isMe }: any) => (
                            <span
                              key={id}
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black border ${
                                isMe
                                  ? 'bg-brand-600 text-white border-brand-600'
                                  : 'bg-slate-100 dark:bg-[#1A2232] text-slate-700 dark:text-slate-300 border-slate-200 dark:border-white/10'
                              }`}
                            >
                              <span className="w-3.5 h-3.5 rounded-full bg-slate-300/50 dark:bg-white/10 flex items-center justify-center text-[8px]">
                                {fullName.charAt(0).toUpperCase()}
                              </span>
                              {fullName}
                              {isMe && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                            </span>
                          ))}
                        </div>
                      )}

                    </div>
                  </div>

                  <div className="text-right rtl:text-left">
                    {(() => {
                      type DualPriceResult = { primary: string; secondary?: string };
                      const displayedPrice = splitCount > 1 ? splitPrice : itemPrice;
                      const itemDual: DualPriceResult = formatDual ? formatDual(displayedPrice, activeCurr) : { primary: `${displayedPrice}` };
                      return (
                        <div className="flex flex-col items-end rtl:items-start">
                          <span className="text-base sm:text-lg font-black text-slate-900 dark:text-white tracking-tight">
                            {itemDual?.primary || `${itemPrice}`}
                          </span>
                          {itemDual?.secondary && (
                            <span className="text-[11px] font-bold text-slate-400 block mt-0.5">
                              ({itemDual.secondary})
                            </span>
                          )}
                          {splitCount > 1 && (
                            <span className="text-[10px] font-black text-brand-600 dark:text-brand-400 mt-0.5">
                              {t('eachLabel', undefined, 'each')}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Claim state and split status */}
                <div className="flex items-center justify-between pt-3 mt-2.5 border-t border-slate-100 dark:border-white/5">
                  <span className={`text-[10px] font-black px-2.5 py-1 rounded-full ${
                    splitCount === 0
                      ? 'text-slate-500 bg-slate-100 dark:bg-white/5 dark:text-slate-400'
                      : isClaimedByMe
                        ? 'text-brand-700 bg-brand-100 dark:bg-brand-500/20 dark:text-brand-300'
                        : 'text-slate-700 bg-slate-100 dark:bg-[#1A2232] dark:text-slate-300'
                  }`}>
                    {splitCount === 0
                      ? t('availableLabel', undefined, 'Available')
                      : splitCount > 1
                        ? t('splitBetweenLabel', { count: splitCount }, `Split between ${splitCount}`)
                        : t('claimedByLabel', { name: claimantDetails[0]?.fullName || 'Member' }, `Claimed by ${claimantDetails[0]?.fullName || 'Member'}`)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Floating Add Item Button */}
      {isCurrentUserHost && !isAccountingLocked && <button
        onClick={() => setShowAddItemModal(true)}
        aria-label={t('addItemBtn', undefined, 'Add Item')}
        className="brand-tap fixed bottom-24 ltr:right-6 rtl:left-6 z-30 w-14 h-14 rounded-full bg-brand-600 dark:bg-brand-300 text-white dark:text-brand-950 font-extrabold shadow-brand flex items-center justify-center hover:scale-105 transition-all"
      >
        <Plus className="w-7 h-7" />
      </button>}

      {/* Bottom Floating Settlement Banner */}
      {!isSessionClosed && <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto z-40 p-5 bg-white/95 dark:bg-brand-950/90 border-t border-slate-100 dark:border-white/5 backdrop-blur-xl flex items-center justify-between shadow-2xl">
        <div>
          <span className="text-xs text-slate-500 dark:text-slate-400 block">{t('yourShareLabel', undefined, 'Your Share')}</span>
          {(() => {
            type DualPriceResult = { primary: string; secondary?: string };
            const shareDual: DualPriceResult = formatDual ? formatDual(memberCalculations.myShare || 0, session?.currency || 'NIS') : { primary: `${memberCalculations.myShare || 0}` };
            return (
              <div className="flex items-baseline gap-1.5">
                <span className="text-xl font-bold text-slate-900 dark:text-white">
                  {shareDual?.primary || '0.00'}
                </span>
                {shareDual?.secondary && (
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    ({shareDual.secondary})
                  </span>
                )}
              </div>
            );
          })()}
        </div>

        <button
          onClick={() => {
            if (isCurrentMemberSettled && !isCurrentUserHost) {
              void sendAction('TOGGLE_SETTLED', { memberId: currentMemberId, settled: false });
              return;
            }
            setShowSettleModal(true);
          }}
          className="brand-tap py-3.5 px-6 rounded-xl bg-brand-600 hover:bg-brand-700 dark:bg-brand-300 dark:hover:bg-brand-200 text-white dark:text-brand-950 font-bold shadow-brand text-sm transition-all"
        >
          {isCurrentMemberSettled && !isCurrentUserHost
            ? t('reopenMyShareBtn', undefined, 'Reopen My Share')
            : t('settleAndPayBtn', undefined, 'Settle & Pay')}
        </button>
      </div>}



      {/* --- MODAL 3: ADD CUSTOM ITEM MODAL --- */}
      {showAddItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-sm photo-card p-6 bg-white dark:bg-brand-900 border border-slate-200 dark:border-[#222C3D] text-slate-900 dark:text-white space-y-4 shadow-float">
            <h3 className="text-lg font-bold text-center">{t('addCustomItemTitle', undefined, 'Add Custom Item')}</h3>

            <form onSubmit={handleAddItemSubmit} className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 block mb-1">
                  {t('itemNameLabel', undefined, 'Item Name')}
                </label>
                <input
                  type="text"
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  placeholder="e.g. Extra Dessert"
                  className="w-full py-2.5 px-3 rounded-xl photo-input text-xs font-medium"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 block mb-1">
                  {t('priceLabel', undefined, 'Price')}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={newItemPrice}
                  onChange={(e) => setNewItemPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full py-2.5 px-3 rounded-xl photo-input text-xs font-medium font-mono"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 block mb-1">
                  {t('categoryLabel', undefined, 'Category')}
                </label>
                <select
                  value={newItemCategory}
                  onChange={(e) => setNewItemCategory(e.target.value)}
                  className="w-full py-2.5 px-3 rounded-xl photo-input text-xs font-medium"
                >
                  <option value="Food">Food 🍕</option>
                  <option value="Beverages">Beverages 🥤</option>
                  <option value="Dessert">Dessert 🍰</option>
                  <option value="Service">Service / Tip 🏷️</option>
                  <option value="Other">Other 📦</option>
                </select>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddItemModal(false)}
                  className="flex-1 py-3 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-bold"
                >
                  {t('cancelBtn', undefined, 'Cancel')}
                </button>

                <button
                  type="submit"
                  className="flex-1 py-3 photo-btn-indigo text-xs shadow-md"
                >
                  {t('addItemBtn', undefined, 'Add Item')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL 4: EDIT / DELETE CUSTOM ITEM MODAL --- */}
      {showEditItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-sm photo-card p-6 bg-white dark:bg-brand-900 border border-slate-200 dark:border-[#222C3D] text-slate-900 dark:text-white space-y-4 shadow-float">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold">{t('editItemTitle', undefined, 'Edit Receipt Item')}</h3>
              <button
                type="button"
                onClick={(e) => handleDeleteItem(editingItemId, e)}
                className="p-2 rounded-full text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                title={t('deleteItemBtn', undefined, 'Delete Item')}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleEditItemSubmit} className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 block mb-1">
                  {t('itemNameLabel', undefined, 'Item Name')}
                </label>
                <input
                  type="text"
                  value={editItemName}
                  onChange={(e) => setEditItemName(e.target.value)}
                  className="w-full py-2.5 px-3 rounded-xl photo-input text-xs font-medium"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 block mb-1">
                  {t('priceLabel', undefined, 'Price')}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={editItemPrice}
                  onChange={(e) => setEditItemPrice(e.target.value)}
                  className="w-full py-2.5 px-3 rounded-xl photo-input text-xs font-medium font-mono"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 block mb-1">
                  {t('categoryLabel', undefined, 'Category')}
                </label>
                <select
                  value={editItemCategory}
                  onChange={(e) => setEditItemCategory(e.target.value)}
                  className="w-full py-2.5 px-3 rounded-xl photo-input text-xs font-medium"
                >
                  <option value="Food">Food 🍕</option>
                  <option value="Beverages">Beverages 🥤</option>
                  <option value="Dessert">Dessert 🍰</option>
                  <option value="Service">Service / Tip 🏷️</option>
                  <option value="Other">Other 📦</option>
                </select>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowEditItemModal(false)}
                  className="flex-1 py-3 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-bold"
                >
                  {t('cancelBtn', undefined, 'Cancel')}
                </button>

                <button
                  type="submit"
                  className="flex-1 py-3 photo-btn-indigo text-xs shadow-md"
                >
                  {t('updateItemBtn', undefined, 'Update Item')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL 4: SETTLE BREAKDOWN --- */}
      {showSettleModal && (() => {
        type DualRes = { primary: string; secondary?: string };
        const rawItemSub = typeof memberCalculations.itemSubtotal === 'number' ? memberCalculations.itemSubtotal : parseFloat(memberCalculations.itemSubtotal as any) || 0;
        const itemSubVal = Math.round((rawItemSub + Number.EPSILON) * 100) / 100;
        const rawSub = typeof memberCalculations.subtotal === 'number' ? memberCalculations.subtotal : parseFloat(memberCalculations.subtotal as any) || 0;
        const subVal = Math.round((rawSub + Number.EPSILON) * 100) / 100;
        const adjustmentVal = Math.round(((memberCalculations.receiptAdjustment || 0) + Number.EPSILON) * 100) / 100;
        const dueVal = Math.round(((memberCalculations.myShare || 0) + Number.EPSILON) * 100) / 100;
        const tipVal = Math.round(((dueVal - subVal) + Number.EPSILON) * 100) / 100;
        const finalDueVal = isRounded ? Math.round(dueVal) : dueVal;

        const subDual: DualRes = formatDual ? formatDual(itemSubVal, session.currency || 'NIS') : { primary: `${itemSubVal.toFixed(2)} ${session.currency || 'NIS'}` };
        const adjustmentDual: DualRes = formatDual ? formatDual(adjustmentVal, session.currency || 'NIS') : { primary: `${adjustmentVal.toFixed(2)} ${session.currency || 'NIS'}` };
        const tipDual: DualRes = formatDual ? formatDual(tipVal, session.currency || 'NIS') : { primary: `${tipVal.toFixed(2)} ${session.currency || 'NIS'}` };
        const dueDual: DualRes = formatDual ? formatDual(finalDueVal, session.currency || 'NIS') : { primary: `${finalDueVal.toFixed(2)} ${session.currency || 'NIS'}` };

        return (
          <div className="fixed inset-0 z-50 flex flex-col justify-end bg-slate-950/60 backdrop-blur-sm animate-fadeIn">
            <div className="w-full max-w-md mx-auto rounded-t-[32px] p-6 bg-white dark:bg-brand-900 text-slate-900 dark:text-white space-y-5 max-h-[90vh] overflow-y-auto shadow-2xl">
              {/* Header */}
              <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
                <div>
                  <h2 className="text-xl font-extrabold text-slate-900 dark:text-white">{t('finalSettlementTitle', undefined, 'Final Settlement')}</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{session.storeName || ''}</p>
                </div>

                <button
                  onClick={() => {
                    setShowSettleModal(false);
                    setIsRounded(false);
                  }}
                  className="p-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Tip Selector */}
              {isCurrentUserHost && !hasSettledMembers && <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 block">
                  {t('selectTipLabel', undefined, 'Select Tip Percentage')}
                </label>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
                  <div className="grid grid-cols-4 gap-2 flex-1">
                    {[0, 10, 12, 15].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => {
                          setTipPercentage(pct);
                          setCustomTipInput('');
                          sendAction('SET_TIP', { tipPercentage: pct });
                        }}
                        className={`py-2 rounded-full text-xs font-extrabold transition-all border active:scale-95 duration-100 ${
                          tipPercentage === pct && !customTipInput
                            ? 'bg-black text-white border-black dark:bg-white dark:text-slate-900 shadow-sm'
                            : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                        }`}
                      >
                        {pct}%
                      </button>
                    ))}
                  </div>

                  <div className="relative w-full sm:w-28 shrink-0">
                    <input
                      type="number"
                      placeholder="Custom %"
                      value={customTipInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCustomTipInput(val);
                        const parsed = parseFloat(val);
                        setTipPercentage(isNaN(parsed) ? 0 : parsed);
                      }}
                      onBlur={() => sendAction('SET_TIP', { tipPercentage })}
                      min="0"
                      max="100"
                      className="w-full py-2 pl-3 pr-7 rounded-full text-xs text-center font-bold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-750 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-black dark:focus:ring-white [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-extrabold text-slate-400 pointer-events-none">%</span>
                  </div>
                </div>
              </div>}

              {/* Breakdown summary */}
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800 space-y-2 text-xs">
                <div className="flex justify-between text-slate-500 dark:text-slate-400">
                  <span>{t('itemsSubtotalLabel', undefined, 'Items Subtotal')}</span>
                  <span>
                    {subDual.primary} {subDual.secondary || ''}
                  </span>
                </div>
                {adjustmentVal !== 0 && (
                  <div className="flex justify-between text-slate-500 dark:text-slate-400">
                    <span>{t('receiptAdjustmentLabel', undefined, 'Receipt tax / service / discount')}</span>
                    <span>{adjustmentDual.primary} {adjustmentDual.secondary || ''}</span>
                  </div>
                )}
                <div className="flex justify-between text-slate-500 dark:text-slate-400">
                  <span>{t('tipAmountLabel', { pct: tipPercentage }, `Tip (${tipPercentage}%)`)}</span>
                  <span>
                    {tipDual.primary}
                  </span>
                </div>
                <div className="flex justify-between pt-2 border-t border-slate-200 dark:border-slate-800 text-base font-black text-slate-900 dark:text-white items-center">
                  <div className="flex items-center gap-2">
                    <span>{t('yourTotalDueLabel', undefined, 'Your Total Due')}</span>
                    {dueVal % 1 !== 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsRounded(!isRounded);
                          triggerHaptic('light');
                        }}
                        className={`py-0.5 px-2 rounded-full text-[10px] font-extrabold transition-all border ${
                          isRounded
                            ? 'bg-black text-white border-black dark:bg-white dark:text-slate-900 shadow-xs'
                            : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-750 text-slate-700 dark:text-slate-300 hover:bg-slate-200'
                        }`}
                      >
                        {isRounded ? t('roundedBadge', undefined, 'Rounded ✓') : t('roundBtn', undefined, 'Round')}
                      </button>
                    )}
                  </div>
                  <span>
                    {dueDual.primary} {dueDual.secondary || ''}
                  </span>
                </div>
              </div>

              {/* Who Paid Selector inside Settle Modal */}
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CreditCard className="w-4 h-4 text-slate-900 dark:text-white" />
                    <span className="text-xs font-bold text-slate-900 dark:text-white">
                      {t('whoPaidLabel', undefined, 'Who paid the bill?')}
                    </span>
                  </div>
                  <select
                    value={activePayerId}
                    onChange={(e) => sendAction('SET_PAYER', { payerId: e.target.value })}
                    className="py-1 px-2.5 rounded-lg bg-white dark:bg-slate-800 text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white cursor-pointer"
                  >
                    <option value="each">👥 {t('eachPaidShareOption', undefined, 'Each paid their share')}</option>
                    {validMembers.map((m: any) => (
                      <option key={m.id} value={m.id}>
                        👤 {m.name} {m.id === currentMemberId ? t('youSuffix', undefined, '(You)') : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 font-medium">
                  {isEachPaid
                    ? t('eachPaidShareModalNote', undefined, 'Everyone pays the vendor directly. Mark your share once paid.')
                    : isMePayer
                    ? t('youArePayerNote', undefined, 'You paid upfront! Other room members will settle their shares with you.')
                    : t('settleWithPayerNote', { name: activePayerName }, `Please send your share to ${activePayerName}.`)}
                </p>
              </div>

              {/* Instant Payment Transfer Options to Payer (when someone specific paid upfront) */}
              {!isEachPaid && !isMePayer && (
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 block">
                    {t('payPayerTitle', { name: activePayerName }, `Pay ${activePayerName}`)}
                  </label>
                  {canPayPayer ? (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          triggerBitPayment({
                            phone: activePayerPhone,
                            amount: finalDueVal,
                            storeName: session?.storeName || 'EasySplit Room'
                          });
                        }}
                        className="py-3 px-3 rounded-xl bg-slate-900 text-white font-black text-xs shadow-sm hover:opacity-90 active:scale-95 transition-all text-center flex items-center justify-center gap-1.5"
                      >
                        <span>Bit (₪{finalDueVal.toFixed(2)})</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const phone = activePayerPhone.replace(/\D/g, '');
                          const amount = finalDueVal.toFixed(2);
                          try {
                            navigator.clipboard.writeText(`${phone} ${amount}`);
                          } catch (e) {}
                          const isMobile = typeof window !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
                          if (isMobile) {
                            window.location.href = `paybox://pay?phone=${phone}&amount=${amount}`;
                            setTimeout(() => {
                              window.open(`https://payboxapp.page.link/pay?phone=${phone}&amount=${amount}`, '_blank');
                            }, 800);
                          } else {
                            window.open(`https://payboxapp.page.link/pay?phone=${phone}&amount=${amount}`, '_blank');
                          }
                        }}
                        className="py-3 px-3 rounded-xl bg-slate-800 text-white font-black text-xs shadow-sm hover:opacity-90 active:scale-95 transition-all text-center flex items-center justify-center gap-1.5"
                      >
                        <span>Paybox (₪{finalDueVal.toFixed(2)})</span>
                      </button>
                    </div>
                  ) : (
                    <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] text-slate-600 dark:text-slate-300 font-medium text-center">
                      {t('payerPhoneNotSetNote', { name: activePayerName }, `${activePayerName} has not added a payment phone number yet. Please settle in person.`)}
                    </div>
                  )}
                </div>
              )}

              {/* Settle Action Button - Matching Picture 2 Specification */}
              <div className="pt-2">
                <button
                  disabled={isSettling !== 'idle'}
                  onClick={async () => {
                    setIsSettling('loading');
                    triggerHaptic('medium');

                    const success = isCurrentUserHost
                      ? await sendAction('SETTLE_ALL', {})
                      : await sendAction('TOGGLE_SETTLED', { memberId: currentMemberId, settled: true });

                    if (!success) {
                      setIsSettling('idle');
                      return;
                    }

                    // Save to user history upon settlement
                    try {
                      const rawName = (profile?.displayName || '').trim();
                      const userKey = rawName.toLowerCase();
                      const histRecord = {
                        id: session.id,
                        storeName: session.storeName || 'Bill Session',
                        date: session.date || new Date().toISOString().split('T')[0],
                        totalAmount: memberCalculations.grandTotal || 0,
                        userShare: finalDueVal || memberCalculations.myShare || 0,
                        currency: session.currency || 'NIS',
                        membersCount: validMembers.length || 1,
                        groupId: session.groupId,
                        payerName: activePayerName,
                        createdAt: Date.now(),
                        settledAt: Date.now(),
                        status: 'settled',
                      };

                      // Update user-specific and global history stores
                      [
                        `billsplit_history_${userKey}`,
                        rawName ? `billsplit_history_${rawName}` : null,
                        'billsplit_history'
                      ].filter(Boolean).forEach((key) => {
                        try {
                          const existing = localStorage.getItem(key!);
                          const list = existing ? JSON.parse(existing) : [];
                          const filtered = Array.isArray(list) ? list.filter((h: any) => h.id !== session.id) : [];
                          filtered.unshift(histRecord);
                          localStorage.setItem(key!, JSON.stringify(filtered));
                        } catch (_) {}
                      });
                    } catch (e) {
                      console.error('Error saving local history:', e);
                    }

                    // Smooth success transition on button
                    setIsSettling('success');
                    triggerHaptic('success');
                    triggerCelebration();

                    setTimeout(() => {
                      setShowSettleModal(false);
                      if (isCurrentUserHost) {
                        localStorage.removeItem('billsplit_active_session');
                        router.push('/?tab=history');
                      }
                      setIsSettling('idle');
                    }, 1400);
                  }}
                  className={`w-full py-4 rounded-full bg-white dark:bg-white text-black dark:text-black font-black text-sm border border-slate-200 dark:border-white/20 hover:bg-slate-100 dark:hover:bg-slate-100 shadow-2xl flex items-center justify-center gap-2.5 transition-all duration-300 active:scale-[0.98] text-center relative overflow-hidden group select-none ${
                    isSettling === 'success' ? 'ring-4 ring-black/20 dark:ring-white/30 bg-white' : ''
                  }`}
                >
                  {isSettling === 'loading' ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin text-black" />
                      <span className="text-black">{isCurrentUserHost ? t('settlingSession', undefined, 'Settling Session...') : t('markingPaid', undefined, 'Marking Paid...')}</span>
                    </>
                  ) : isSettling === 'success' ? (
                    <>
                      <CheckCircle2 className="w-5 h-5 text-mint-600 animate-scaleUp" />
                      <span className="animate-fadeIn text-black">{t('settledSuccessMsg', undefined, 'Settled Successfully! 🎉')}</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-5 h-5 text-black group-hover:scale-110 transition-transform" />
                      <span className="text-black">
                        {isCurrentUserHost
                          ? t('settleAndCloseSessionBtn', undefined, 'Settle Payment & Close Session')
                          : t('markPaidBtn', undefined, 'Mark My Share as Paid')}
                      </span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {/* Attach to Group Modal */}
      <AttachToGroupModal
        isOpen={showAttachGroupModal}
        onClose={() => setShowAttachGroupModal(false)}
        userGroups={userGroups}
        onAttach={handleAttachToGroup}
      />

      {/* Centered Celebration Reaction Modal */}
      {showCompletionReaction && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn"
          onClick={() => setShowCompletionReaction(false)}
        >
          <div 
            className="w-full max-w-xs rounded-3xl p-6 bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 text-center space-y-4 shadow-[0_20px_60px_rgba(0,0,0,0.5)] animate-scaleUp"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative w-28 h-28 mx-auto flex items-center justify-center">
              <div className="absolute inset-0 rounded-full bg-mint-400/20 dark:bg-mint-400/10 animate-ping opacity-50 pointer-events-none" />
              <div className="relative flex h-24 w-24 items-center justify-center rounded-[30px] bg-gradient-to-br from-mint-300 to-mint-500 text-white shadow-[0_18px_38px_rgba(43,199,137,0.30)]">
                <CheckCircle2 className="h-12 w-12 stroke-[2.4]" />
              </div>
            </div>

            <div className="space-y-1">
              <h3 className="text-lg font-black text-slate-900 dark:text-white tracking-tight">
                {t('settleSuccessTitle', undefined, 'Bill Split Settled!')}
              </h3>
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                {t('settleSuccessDesc', undefined, 'All done! Payments and records are archived.')}
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                setShowCompletionReaction(false);
                router.push('/?tab=history');
              }}
              className="brand-tap w-full py-3 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 dark:bg-brand-300 text-white dark:text-brand-950 font-extrabold text-xs shadow-brand transition-all"
            >
              <span>{t('viewHistoryBtn', undefined, 'View in History')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function WorkspacePage() {
  return (
    <SessionErrorBoundary>
      <Suspense
        fallback={
          <div className="flex flex-col min-h-screen p-5 bg-slate-50 dark:bg-brand-950">
            <ReceiptSkeleton />
          </div>
        }
      >
        <SessionWorkspaceInner />
      </Suspense>
    </SessionErrorBoundary>
  );
}
