// Composer attachments: images AND PDFs ride the same `AgentImage` pipeline
// (paste/drop → sdkSend → transcript backfill). Images go out as `image`
// content blocks, PDFs as `document` blocks (Messages API shape).
import type { AgentImage } from './types';

export const PDF_MEDIA_TYPE = 'application/pdf';

export function isPdfMediaType(mediaType: string): boolean {
  return mediaType === PDF_MEDIA_TYPE;
}

/** True for a file the composer turns into an attachment (vs a path in the text). */
export function isAttachableMediaType(mediaType: string): boolean {
  return mediaType.startsWith('image/') || isPdfMediaType(mediaType);
}

export type AttachmentContentBlock = {
  type: 'image' | 'document';
  source: { type: 'base64'; media_type: string; data: string };
};

/** The SDK user-message content block for one attachment. */
export function attachmentContentBlock(att: AgentImage): AttachmentContentBlock {
  return {
    type: isPdfMediaType(att.mediaType) ? 'document' : 'image',
    source: { type: 'base64', media_type: att.mediaType, data: att.dataBase64 },
  };
}

/** Inverse of {@link attachmentContentBlock} for the on-disk transcript; null
 *  for any other block (text, tool_result, url/file-sourced documents…). */
export function attachmentFromBlock(b: unknown): AgentImage | null {
  if (!b || typeof b !== 'object') return null;
  const blk = b as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } };
  const src = blk.source;
  if (!src || src.type !== 'base64' || typeof src.media_type !== 'string' || typeof src.data !== 'string') {
    return null;
  }
  if (blk.type === 'image') return { mediaType: src.media_type, dataBase64: src.data };
  if (blk.type === 'document' && isPdfMediaType(src.media_type)) {
    return { mediaType: src.media_type, dataBase64: src.data };
  }
  return null;
}
