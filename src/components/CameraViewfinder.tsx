'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Camera, Upload, Flashlight, RefreshCw, X } from 'lucide-react';
import { useLanguage } from './LanguageContext';
import { createReceiptDraft, receiptScanUserMessage } from '../../lib/receiptScanClient';
import { EasySplitLoadingScreen } from './EasySplitLoadingScreen';

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
  const { t } = useLanguage();
  const [flashOn, setFlashOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraPermissionGranted, setCameraPermissionGranted] = useState<boolean | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Request camera permission and start video stream on mount
  useEffect(() => {
    let isMounted = true;

    async function startCamera() {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Camera access not supported on this browser');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        });

        if (!isMounted) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const videoTrack = stream.getVideoTracks()[0];
        const capabilities = videoTrack && typeof videoTrack.getCapabilities === 'function'
          ? videoTrack.getCapabilities() as MediaTrackCapabilities & { torch?: boolean }
          : null;
        setTorchSupported(Boolean(capabilities?.torch));
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCameraPermissionGranted(true);
      } catch (err: any) {
        console.error('Camera permission error:', err);
        if (isMounted) {
          setCameraPermissionGranted(false);
          setCameraError(err.message || 'Camera permission denied or camera not found');
        }
      }
    }

    startCamera();

    return () => {
      isMounted = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

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

  // Snap photo from live video feed
  const handleSnapPhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      setCapturedImage(dataUrl);
    }
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

  const handleCaptureAndScan = async () => {
    let imageToScan = capturedImage;
    if (!imageToScan) {
      if (videoRef.current && canvasRef.current) {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          imageToScan = canvas.toDataURL('image/jpeg', 0.9);
          setCapturedImage(imageToScan);
        }
      }
    }

    if (!imageToScan) {
      alert('Please take a photo or select an image first.');
      return;
    }

    await processImageForOCR(imageToScan);
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
    return <EasySplitLoadingScreen isOverlay={true} />;
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/95 backdrop-blur-md flex flex-col justify-between p-5 animate-fadeIn text-white">
      {/* Hidden canvas for taking video snapshot */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Top Bar */}
      <div className="flex items-center justify-between z-10">
        <button
          onClick={onCancel}
          className="p-2 rounded-full bg-slate-800/80 text-xs font-extrabold hover:bg-slate-700 transition-colors flex items-center gap-1"
        >
          <X className="w-4 h-4" />
          <span>{t('cancelBtn', undefined, 'Cancel')}</span>
        </button>

        <span className="text-xs font-black uppercase tracking-widest text-slate-300">
          {t('receiptScannerTitle', undefined, 'Camera Receipt OCR')}
        </span>

        <div className="flex items-center gap-2">
          {onManualEntry && (
            <button
              onClick={onManualEntry}
              className="py-1.5 px-3 rounded-full bg-slate-800/80 hover:bg-slate-700 text-xs font-bold text-slate-200 transition-colors"
            >
              {t('manualBtn', undefined, 'Manual')}
            </button>
          )}

          {torchSupported ? (
            <button
              onClick={toggleTorch}
              aria-label={flashOn ? 'Turn torch off' : 'Turn torch on'}
              className={`p-2.5 rounded-full transition-all ${
                flashOn ? 'bg-lime-400 text-slate-950 shadow-lime-glow' : 'bg-slate-800/80 text-white'
              }`}
            >
              <Flashlight className="w-4 h-4" />
            </button>
          ) : <div className="w-9" aria-hidden="true" />}
        </div>
      </div>

      {/* Center Camera Viewfinder Stream */}
      <div className="relative flex-1 flex flex-col items-center justify-center my-3">
        <div className="relative w-full max-w-xs aspect-[3/4] rounded-3xl border-2 border-dashed border-white/80 overflow-hidden shadow-2xl flex items-center justify-center bg-black">
          {capturedImage ? (
            <img src={capturedImage} alt="Captured bill" className="w-full h-full object-cover" />
          ) : cameraPermissionGranted === false ? (
            <div className="text-center p-6 space-y-3">
              <Camera className="w-10 h-10 mx-auto text-rose-400" />
              <p className="text-xs font-semibold text-rose-300">
                Camera permission is required to scan bills.
              </p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="py-2 px-4 rounded-full bg-white text-slate-950 text-xs font-extrabold hover:bg-slate-100 flex items-center gap-2 mx-auto"
              >
                <Upload className="w-4 h-4" />
                <span>{t('uploadPhoto', undefined, 'Upload from Gallery')}</span>
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

          {/* Scanning Beam Animation */}
          {isScanning && (
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-white/40 to-transparent animate-scanBeam" />
          )}

          {/* Viewfinder Target Frame Overlay */}
          {!capturedImage && cameraPermissionGranted && (
            <div className="absolute inset-4 border border-white/40 rounded-2xl pointer-events-none flex flex-col justify-between p-3">
              <span className="text-[10px] text-white/70 font-mono tracking-wider text-center bg-black/40 py-1 px-2 rounded-full backdrop-blur-md">
                Position bill within frame & tap shutter
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Controls */}
      <div className="space-y-3 max-w-xs mx-auto w-full z-10">
        <input
          type="file"
          ref={fileInputRef}
          accept="image/*"
          onChange={handleFileUpload}
          className="hidden"
        />

        <div className="flex items-center justify-center gap-5">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-3.5 rounded-full bg-slate-800 text-white hover:bg-slate-700 hover:scale-105 active:scale-95 transition-all shadow-md flex items-center justify-center group"
            title={t('uploadPhoto', undefined, 'Upload from Gallery')}
            aria-label={t('uploadPhoto', undefined, 'Upload from Gallery')}
          >
            <Upload className="w-5 h-5 text-brand-400 group-hover:text-brand-300" />
          </button>

          {/* Big Shutter Button */}
          <button
            onClick={capturedImage ? handleCaptureAndScan : () => { handleSnapPhoto(); setTimeout(handleCaptureAndScan, 200); }}
            disabled={isScanning}
            className="w-16 h-16 rounded-full bg-white p-1 flex items-center justify-center shadow-xl hover:scale-105 active:scale-95 transition-all disabled:opacity-60"
          >
            <div className="w-full h-full rounded-full border-2 border-slate-950 flex items-center justify-center">
              {isScanning ? (
                <RefreshCw className="w-6 h-6 text-slate-950 animate-spin" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-slate-950" />
              )}
            </div>
          </button>

          <button
            onClick={() => setCapturedImage(null)}
            className="p-3.5 rounded-full bg-slate-800 text-white hover:bg-slate-700 transition-colors"
            title="Retake Photo"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>

        <p className="text-[11px] text-center text-slate-400 font-mono">
          {isScanning
            ? t('scanningOCRText', undefined, 'Extracting receipt items with OCR...')
            : capturedImage
            ? 'Tap shutter to process OCR'
            : 'Tap white shutter to snap bill & run OCR'}
        </p>
      </div>
    </div>
  );
};
