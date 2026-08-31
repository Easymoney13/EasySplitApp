'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Camera, Image as ImageIcon, Zap, RotateCcw, X, Keyboard, AlertCircle } from 'lucide-react';
import { useLanguage } from './LanguageContext';
import { createReceiptDraft, receiptScanUserMessage } from '../../lib/receiptScanClient';
import { OCRProgressOverlay } from './OCRProgressOverlay';

interface CameraViewfinderProps {
  onScanComplete: (receiptData: any) => void;
  onCancel: () => void;
  onManualEntry?: () => void;
  parseOnly?: boolean;
  hostName?: string;
}

export const CameraViewfinder: React.FC<CameraViewfinderProps> = ({
  onScanComplete,
  onCancel,
  onManualEntry,
  parseOnly = false,
  hostName = 'Host',
}) => {
  let isRtl = false;
  let t = (_key: string, _params?: any, fallback?: string) => fallback || '';
  try {
    const lang = useLanguage();
    isRtl = lang.isRtl;
    t = lang.t;
  } catch (_) {}

  const [flashOn, setFlashOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [isScanning, setIsScanning] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraPermissionGranted, setCameraPermissionGranted] = useState<boolean | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startCamera = useCallback(async (facing: 'environment' | 'user') => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera access not supported on this browser');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });

      streamRef.current = stream;
      const videoTrack = stream.getVideoTracks()[0];
      const capabilities = videoTrack && typeof videoTrack.getCapabilities === 'function'
        ? videoTrack.getCapabilities() as MediaTrackCapabilities & { torch?: boolean }
        : null;
      setTorchSupported(Boolean(capabilities?.torch));
      setFlashOn(false);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraPermissionGranted(true);
      setCameraError(null);
    } catch (err: any) {
      console.error('Camera permission error:', err);
      setCameraPermissionGranted(false);
      setCameraError(err.message || 'Camera permission denied or camera not found');
    }
  }, []);

  useEffect(() => {
    void startCamera(facingMode);

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, [facingMode, startCamera]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !torchSupported) return;
    const nextValue = !flashOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: nextValue } as MediaTrackConstraintSet] });
      setFlashOn(nextValue);
    } catch (_) {
      setTorchSupported(false);
      setFlashOn(false);
    }
  };

  const toggleFacingMode = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  };

  const processImageForOCR = async (imageToScan: string) => {
    if (!imageToScan) return;
    setIsScanning(true);
    try {
      const draft = await createReceiptDraft(imageToScan, hostName);
      onScanComplete({
        success: true,
        receipt: { ...draft.receipt, imageQuality: draft.imageQuality, _previewImages: draft.previewImages },
        scanId: draft.scanId,
        recoveryToken: draft.recoveryToken,
        confirmationRequired: true,
        usedLocalFallback: draft.usedLocalFallback,
      });
    } catch (err) {
      console.error(err);
      alert(receiptScanUserMessage(t));
    } finally {
      setIsScanning(false);
    }
  };

  const handleSnapAndScan = async () => {
    if (capturedImage) {
      await processImageForOCR(capturedImage);
      return;
    }

    if (!videoRef.current || !canvasRef.current) {
      fileInputRef.current?.click();
      return;
    }

    // Trigger visual shutter flash
    setIsFlashing(true);
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate(30); } catch (_) {}
    }
    setTimeout(() => setIsFlashing(false), 150);

    const video = videoRef.current;
    const canvas = canvasRef.current;

    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      setCapturedImage(dataUrl);
      await processImageForOCR(dataUrl);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async () => {
        const source = typeof reader.result === 'string' ? reader.result : '';
        if (!source) return;
        setCapturedImage(source);
        await processImageForOCR(source);
      };
      reader.readAsDataURL(file);
    }
  };

  if (isScanning) {
    return <OCRProgressOverlay isVisible={true} />;
  }

  return (
    <div className="fixed inset-0 z-50 bg-black text-white flex flex-col justify-between overflow-hidden select-none animate-fadeIn">
      {/* Hidden elements for capture & file upload */}
      <canvas ref={canvasRef} className="hidden" />
      <input
        type="file"
        ref={fileInputRef}
        accept="image/*"
        onChange={handleFileUpload}
        className="hidden"
      />

      {/* Main Full-Bleed Live Viewfinder Display */}
      <div className="relative flex-1 w-full h-full bg-black overflow-hidden flex items-center justify-center">
        {capturedImage ? (
          <img
            src={capturedImage}
            alt="Captured Bill"
            className="w-full h-full object-cover"
          />
        ) : cameraPermissionGranted === false ? (
          <div className="flex flex-col items-center justify-center p-6 text-center max-w-xs space-y-4">
            <div className="w-16 h-16 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center text-rose-400">
              <Camera className="w-8 h-8" />
            </div>
            <p className="text-sm font-medium text-slate-300">
              {isRtl ? 'נדרשת הרשאת מצלמה לסריקת קבלות' : 'Camera permission is required to scan bills'}
            </p>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-5 py-2.5 rounded-full bg-white text-slate-950 font-bold text-xs hover:bg-slate-100 active:scale-95 transition-all shadow-lg flex items-center gap-2"
            >
              <ImageIcon className="w-4 h-4" />
              <span>{isRtl ? 'העלאה מהגלריה' : 'Upload from Gallery'}</span>
            </button>
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
        )}

        {/* Shutter Flash Animation Overlay */}
        <div
          className="absolute inset-0 bg-white pointer-events-none transition-opacity duration-150 z-20"
          style={{ opacity: isFlashing ? 0.9 : 0 }}
        />
      </div>

      {/* Top Bar - Minimal Modern Apple Controls */}
      <div className="absolute top-0 inset-x-0 z-30 flex items-center justify-between p-4 pt-[max(1rem,env(safe-area-inset-top))] bg-gradient-to-b from-black/75 via-black/35 to-transparent">
        {/* Close Button */}
        <button
          onClick={onCancel}
          className="w-11 h-11 rounded-full bg-black/40 backdrop-blur-xl border border-white/15 text-white hover:bg-black/60 active:scale-90 transition-all flex items-center justify-center shadow-lg cursor-pointer"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Type Bill Manually Option (Above) */}
        {onManualEntry ? (
          <button
            onClick={onManualEntry}
            className="px-4 py-2 rounded-full bg-black/45 backdrop-blur-xl border border-white/15 text-white/90 hover:text-white hover:bg-black/65 active:scale-95 transition-all flex items-center gap-2 text-xs font-bold shadow-lg cursor-pointer"
          >
            <Keyboard className="w-4 h-4 text-brand-300" />
            <span>{isRtl ? 'הקלדה ידנית' : 'Type Bill'}</span>
          </button>
        ) : <div className="w-11 h-11" />}

        {/* Flashlight / Torch Toggle */}
        {torchSupported ? (
          <button
            onClick={toggleTorch}
            className={`w-11 h-11 rounded-full backdrop-blur-xl border active:scale-90 transition-all flex items-center justify-center shadow-lg cursor-pointer ${
              flashOn
                ? 'bg-amber-400 text-slate-950 border-amber-300 shadow-amber-400/40'
                : 'bg-black/40 text-white border-white/15 hover:bg-black/60'
            }`}
            aria-label={flashOn ? 'Turn torch off' : 'Turn torch on'}
          >
            <Zap className={`w-5 h-5 ${flashOn ? 'fill-current' : ''}`} />
          </button>
        ) : (
          <div className="w-11 h-11" />
        )}
      </div>

      {/* Bottom Bar - Apple iOS Camera Controls Layout */}
      <div className="absolute bottom-0 inset-x-0 z-30 pb-[max(2rem,env(safe-area-inset-bottom))] pt-6 px-8 bg-gradient-to-t from-black/90 via-black/60 to-transparent">
        <div className="flex items-center justify-between max-w-sm mx-auto w-full">
          {/* Gallery / File Picker (Bottom Left) */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-13 h-13 rounded-full bg-white/15 hover:bg-white/25 active:scale-90 backdrop-blur-xl border border-white/20 flex items-center justify-center text-white transition-all shadow-xl cursor-pointer"
            aria-label="Upload photo"
            title="Upload photo"
          >
            <ImageIcon className="w-6 h-6 text-white/90" />
          </button>

          {/* Apple Style Shutter Button (Center) */}
          <button
            onClick={handleSnapAndScan}
            disabled={isScanning}
            className="w-20 h-20 rounded-full border-[3.5px] border-white p-1 flex items-center justify-center active:scale-90 hover:scale-105 transition-all duration-150 shadow-2xl cursor-pointer select-none disabled:opacity-50"
            aria-label="Take Photo"
          >
            <div className="w-full h-full rounded-full bg-white transition-all shadow-inner active:bg-slate-200" />
          </button>

          {/* Flip Camera / Retake (Bottom Right) */}
          <button
            onClick={capturedImage ? () => setCapturedImage(null) : toggleFacingMode}
            className="w-13 h-13 rounded-full bg-white/15 hover:bg-white/25 active:scale-90 backdrop-blur-xl border border-white/20 flex items-center justify-center text-white transition-all shadow-xl cursor-pointer"
            aria-label={capturedImage ? 'Retake Photo' : 'Switch Camera'}
            title={capturedImage ? 'Retake Photo' : 'Switch Camera'}
          >
            <RotateCcw className="w-6 h-6 text-white/90" />
          </button>
        </div>
      </div>
    </div>
  );
};

