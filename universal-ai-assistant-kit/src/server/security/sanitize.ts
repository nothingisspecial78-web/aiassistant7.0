import type { RightClickContext } from '../../core/index.ts';

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeUserInput(text: string, maxLen = 8000): string {
  return text.replace(CONTROL_CHARS_RE, '').slice(0, maxLen).trim();
}

export function sanitizeContext(ctx: RightClickContext): RightClickContext {
  const cleanStr = (v: string | undefined, max = 500) =>
    v ? v.replace(CONTROL_CHARS_RE, '').slice(0, max).trim() : undefined;

  return {
    tag: cleanStr(ctx.tag, 40),
    cssSelector: cleanStr(ctx.cssSelector, 400),
    routePath: cleanStr(ctx.routePath, 300),
    text: cleanStr(ctx.text, 500),
    nearbyLabel: cleanStr(ctx.nearbyLabel, 300),
    selectedText: cleanStr(ctx.selectedText, 1000),
    pageTitle: cleanStr(ctx.pageTitle, 200),
  };
}

export function wrapUntrustedData(label: string, content: string): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const stripped = content
    .replace(/<\/?[a-zA-Z0-9_-]+[^>]*>/g, (tag) => tag.replace(/</g, '[').replace(/>/g, ']'))
    .slice(0, 12000);
  return `<untrusted_${safeLabel}>\n${stripped}\n</untrusted_${safeLabel}>`;
}

export function detectLanguage(text: string): 'en' | 'ml' {
  const malayalamCount = (text.match(/[\u0D00-\u0D7F]/g) || []).length;
  if (malayalamCount >= 2) return 'ml';
  return 'en';
}

export function sanitizeCsvCell(val: unknown): string {
  const raw = val === null || val === undefined ? '' : String(val);
  const formulaSafe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(formulaSafe)) {
    return `"${formulaSafe.replace(/"/g, '""')}"`;
  }
  return formulaSafe;
}

const ALLOWED_EXTENSION_MIME_MAP: Record<string, string[]> = {
  '.xlsx': [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
    'application/octet-stream',
  ],
  '.xls': [
    'application/vnd.ms-excel',
    'application/octet-stream',
  ],
  '.csv': ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
  '.tsv': ['text/tab-separated-values', 'text/plain'],
  '.pdf': ['application/pdf', 'application/octet-stream'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/octet-stream',
  ],
  '.txt': ['text/plain', 'application/octet-stream'],
  '.md': ['text/markdown', 'text/plain'],
  '.json': ['application/json', 'text/plain'],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.webp': ['image/webp'],
};

export function validateExtensionAndMime(
  fileName: string,
  mimeType: string
): { valid: boolean; reason?: string; ext: string } {
  const dotIdx = fileName.lastIndexOf('.');
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx).toLowerCase() : '';
  const allowedMimes = ALLOWED_EXTENSION_MIME_MAP[ext];
  if (!allowedMimes) {
    return {
      valid: false,
      ext,
      reason: `Unsupported file extension "${ext || 'none'}". Supported: ${Object.keys(ALLOWED_EXTENSION_MIME_MAP).join(', ')}`,
    };
  }
  const cleanMime = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (cleanMime && !allowedMimes.includes(cleanMime)) {
    return {
      valid: false,
      ext,
      reason: `MIME type "${cleanMime}" does not match extension "${ext}".`,
    };
  }
  return { valid: true, ext };
}

export function redactPiiForLog(input: string): string {
  return String(input || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/(?:\+?\d[\d\s-]{7,}\d)/g, '[REDACTED_PHONE]')
    .slice(0, 500);
}
