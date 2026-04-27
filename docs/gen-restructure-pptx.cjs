const pptxgen = require("pptxgenjs");
const path = require("path");

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.author = "C-LARS";
pres.title = "C-LARS Pipeline — Object Model Restructure";

// Palette: Midnight Executive
const NAVY    = "1E2761";
const ICE     = "CADCFC";
const WHITE   = "FFFFFF";
const DARK    = "0F1535";
const ACCENT  = "3B82F6";  // bright blue accent
const MUTED   = "94A3B8";
const BODY_BG = "F0F4F8";
const CARD_BG = "FFFFFF";
const TEXT_DK = "1E293B";
const TEXT_MD = "475569";
const GREEN   = "10B981";
const AMBER   = "F59E0B";
const ROSE    = "F43F5E";

const FONT_HEAD = "Georgia";
const FONT_BODY = "Calibri";

// ── Slide 1: Title ──────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: DARK };

  // Decorative top bar
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.06, fill: { color: ACCENT }
  });

  s.addText("C-LARS Pipeline", {
    x: 0.8, y: 1.4, w: 8.4, h: 0.7,
    fontFace: FONT_HEAD, fontSize: 20, color: ICE,
    charSpacing: 6, bold: false
  });

  s.addText("Object Model Restructure", {
    x: 0.8, y: 2.1, w: 8.4, h: 1.2,
    fontFace: FONT_HEAD, fontSize: 40, color: WHITE, bold: true
  });

  s.addText("C-LARS Pipeline — April 2026", {
    x: 0.8, y: 3.5, w: 8.4, h: 0.5,
    fontFace: FONT_BODY, fontSize: 14, color: MUTED
  });

  // Bottom accent line
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 4.8, w: 2, h: 0.04, fill: { color: ACCENT }
  });
}

// ── Slide 2: Full Object Tree ───────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: BODY_BG };

  s.addText("Object Hierarchy", {
    x: 0.6, y: 0.3, w: 8.8, h: 0.7,
    fontFace: FONT_HEAD, fontSize: 30, color: NAVY, bold: true, margin: 0
  });

  // Tree on left side in a dark card
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.4, y: 1.2, w: 5.8, h: 4.1,
    fill: { color: DARK },
    shadow: { type: "outer", blur: 8, offset: 3, angle: 135, color: "000000", opacity: 0.15 }
  });

  const tree = [
    { text: "Account", options: { fontSize: 13, color: ICE, fontFace: "Consolas", bold: true, breakLine: true } },
    { text: " ├── Opportunity", options: { fontSize: 12, color: ACCENT, fontFace: "Consolas", bold: true, breakLine: true } },
    { text: " │     ├── Quotes", options: { fontSize: 12, color: GREEN, fontFace: "Consolas", bold: true, breakLine: true } },
    { text: " │     │     ├── Line Items → Items Library", options: { fontSize: 11, color: WHITE, fontFace: "Consolas", breakLine: true } },
    { text: " │     │     │     ├── Price Builds → Builds Library", options: { fontSize: 11, color: WHITE, fontFace: "Consolas", breakLine: true } },
    { text: " │     │     │     │     ├── DM Selections → DM Library", options: { fontSize: 10, color: MUTED, fontFace: "Consolas", breakLine: true } },
    { text: " │     │     │     │     └── DL Selections → DL Library", options: { fontSize: 10, color: MUTED, fontFace: "Consolas", breakLine: true } },
    { text: " │     │     │     └── Documents", options: { fontSize: 10, color: MUTED, fontFace: "Consolas", breakLine: true } },
    { text: " │     │     ├── Documents", options: { fontSize: 11, color: WHITE, fontFace: "Consolas", breakLine: true } },
    { text: " │     │     └── Jobs", options: { fontSize: 11, color: AMBER, fontFace: "Consolas", bold: true, breakLine: true } },
    { text: " │     ├── Activities", options: { fontSize: 11, color: WHITE, fontFace: "Consolas", breakLine: true } },
    { text: " │     │     └── Documents", options: { fontSize: 10, color: MUTED, fontFace: "Consolas", breakLine: true } },
    { text: " │     ├── External Artifacts", options: { fontSize: 11, color: WHITE, fontFace: "Consolas", breakLine: true } },
    { text: " │     └── Documents", options: { fontSize: 11, color: WHITE, fontFace: "Consolas", breakLine: true } },
    { text: " ├── Contact", options: { fontSize: 12, color: ACCENT, fontFace: "Consolas", bold: true, breakLine: true } },
    { text: " │     └── Documents", options: { fontSize: 10, color: MUTED, fontFace: "Consolas", breakLine: true } },
    { text: " └── Documents", options: { fontSize: 11, color: WHITE, fontFace: "Consolas" } },
  ];

  s.addText(tree, {
    x: 0.65, y: 1.35, w: 5.3, h: 3.8,
    valign: "top", paraSpaceAfter: 1
  });

  // Legend on right
  const legendY = 1.3;
  const legendItems = [
    { color: ICE, label: "Root entity" },
    { color: ACCENT, label: "Primary children" },
    { color: GREEN, label: "Quotes (key change)" },
    { color: AMBER, label: "Jobs (moved)" },
    { color: WHITE, label: "Standard children" },
    { color: MUTED, label: "Leaf / attachments" },
  ];

  s.addText("Legend", {
    x: 6.6, y: legendY, w: 3, h: 0.4,
    fontFace: FONT_HEAD, fontSize: 14, color: NAVY, bold: true, margin: 0
  });

  legendItems.forEach((item, i) => {
    const ly = legendY + 0.5 + i * 0.38;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 6.6, y: ly + 0.06, w: 0.22, h: 0.22, fill: { color: item.color },
      line: { color: "CBD5E1", width: 0.5 }
    });
    s.addText(item.label, {
      x: 6.95, y: ly, w: 2.5, h: 0.34,
      fontFace: FONT_BODY, fontSize: 11, color: TEXT_DK, margin: 0
    });
  });

  // "→ arrows indicate shared library links" note
  s.addText("→  arrows indicate shared library links", {
    x: 6.6, y: legendY + 0.5 + legendItems.length * 0.38 + 0.15, w: 3.2, h: 0.35,
    fontFace: FONT_BODY, fontSize: 10, color: TEXT_MD, italic: true, margin: 0
  });
}

// ── Slide 3: What Changes ───────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: BODY_BG };

  s.addText("What Changes", {
    x: 0.6, y: 0.3, w: 8.8, h: 0.7,
    fontFace: FONT_HEAD, fontSize: 30, color: NAVY, bold: true, margin: 0
  });

  const changes = [
    { title: "Price Builds move to Line Item level", desc: "Each quote line item gets its own price build instead of one per opportunity" },
    { title: "New Items Library", desc: "Shared catalog of products/services with default pricing — quote lines pick from it" },
    { title: "New Builds Library", desc: "Reusable price build templates that can be pulled into any line item" },
    { title: "Jobs move under Quotes", desc: "A Job is the execution of a won quote, not the opportunity itself" },
    { title: "Documents attach at every level", desc: "Polymorphic document attachment — quotes, lines, activities, contacts, accounts" },
    { title: "Quote-level cost build link removed", desc: "No more single cost_build_id on the quote — pricing lives at the line level" },
  ];

  const colors = [ACCENT, GREEN, GREEN, AMBER, "8B5CF6", ROSE];

  changes.forEach((c, i) => {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const cx = 0.5 + col * 4.7;
    const cy = 1.2 + row * 1.4;

    // Card
    s.addShape(pres.shapes.RECTANGLE, {
      x: cx, y: cy, w: 4.4, h: 1.2,
      fill: { color: CARD_BG },
      shadow: { type: "outer", blur: 4, offset: 2, angle: 135, color: "000000", opacity: 0.08 }
    });

    // Left accent bar
    s.addShape(pres.shapes.RECTANGLE, {
      x: cx, y: cy, w: 0.06, h: 1.2,
      fill: { color: colors[i] }
    });

    s.addText(c.title, {
      x: cx + 0.2, y: cy + 0.1, w: 4.0, h: 0.4,
      fontFace: FONT_BODY, fontSize: 13, color: TEXT_DK, bold: true, margin: 0
    });

    s.addText(c.desc, {
      x: cx + 0.2, y: cy + 0.5, w: 4.0, h: 0.6,
      fontFace: FONT_BODY, fontSize: 11, color: TEXT_MD, margin: 0
    });
  });
}

// ── Slide 4: Shared Libraries ───────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: BODY_BG };

  s.addText("Shared Libraries", {
    x: 0.6, y: 0.3, w: 8.8, h: 0.7,
    fontFace: FONT_HEAD, fontSize: 30, color: NAVY, bold: true, margin: 0
  });

  s.addText("Reusable catalogs that feed into quotes and price builds", {
    x: 0.6, y: 0.9, w: 8.8, h: 0.4,
    fontFace: FONT_BODY, fontSize: 14, color: TEXT_MD, margin: 0
  });

  const libs = [
    { name: "Items Library", desc: "Products & services you sell", detail: "Default price, description, unit\nQuote lines reference these", color: ACCENT },
    { name: "Builds Library", desc: "Reusable pricing templates", detail: "Pre-configured price builds\nPull into any line item", color: GREEN },
    { name: "DM Library", desc: "Direct material cost items", detail: "Material costs with suppliers\nUsed within price builds", color: AMBER },
    { name: "DL Library", desc: "Direct labor cost items", detail: "Labor rates and hours\nUsed within price builds", color: "8B5CF6" },
  ];

  libs.forEach((lib, i) => {
    const cx = 0.35 + i * 2.38;
    const cy = 1.6;
    const cw = 2.18;
    const ch = 3.4;

    // Card
    s.addShape(pres.shapes.RECTANGLE, {
      x: cx, y: cy, w: cw, h: ch,
      fill: { color: CARD_BG },
      shadow: { type: "outer", blur: 6, offset: 2, angle: 135, color: "000000", opacity: 0.1 }
    });

    // Top color bar
    s.addShape(pres.shapes.RECTANGLE, {
      x: cx, y: cy, w: cw, h: 0.06,
      fill: { color: lib.color }
    });

    // Color circle with initial
    s.addShape(pres.shapes.OVAL, {
      x: cx + (cw - 0.6) / 2, y: cy + 0.3, w: 0.6, h: 0.6,
      fill: { color: lib.color }
    });
    s.addText(lib.name.charAt(0), {
      x: cx + (cw - 0.6) / 2, y: cy + 0.3, w: 0.6, h: 0.6,
      fontFace: FONT_BODY, fontSize: 20, color: WHITE, bold: true,
      align: "center", valign: "middle"
    });

    // Name
    s.addText(lib.name, {
      x: cx + 0.1, y: cy + 1.1, w: cw - 0.2, h: 0.4,
      fontFace: FONT_BODY, fontSize: 14, color: TEXT_DK, bold: true,
      align: "center", margin: 0
    });

    // Subtitle
    s.addText(lib.desc, {
      x: cx + 0.1, y: cy + 1.5, w: cw - 0.2, h: 0.35,
      fontFace: FONT_BODY, fontSize: 11, color: TEXT_MD,
      align: "center", margin: 0
    });

    // Detail
    s.addText(lib.detail, {
      x: cx + 0.15, y: cy + 2.1, w: cw - 0.3, h: 1.0,
      fontFace: FONT_BODY, fontSize: 10, color: TEXT_MD,
      align: "center", valign: "top", margin: 0
    });
  });
}

// ── Slide 5: Migration Path ─────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: DARK };

  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.06, fill: { color: ACCENT }
  });

  s.addText("Migration Path", {
    x: 0.6, y: 0.3, w: 8.8, h: 0.7,
    fontFace: FONT_HEAD, fontSize: 30, color: WHITE, bold: true, margin: 0
  });

  s.addText("Schema & code changes required", {
    x: 0.6, y: 0.9, w: 8.8, h: 0.4,
    fontFace: FONT_BODY, fontSize: 14, color: MUTED, margin: 0
  });

  const steps = [
    { num: "1", text: "Restructure cost_builds → price_builds under quote_lines", tag: "Schema" },
    { num: "2", text: "Create items_library and builds_library tables", tag: "Schema" },
    { num: "3", text: "Create dm_library and dl_library tables", tag: "Schema" },
    { num: "4", text: "Move jobs FK from opportunity_id to quote_id", tag: "Schema" },
    { num: "5", text: "Remove quote-level cost_build_id", tag: "Cleanup" },
    { num: "6", text: "Update route handlers and UI for new relationships", tag: "Code" },
  ];

  steps.forEach((step, i) => {
    const sy = 1.55 + i * 0.62;

    // Number circle
    s.addShape(pres.shapes.OVAL, {
      x: 0.7, y: sy + 0.05, w: 0.42, h: 0.42,
      fill: { color: ACCENT }
    });
    s.addText(step.num, {
      x: 0.7, y: sy + 0.05, w: 0.42, h: 0.42,
      fontFace: FONT_BODY, fontSize: 14, color: WHITE, bold: true,
      align: "center", valign: "middle"
    });

    // Step text
    s.addText(step.text, {
      x: 1.3, y: sy, w: 6.5, h: 0.5,
      fontFace: FONT_BODY, fontSize: 14, color: WHITE, margin: 0
    });

    // Tag
    const tagColor = step.tag === "Schema" ? ACCENT : step.tag === "Code" ? GREEN : AMBER;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 8.2, y: sy + 0.07, w: 1.0, h: 0.34,
      fill: { color: tagColor }
    });
    s.addText(step.tag, {
      x: 8.2, y: sy + 0.07, w: 1.0, h: 0.34,
      fontFace: FONT_BODY, fontSize: 10, color: WHITE, bold: true,
      align: "center", valign: "middle"
    });
  });

  // Bottom accent
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.7, y: 5.2, w: 2, h: 0.04, fill: { color: ACCENT }
  });
}

// ── Write file ──────────────────────────────────────────────────
const outPath = path.join(__dirname, "pipeline-restructure.pptx");
pres.writeFile({ fileName: outPath }).then(() => {
  console.log("Created:", outPath);
}).catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
