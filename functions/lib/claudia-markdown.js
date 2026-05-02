// functions/lib/claudia-markdown.js
//
// Tiny safe-by-construction markdown → HTML renderer used to format
// Claudia's chat bubble bodies. Hand-rolled rather than pulled in as
// a dep so we can be precise about the subset we accept and the
// escaping we do.
//
// Inputs are HTML-escaped FIRST, then we re-introduce a fixed set of
// safe HTML tags (<strong>, <em>, <code>, <a>, <ul>, <ol>, <li>, <p>,
// <br>, <h3>–<h6>) by string-replacement. Because the input was
// already escaped, no path produces user-supplied tags or attributes
// — the only attribute we emit is href, and we cap it to http(s) /
// mailto schemes to block javascript:-style XSS.

const ALLOWED_URL = /^(https?|mailto):/i;

export function renderMarkdown(raw) {
  if (raw == null) return '';
  const escaped = escapeHtml(String(raw));
  const lines = escaped.split('\n');
  const out = [];
  // Block accumulator for consecutive bullet/numbered list items + paragraphs.
  let current = null;

  function flush() {
    if (!current) return;
    if (current.type === 'p') {
      out.push(`<p>${current.items.join('<br>')}</p>`);
    } else if (current.type === 'ul') {
      out.push(`<ul>${current.items.map((t) => `<li>${t}</li>`).join('')}</ul>`);
    } else if (current.type === 'ol') {
      out.push(`<ol>${current.items.map((t) => `<li>${t}</li>`).join('')}</ol>`);
    }
    current = null;
  }

  for (const line of lines) {
    if (line.trim() === '') {
      flush();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flush();
      // Cap minimum at h3 — chat bubbles shouldn't have screaming h1/h2.
      const level = Math.min(Math.max(heading[1].length + 2, 3), 6);
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s{0,3}[-*]\s+(.+)$/);
    if (bullet) {
      if (!current || current.type !== 'ul') { flush(); current = { type: 'ul', items: [] }; }
      current.items.push(inlineMarkdown(bullet[1]));
      continue;
    }

    const numbered = line.match(/^\s{0,3}\d+\.\s+(.+)$/);
    if (numbered) {
      if (!current || current.type !== 'ol') { flush(); current = { type: 'ol', items: [] }; }
      current.items.push(inlineMarkdown(numbered[1]));
      continue;
    }

    // Plain paragraph line.
    if (!current || current.type !== 'p') { flush(); current = { type: 'p', items: [] }; }
    current.items.push(inlineMarkdown(line));
  }
  flush();
  return out.join('\n');
}

function inlineMarkdown(s) {
  // Order matters: links first (so * inside link text isn't mistaken
  // for emphasis), then bold (**), then code (`), then em (*).
  let result = s;
  result = result.replace(
    /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    (_, label, url) => {
      const trimmed = url.trim();
      const safe = ALLOWED_URL.test(trimmed) ? trimmed : '#';
      return `<a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
  );
  result = result.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // *italic* — only when not adjacent to another asterisk (avoid eating into bold).
  result = result.replace(/(^|[^*\w])\*([^*\n]+?)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
  return result;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}
