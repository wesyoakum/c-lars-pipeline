// functions/lib/claudia-extract.js
//
// Extract plain text from a file uploaded to Claudia's drop-zone.
// Three content paths:
//
//   * text/plain, text/markdown, application/json, etc. — direct UTF-8
//     decode of the bytes.
//   * application/vnd.openxmlformats-officedocument.wordprocessingml.document
//     (.docx) — unzip with PizZip, pull <w:t> nodes out of
//     word/document.xml, concatenate.
//   * application/pdf — send the PDF to Claude as a `document` content
//     block and ask for plain-text extraction. Adds one model call per
//     upload but avoids a 1MB+ PDF parser dependency and handles tables,
//     scanned docs, and weird layouts better than most JS parsers.
//
// Returns { text, status: 'ready' | 'partial' | 'error', error? }.
// Caller should always store whatever `text` came back even on partial /
// error, so something is searchable; the status flag tells the UI
// whether to flag the row visibly.

import PizZip from 'pizzip';
import { aiBaseUrl, gatewayHeaders } from './ai-gateway.js';

const ANTHROPIC_VERSION = '2023-06-01';
const PDF_EXTRACT_MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap; full text dump doesn't need Sonnet

const TEXT_LIKE_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
]);

/**
 * Decide whether a content type is one we know how to extract.
 * Returns the extractor kind or null.
 */
export function classifyContentType(contentType, filename) {
  const ct = String(contentType || '').toLowerCase();
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (TEXT_LIKE_TYPES.has(ct)) return 'text';
  if (ct === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (
    ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    return 'docx';
  }
  // Unknown content types but with a text-ish extension → treat as text.
  if (['txt', 'md', 'markdown', 'csv', 'json', 'log'].includes(ext)) return 'text';
  return null;
}

/**
 * Extract text from a buffer based on its content type.
 *
 * @param {Object} env
 * @param {ArrayBuffer} buffer
 * @param {string} contentType
 * @param {string} filename
 * @returns {Promise<{text: string, status: 'ready'|'partial'|'error', error?: string}>}
 */
export async function extractText(env, buffer, contentType, filename) {
  const kind = classifyContentType(contentType, filename);
  if (!kind) {
    return {
      text: '',
      status: 'error',
      error: `Unsupported content type: ${contentType || '(none)'} for ${filename}`,
    };
  }

  try {
    if (kind === 'text') {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer).trim();
      return { text, status: 'ready' };
    }
    if (kind === 'docx') {
      const text = extractDocxText(buffer);
      return { text, status: text ? 'ready' : 'partial' };
    }
    if (kind === 'pdf') {
      const text = await extractPdfTextViaClaude(env, buffer);
      return { text, status: text ? 'ready' : 'partial' };
    }
  } catch (err) {
    return {
      text: '',
      status: 'error',
      error: err?.message || String(err),
    };
  }
  return { text: '', status: 'error', error: 'unreachable' };
}

// ---------- DOCX ----------

function extractDocxText(buffer) {
  const zip = new PizZip(buffer);
  const docXml = zip.file('word/document.xml')?.asText();
  if (!docXml) return '';
  // Pull all <w:t>...</w:t> contents and join with spaces. Paragraphs
  // (<w:p>) become newlines. Good enough for search and LLM context;
  // ignores formatting / tables / images.
  const parts = [];
  // Paragraph-aware: split on </w:p>, then within each paragraph harvest <w:t>.
  const paragraphs = docXml.split(/<\/w:p>/);
  for (const para of paragraphs) {
    const matches = para.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
    const text = matches
      .map((m) => m.replace(/<w:t[^>]*>/, '').replace(/<\/w:t>/, ''))
      .join('')
      .trim();
    if (text) parts.push(text);
  }
  return decodeHtmlEntities(parts.join('\n')).trim();
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// ---------- PDF (via Claude document content block) ----------

async function extractPdfTextViaClaude(env, buffer) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured for PDF extraction.');
  const base64 = bufferToBase64(buffer);
  const body = {
    model: env.ANTHROPIC_PDF_EXTRACT_MODEL || PDF_EXTRACT_MODEL,
    max_tokens: 8192,
    temperature: 0,
    system:
      'You convert documents to plain text. Output ONLY the extracted text from the document, ' +
      'in reading order. No preamble, no commentary, no markdown formatting beyond what the ' +
      'document itself uses. Preserve paragraph breaks. Skip page numbers and running ' +
      'headers/footers if they are clearly navigational. If a section is illegible, write ' +
      '[illegible] in its place rather than guessing.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          },
          { type: 'text', text: 'Extract the full text of this document.' },
        ],
      },
    ],
  };

  const url = `${aiBaseUrl(env, 'anthropic')}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      ...gatewayHeaders(env),
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`PDF extraction failed (${resp.status}): ${detail.slice(0, 400)}`);
  }
  const data = await resp.json();
  const text = (data?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text;
}

function bufferToBase64(buffer) {
  // Workers don't expose Buffer; use the chunked btoa approach.
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}
