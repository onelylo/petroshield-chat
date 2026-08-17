import React, { useEffect, useRef, useState } from 'react';
import { FileText, Download, Loader2, ImageIcon, File as FileIcon, AlertTriangle, Play } from 'lucide-react';
import type { LocalMessage } from '../types/chat';
import {
  downloadEncryptedAttachment,
  formatFileSize,
} from '../lib/attachments';
import { decryptBinaryData } from '../lib/crypto';
import { AudioPlayer } from './AudioPlayer';

interface AttachmentMessageProps {
  message: LocalMessage;
  isMe: boolean;
  resolveKey: (msg: LocalMessage) => Promise<CryptoKey | null>;
  onImageClick: (url: string, fileName?: string) => void;
}

export const AttachmentMessage: React.FC<AttachmentMessageProps> = ({ message, isMe, resolveKey, onImageClick }) => {
  const [isPreparing, setIsPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const createdUrls = useRef<Set<string>>(new Set());

  const meta = message.attachmentMeta;
  const fileName = meta?.fileName || 'attachment';
  const inferredMimeType = meta?.mimeType || 
    (fileName.toLowerCase().endsWith('.png') ? 'image/png' :
     fileName.toLowerCase().endsWith('.jpg') || fileName.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' :
     fileName.toLowerCase().endsWith('.gif') ? 'image/gif' :
     fileName.toLowerCase().endsWith('.webp') ? 'image/webp' :
     'application/octet-stream');
  const isImage = inferredMimeType.startsWith('image/');
  const isAudio = inferredMimeType.startsWith('audio/') ||
    /\.(mp3|wav|m4a|ogg|webm)$/i.test(fileName);

  const trackUrl = (url: string) => {
    createdUrls.current.add(url);
    return url;
  };

  useEffect(() => {
    return () => {
      createdUrls.current.forEach(url => URL.revokeObjectURL(url));
      createdUrls.current.clear();
    };
  }, []);

  const fetchDecryptedUrl = async (): Promise<string> => {
    const token = localStorage.getItem('petroshield_jwt') || sessionStorage.getItem('petroshield_jwt');
    const key = await resolveKey(message);
    if (!token || !key || !message.attachment) throw new Error('Decryption key unavailable');
    try {
      const ciphertext = await downloadEncryptedAttachment(token, message.attachment.attachmentId);
      const decrypted = await decryptBinaryData(ciphertext, message.attachment.binaryIv, key);
      const blob = new Blob([decrypted], { type: inferredMimeType });
      return trackUrl(URL.createObjectURL(blob));
    } catch (e) {
      console.error('[Attachment] Decrypt error:', e);
      throw e;
    }
  };

  const decryptAndOpen = async () => {
    const token = localStorage.getItem('petroshield_jwt') || sessionStorage.getItem('petroshield_jwt');
    const key = await resolveKey(message);
    if (!token || !key || !message.attachment) {
      setError('Decryption key unavailable');
      return;
    }
    try {
      setIsPreparing(true);
      const ciphertext = await downloadEncryptedAttachment(token, message.attachment.attachmentId);
      const decrypted = await decryptBinaryData(ciphertext, message.attachment.binaryIv, key);
      const blob = new Blob([decrypted], { type: inferredMimeType });
      const url = trackUrl(URL.createObjectURL(blob));
      if (isAudio) {
        setAudioUrl(url);
      } else {
        onImageClick(url, meta?.fileName);
      }
    } catch (e) {
      console.error('[Attachment] Decrypt error:', e);
      setError('Failed to decrypt attachment locally.');
    } finally {
      setIsPreparing(false);
    }
  };

  if (!meta) {
    const fileName = 'attachment';

    return (
      <div className="relative group/att">
        <button
          onClick={decryptAndOpen}
          className="max-w-[300px] rounded-lg p-6 flex flex-col items-center space-y-2 transition-smooth cursor-pointer"
          style={{ border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-surface)', color: 'var(--text-muted)' }}
          onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent-primary)'}
          onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}
        >
          <ImageIcon className="w-8 h-8" />
          <span className="text-[10px]">ENCRYPTED ATTACHMENT — CLICK TO DECRYPT</span>
          <span className="text-[9px] opacity-70">{fileName}</span>
        </button>
        
        <button
          onClick={decryptAndOpen}
          disabled={isPreparing}
          title="Download decrypted file"
          className="absolute top-1.5 right-1.5 p-1.5 rounded-lg opacity-0 group-hover/att:opacity-100 transition-all disabled:opacity-30"
          style={{ backgroundColor: 'color-mix(in srgb, var(--bg-app) 80%, transparent)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--accent-primary)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
        >
          <Download className="w-3.5 h-3.5" />
        </button>
        
        {error && (
          <p className="mt-1 text-[10px] flex items-center space-x-1" style={{ color: '#f87171' }}>
            <AlertTriangle className="w-3 h-3" />
            <span>{error}</span>
          </p>
        )}
      </div>
    );
  }

  if (isImage) {
    return (
      <div className="relative group/att">
        {meta.thumbnailDataUrl ? (
          <img
            src={meta.thumbnailDataUrl}
            alt={meta.fileName}
            onClick={decryptAndOpen}
            title="Click to decrypt & view full image"
            className="max-w-[300px] max-h-[300px] rounded-lg object-cover cursor-zoom-in"
            style={{ border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-surface)' }}
          />
) : (
          <button
            onClick={decryptAndOpen}
            className="max-w-[300px] rounded-lg p-6 flex flex-col items-center space-y-2 transition-smooth"
            style={{ border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-surface)', color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent-primary)'}
            onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}
          >
            <ImageIcon className="w-8 h-8" />
            <span className="text-[10px]">ENCRYPTED IMAGE — CLICK TO DECRYPT</span>
          </button>
        )}

        <button
          onClick={decryptAndOpen}
          disabled={isPreparing}
          title="Download decrypted file"
          className="absolute top-1.5 right-1.5 p-1.5 rounded-lg opacity-0 group-hover/att:opacity-100 transition-all disabled:opacity-30"
          style={{ backgroundColor: 'color-mix(in srgb, var(--bg-app) 80%, transparent)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--accent-primary)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
        >
          <Download className="w-3.5 h-3.5" />
        </button>

        {error && (
          <p className="mt-1 text-[10px] flex items-center space-x-1" style={{ color: '#f87171' }}>
            <AlertTriangle className="w-3 h-3" />
            <span>{error}</span>
          </p>
        )}
      </div>
    );
  }

  if (isAudio) {
    return (
      <div className="relative group/att">
        {audioUrl ? (
          <AudioPlayer src={audioUrl} fileName={meta.fileName} />
        ) : (
          <button
            onClick={decryptAndOpen}
            disabled={isPreparing}
            className="flex items-center space-x-3 rounded-xl p-3 min-w-[240px] max-w-[300px] transition-smooth"
            style={{ backgroundColor: 'color-mix(in srgb, var(--bg-app) 60%, transparent)', border: '1px solid var(--border-color)' }}
            onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent-primary)'}
            onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}
          >
            <div className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' }}>
              {isPreparing ? <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--accent-primary)' }} /> : <Play className="w-5 h-5 ml-0.5" style={{ color: 'var(--accent-primary)' }} />}
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-main)' }}>{meta.fileName}</p>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {formatFileSize(meta.fileSize)} · Click to play
              </p>
            </div>
          </button>
        )}

        {error && (
          <p className="mt-1 text-[10px] flex items-center space-x-1" style={{ color: '#f87171' }}>
            <AlertTriangle className="w-3 h-3" />
            <span>{error}</span>
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center space-x-3 rounded-xl p-3 min-w-[240px] max-w-[300px]" style={{ backgroundColor: 'color-mix(in srgb, var(--bg-app) 60%, transparent)', border: '1px solid var(--border-color)' }}>
        <div className="w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
          <FileText className="w-6 h-6" style={{ color: '#f87171' }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-main)' }} title={meta.fileName}>
            {meta.fileName}
          </p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {formatFileSize(meta.fileSize)} · {meta.mimeType || 'FILE'}
          </p>
          {error && (
            <p className="text-[10px] flex items-center space-x-1 mt-0.5" style={{ color: '#f87171' }}>
              <AlertTriangle className="w-3 h-3" />
              <span>{error}</span>
            </p>
          )}
        </div>
        <button
          onClick={decryptAndOpen}
          disabled={isPreparing}
          title="Decrypt & download"
          className="p-2 rounded-lg flex-shrink-0 transition-smooth"
          style={{ backgroundColor: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)', color: 'var(--accent-primary)' }}
          onMouseEnter={e => e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--accent-primary) 20%, transparent)'}
          onMouseLeave={e => e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--accent-primary) 10%, transparent)'}
        >
          {isPreparing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        </button>
      </div>
      {meta.mimeType === 'application/pdf' && (
        <p className="text-[9px] mt-1 flex items-center space-x-1" style={{ color: 'var(--text-muted)' }}>
          <FileIcon className="w-2.5 h-2.5" />
          <span>PDF — decrypted on device</span>
        </p>
      )}
    </div>
  );
};