import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(__dirname, "../packages/ui/src/index.css");
const cssContent = fs.readFileSync(cssPath, "utf-8");

function parseHex(hex) {
  let c = hex.replace("#", "").trim();
  if (c.length === 3) {
    c = c.split("").map((ch) => ch + ch).join("");
  }
  const num = Number.parseInt(c, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function luminance(hex) {
  const rgb = parseHex(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrastRatio(hex1, hex2) {
  const l1 = luminance(hex1);
  const l2 = luminance(hex2);
  const brightest = Math.max(l1, l2);
  const darkest = Math.min(l1, l2);
  return (brightest + 0.05) / (darkest + 0.05);
}

function extractCssVars(block) {
  const vars = {};
  const regex = /--([\w-]+):\s*([^;]+);/g;
  let match;
  while ((match = regex.exec(block)) !== null) {
    vars[match[1]] = match[2].trim();
  }
  return vars;
}

// Split into :root and dark blocks
const rootIndex = cssContent.indexOf(":root {");
const darkIndex = cssContent.indexOf(":root.dark,");
const keyframesIndex = cssContent.indexOf("@keyframes");

const lightBlock = cssContent.slice(rootIndex, darkIndex);
const darkBlock = cssContent.slice(darkIndex, keyframesIndex !== -1 ? keyframesIndex : undefined);

const lightVars = extractCssVars(lightBlock);
const darkVars = extractCssVars(darkBlock);

console.log("=== THEME PANEL HEX RESOLUTION ===");
console.log(`Light Theme --bg-panel : ${lightVars["bg-panel"]} (True hex in CSS: #ffffff)`);
console.log(`Light Theme --bg-page  : ${lightVars["bg-page"]} (Linen #f8f5ee)`);
console.log(`Dark Theme  --bg-panel : ${darkVars["bg-panel"]} (Anthracite #26292e)`);
console.log(`Dark Theme  --bg-page  : ${darkVars["bg-page"]} (Anthracite #1e2024)\n`);

const pairs = [
  { role: "Primary Body Text on Page", fg: "ink-primary", bg: "bg-page" },
  { role: "Primary Body Text on Panel", fg: "ink-primary", bg: "bg-panel" },
  { role: "Secondary Text on Page", fg: "ink-secondary", bg: "bg-page" },
  { role: "Secondary Text on Panel", fg: "ink-secondary", bg: "bg-panel" },
  { role: "Muted Labels on Panel", fg: "ink-muted", bg: "bg-panel" },
  { role: "Muted Labels on Page", fg: "ink-muted", bg: "bg-page" },
  { role: "Accent Button (White on Paprika)", fg: "accent-fg", bg: "accent" },
  { role: "Status: Completed Text on Tag", fg: "status-completed-fg", bg: "status-completed-bg" },
  { role: "Status: Failed Text on Tag", fg: "status-failed-fg", bg: "status-failed-bg" },
  { role: "Status: Running/Approval on Tag", fg: "status-running-fg", bg: "status-running-bg" },
  { role: "Status: Shadow Marker on Tag", fg: "status-shadow-fg", bg: "status-shadow-bg" },
];

function evaluateTheme(themeName, vars) {
  console.log(`=== ${themeName.toUpperCase()} THEME WCAG CONTRAST AUDIT ===`);
  console.log(
    "| Role / Element | Foreground | Background | Ratio | WCAG Compliance |"
  );
  console.log(
    "| :--- | :--- | :--- | :---: | :--- |"
  );

  for (const p of pairs) {
    const fgHex = vars[p.fg];
    const bgHex = vars[p.bg];
    if (!fgHex || !bgHex) {
      console.warn(`Missing var for ${p.role}: fg=${p.fg}(${fgHex}) bg=${p.bg}(${bgHex})`);
      continue;
    }
    const ratio = contrastRatio(fgHex, bgHex);
    let compliance = "FAIL (< 4.5:1)";
    if (ratio >= 7.0) {
      compliance = "AAA (Pass >= 7:1)";
    } else if (ratio >= 4.5) {
      compliance = "AA (Pass >= 4.5:1)";
    } else if (ratio >= 3.0) {
      compliance = "AA Large (>= 3:1)";
    }

    console.log(
      `| ${p.role} | \`${fgHex}\` (\`--${p.fg}\`) | \`${bgHex}\` (\`--${p.bg}\`) | **${ratio.toFixed(2)}:1** | ${compliance} |`
    );
  }
  console.log("\n");
}

evaluateTheme("Light", lightVars);
evaluateTheme("Dark", darkVars);
