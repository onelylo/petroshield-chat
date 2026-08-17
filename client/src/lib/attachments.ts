/**
 * PetroShield Encrypted Attachment Pipeline
 * - uploadEncryptedAttachment: POST encrypted bytes + metadata to the server
 * - downloadEncryptedAttachment: fetch encrypted binary payload by id
 * - generateImageThumbnail: client-side canvas downscale (max 300px) for previews
 *
 * The server only ever receives ciphertext; all decryption happens here/browser.
 */
import { base64ToArrayBuffer } from './crypto';
import type { PendingUpload } from '../types/chat';

export const API_BASE = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Uploads an already-encrypted attachment. Returns the server-assigned id.
 * Supports an optional onProgress callback (0-100).
 */
export async function uploadEncryptedAttachment(
  token: string,
  data: PendingUpload,
  onProgress?: (percent: number) => void
): Promise<string> {
  const binary = base64ToArrayBuffer(data.encryptedBinary);
  const blob = new Blob([binary], { type: 'application/octet-stream' });

  const form = new FormData();
  form.append('file', blob, 'encrypted_attachment.enc');
  form.append('encryptedMetadata', data.encryptedMetadata);
  form.append('binaryIv', data.binaryIv);
  form.append('metadataIv', data.metadataIv);

  if (onProgress) {
    return new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/api/attachments/upload`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.timeout = 120000;
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
      xhr.addEventListener('load', () => {
        try {
          const json = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(json.attachmentId as string);
          } else {
            reject(new Error(json?.error || `Server error (${xhr.status})`));
          }
        } catch {
          reject(new Error(`Upload failed (HTTP ${xhr.status})`));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
      xhr.addEventListener('timeout', () => reject(new Error('Upload timed out')));
      xhr.send(form);
    });
  }

  const res = await fetch(`${API_BASE}/api/attachments/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || 'Attachment upload failed');
  return json.attachmentId as string;
}

/**
 * Downloads the encrypted binary payload. Returns the raw ArrayBuffer ciphertext
 * — decryption is done locally via WebCrypto (see decryptBinaryData).
 */
export async function downloadEncryptedAttachment(
  token: string,
  attachmentId: string
): Promise<ArrayBuffer> {
  const res = await fetch(`${API_BASE}/api/attachments/${attachmentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Attachment download failed');
  return await res.arrayBuffer();
}

/**
 * Renders a scaled-down preview of an image (max 300px wide) into an in-memory
 * canvas in the browser BEFORE encryption. The resulting data URL travels inside
 * the encrypted metadata blob — never stored plaintext on the server.
 */
export async function generateImageThumbnail(file: File, maxWidth = 300): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);

  const scale = Math.min(1, maxWidth / Math.max(1, img.naturalWidth));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.7);
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = src;
  });
}
