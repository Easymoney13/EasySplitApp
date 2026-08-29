'use client';

import React, { useState, useEffect } from 'react';
import { X, Copy, Check, Share2, QrCode, UserPlus, Link, Smartphone } from 'lucide-react';
import { useLanguage } from './LanguageContext';
import QRCode from 'qrcode';
import { hasConfiguredApiOrigin, publicWebUrl } from '../../lib/platformTransport';

interface QRCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionCode: string;
  sessionId: string;
  isGroup?: boolean;
  inviteToken?: string;
  hideCode?: boolean;
  onAddFriend?: (friendName: string) => void;
}

export const QRCodeModal: React.FC<QRCodeModalProps> = ({
  isOpen,
  onClose,
  sessionCode,
  sessionId,
  isGroup = false,
  inviteToken = '',
  hideCode = false,
  onAddFriend
}) => {
  const { t, isRtl } = useLanguage();
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'qr' | 'link' | 'friend'>('qr');
  const [networkUrl, setNetworkUrl] = useState<string>('');
  const [friendNameInput, setFriendNameInput] = useState('');
  const [friendAddedMsg, setFriendAddedMsg] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');

  // Keep the bearer invite in the URL fragment so browsers never send it in
  // HTTP requests, access logs, analytics URLs, or Referer headers.
  const inviteQuery = !isGroup && inviteToken ? `#invite=${encodeURIComponent(inviteToken)}` : '';
  // Participants who entered a valid manual code do not possess the host's
  // signed bearer invite. Their re-shared QR therefore uses the currently
  // active code path instead of producing a dead durable-ID link.
  const codeInvite = !isGroup && !inviteToken && /^\d{5}$/.test(sessionCode)
    ? `?code=${encodeURIComponent(sessionCode)}`
    : '';
  const sessionInviteTarget = codeInvite ? sessionCode : sessionId;
  const basePath = `${isGroup ? `/group/${sessionId}` : `/session/${sessionInviteTarget}`}${codeInvite}${inviteQuery}`;
  const joinUrl = networkUrl || publicWebUrl(basePath);

  useEffect(() => {
    const isLocalhost = !hasConfiguredApiOrigin() && typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

    if (isLocalhost) {
      fetch('/api/network-ip')
        .then((res) => res.json())
        .then((data) => {
          if (data.ip && data.ip !== 'localhost') {
            const basePath = `${isGroup ? `/group/${sessionId}` : `/session/${sessionInviteTarget}`}${codeInvite}${inviteQuery}`;
            setNetworkUrl(`http://${data.ip}:${data.port || 3000}${basePath}`);
          }
        })
        .catch(() => {});
    }
  }, [sessionId, sessionInviteTarget, isGroup, codeInvite, inviteQuery]);

  useEffect(() => {
    if (!isOpen || !joinUrl) return;
    let active = true;
    QRCode.toDataURL(joinUrl, {
      width: 300,
      margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })
      .then((dataUrl) => { if (active) setQrDataUrl(dataUrl); })
      .catch(() => { if (active) setQrDataUrl(''); });
    return () => { active = false; };
  }, [isOpen, joinUrl]);

  if (!isOpen) return null;

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error(e);
    }
  };

  const shareNative = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: hideCode ? 'Join EasySplit' : `Join EasySplit Session #${sessionCode}`,
          text: hideCode ? t('secureGroupInviteText', undefined, 'Join our bill splitting room with this secure link.') : `Join our bill splitting room with code ${sessionCode}!`,
          url: joinUrl,
        });
      } catch (err) {
        // ignore
      }
    } else {
      copyToClipboard();
    }
  };

  const handleAddFriendSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = friendNameInput.trim();
    if (!name) return;
    if (onAddFriend) {
      onAddFriend(name);
    }
    setFriendNameInput('');
    setFriendAddedMsg(true);
    setTimeout(() => setFriendAddedMsg(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 backdrop-blur-md animate-fadeIn text-slate-900 dark:text-white">
      <div role="dialog" aria-modal="true" aria-label={t('shareRoomTitle', undefined, 'Invite Friends to Room')} className="relative w-full max-w-sm max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain rounded-[32px] border border-slate-200 dark:border-slate-800 bg-white dark:bg-brand-950 p-5 sm:p-6 shadow-2xl space-y-4">
        {/* Close Button */}
        <button
          onClick={onClose}
          aria-label={t('closeBtn', undefined, 'Close')}
          className="absolute top-4 ltr:right-4 rtl:left-4 rounded-full p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="text-center space-y-1">
          <div className="inline-flex p-3 rounded-2xl bg-brand-100 dark:bg-brand-950/80 text-brand-600 dark:text-brand-400 mb-1">
            <Share2 className="w-6 h-6 stroke-[2.2]" />
          </div>
          <h3 className="text-lg font-extrabold text-slate-900 dark:text-white">
            {t('shareRoomTitle', undefined, 'Invite Friends to Room')}
          </h3>
          {!hideCode && <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
            Room Code: <span className="font-mono font-black text-brand-600 dark:text-brand-400">#{sessionCode}</span>
          </p>}
        </div>

        {/* 3 Option Selector Tabs */}
        <div className={`grid ${onAddFriend ? 'grid-cols-3' : 'grid-cols-2'} gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 text-[11px] font-extrabold`}>
          <button
            onClick={() => setActiveTab('qr')}
            className={`py-2 px-1 rounded-xl flex flex-col items-center gap-1 transition-all ${
              activeTab === 'qr'
                ? 'bg-white dark:bg-slate-800 text-slate-950 dark:text-white shadow-sm'
                : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <QrCode className="w-3.5 h-3.5" />
            <span>{t('tabQrCode', undefined, 'QR Code')}</span>
          </button>

          <button
            onClick={() => setActiveTab('link')}
            className={`py-2 px-1 rounded-xl flex flex-col items-center gap-1 transition-all ${
              activeTab === 'link'
                ? 'bg-white dark:bg-slate-800 text-slate-950 dark:text-white shadow-sm'
                : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <Link className="w-3.5 h-3.5" />
            <span>{t('tabShareLink', undefined, 'Share Link')}</span>
          </button>

          {onAddFriend && (
            <button
              onClick={() => setActiveTab('friend')}
              className={`py-2 px-1 rounded-xl flex flex-col items-center gap-1 transition-all ${
                activeTab === 'friend'
                  ? 'bg-white dark:bg-slate-800 text-slate-950 dark:text-white shadow-sm'
                : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>{t('tabAddFriend', undefined, 'Add Friend')}</span>
            </button>
          )}
        </div>

        {/* TAB 1: QR CODE */}
        {activeTab === 'qr' && (
          <div className="space-y-3 animate-fadeIn">
            <div className="flex items-center justify-center p-4 bg-slate-50 dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={hideCode ? t('secureGroupQrAlt', undefined, 'QR code for secure group invite') : `QR Code for session ${sessionCode}`}
                  className="w-[min(11rem,48vw)] h-[min(11rem,48vw)] min-w-36 min-h-36 object-contain rounded-xl shadow-xs"
                />
              ) : (
                <div className="flex h-44 w-44 items-center justify-center text-xs font-semibold text-slate-400">
                  {t('generatingQr', undefined, 'Generating QR code...')}
                </div>
              )}
            </div>
            <p className="text-[11px] text-center text-slate-500 dark:text-slate-400 font-medium">
              {t('scanCameraWifiHint', undefined, 'Scan with phone camera to join instantly')}
            </p>
          </div>
        )}

        {/* TAB 2: SHARE LINK */}
        {activeTab === 'link' && (
          <div className="space-y-3 animate-fadeIn">
            <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 space-y-1.5">
              <span className="text-[10px] font-bold uppercase text-slate-400 block tracking-wider">
                {t('directRoomUrl', undefined, 'Direct Room URL')}
              </span>
              <p className="text-xs font-mono text-slate-800 dark:text-slate-200 break-all select-all font-semibold">
                {joinUrl}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={copyToClipboard}
                className="py-2.5 px-3 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-900 dark:text-white font-extrabold text-xs flex items-center justify-center gap-1.5 transition-all"
              >
                {copied ? <Check className="w-4 h-4 text-slate-900 dark:text-white" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? t('copiedMsg', undefined, 'Copied!') : t('copyLinkBtn', undefined, 'Copy Link')}</span>
              </button>

              <button
                onClick={shareNative}
                className="py-2.5 px-3 rounded-xl bg-brand-600 dark:bg-brand-300 text-white dark:text-brand-950 font-black text-xs flex items-center justify-center gap-1.5 transition-all shadow-sm"
              >
                <Share2 className="w-4 h-4" />
                <span>{t('shareBtn', undefined, 'Share')}</span>
              </button>
            </div>
          </div>
        )}

        {/* TAB 3: ADD FRIEND */}
        {activeTab === 'friend' && onAddFriend && (
          <form onSubmit={handleAddFriendSubmit} className="space-y-3 animate-fadeIn">
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                {t('friendsDisplayName', undefined, "Friend's Display Name")}
              </label>
              <input
                type="text"
                value={friendNameInput}
                onChange={(e) => setFriendNameInput(e.target.value)}
                placeholder={t('nameInputPlaceholder', undefined, 'e.g. Naor')}
                className="w-full py-2.5 px-3 rounded-xl photo-input text-xs font-semibold bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white"
                required
              />
            </div>

            {friendAddedMsg && (
              <p className="text-xs text-slate-900 dark:text-white font-extrabold text-center">
                {t('friendAddedToRoom', undefined, 'Friend added to room! ✓')}
              </p>
            )}

            <button
              type="submit"
              className="w-full py-3 rounded-full bg-brand-600 dark:bg-brand-300 text-white dark:text-brand-950 font-black text-xs hover:bg-brand-700 transition-all shadow-sm flex items-center justify-center gap-2"
            >
              <UserPlus className="w-4 h-4" />
              <span>{t('addFriendToRoomBtn', undefined, 'Add Friend to Room')}</span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
