import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function renderMarkdownHtml(markdownText: string): string {
  const raw = String(markdownText || '');
  const parsed = marked.parse(raw, { async: false }) as string;
  return DOMPurify.sanitize(parsed);
}

export async function apiFetch<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload as T;
}
