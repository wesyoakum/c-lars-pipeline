// functions/lib/icons.js
//
// Minimalist stroke-based SVG icons used across the UI as a
// replacement for emojis. See feedback_minimalist_icons.md for the
// rationale (emojis render inconsistently, look childish on a B2B
// CRM, and don't inherit currentColor).
//
// All icons:
//   - 24×24 viewBox
//   - rendered at 18×18 by default (chips can override via CSS)
//   - stroke="currentColor" so they pick up the surrounding color
//   - stroke-width 1.8 — matches the existing [+] icon vocabulary
//
// Usage in a server-side template:
//   import { ICON_CAMERA } from '../lib/icons.js';
//   html`<button>${raw(ICON_CAMERA)}</button>`
//
// Mirror these strings in client-only JS (e.g. js/ai-capture.js)
// where modules can't import server modules; see feedback file.

const COMMON_ATTRS =
  'width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"';

/** Outlined camera. */
export const ICON_CAMERA =
  `<svg ${COMMON_ATTRS}>
    <path d="M3 8h3l2-2h8l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/>
    <circle cx="12" cy="13.5" r="3.5"/>
  </svg>`;

/** Outlined microphone (capsule + base + stand). */
export const ICON_MIC =
  `<svg ${COMMON_ATTRS}>
    <rect x="9" y="3" width="6" height="11" rx="3"/>
    <path d="M5 11v1a7 7 0 0 0 14 0v-1"/>
    <line x1="12" y1="19" x2="12" y2="22"/>
    <line x1="8" y1="22" x2="16" y2="22"/>
  </svg>`;

/** Paperclip / attach. */
export const ICON_PAPERCLIP =
  `<svg ${COMMON_ATTRS}>
    <path d="M21 11l-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/>
  </svg>`;

/** Keyboard — used for "type a note" in capture surfaces. */
export const ICON_KEYBOARD =
  `<svg ${COMMON_ATTRS}>
    <rect x="2" y="6" width="20" height="12" rx="2"/>
    <line x1="6" y1="10" x2="6.01" y2="10"/>
    <line x1="10" y1="10" x2="10.01" y2="10"/>
    <line x1="14" y1="10" x2="14.01" y2="10"/>
    <line x1="18" y1="10" x2="18.01" y2="10"/>
    <line x1="7" y1="14" x2="17" y2="14"/>
  </svg>`;

/** Drop zone — arrow into a tray. Reads as "drop here" without
 * being too literal. Used as a hint affordance on drag-and-drop
 * surfaces (wizard smart-start, future capture sites). */
export const ICON_DROPZONE =
  `<svg ${COMMON_ATTRS}>
    <path d="M3 16.5V20a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3.5"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="3" x2="12" y2="15"/>
  </svg>`;
