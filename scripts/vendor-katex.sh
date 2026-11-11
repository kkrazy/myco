#!/usr/bin/env bash
# Vendor KaTeX (JS + CSS + woff2 fonts) into web/public/vendor/ so math
# renders offline — no CDN at runtime, matching how marked / mermaid /
# highlight / rough are already vendored.
#
# Idempotent: re-running re-fetches into place. Human-runnable:
#   ./scripts/vendor-katex.sh
#
# Env:
#   KATEX_VERSION  pin (default 0.16.11)
#   CDN            base (default jsdelivr)
set -euo pipefail

KATEX_VERSION="${KATEX_VERSION:-0.16.11}"
CDN="${CDN:-https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist}"

# Resolve repo root from this script's location (works from any cwd).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="${SCRIPT_DIR}/../web/public/vendor"
FONTS="${VENDOR}/fonts"

mkdir -p "${VENDOR}" "${FONTS}"

dl() {
  # dl <url> <dest>
  local url="$1" dest="$2"
  echo "  → ${dest##*/}"
  curl -fsSL --retry 3 -o "${dest}" "${url}" \
    || { echo "FAILED: ${url}" >&2; exit 1; }
}

echo "Vendoring KaTeX ${KATEX_VERSION} from ${CDN}"

# Core JS + CSS.
dl "${CDN}/katex.min.js"  "${VENDOR}/katex.min.js"
dl "${CDN}/katex.min.css" "${VENDOR}/katex.min.css"

# Fonts referenced by katex.min.css (relative path: fonts/KaTeX_*.woff2).
# Only woff2 — every browser myco targets supports it; skipping woff/ttf
# keeps the vendored payload small.
FONT_FACES=(
  AMS-Regular
  Caligraphic-Bold Caligraphic-Regular
  Fraktur-Bold Fraktur-Regular
  Main-Bold Main-BoldItalic Main-Italic Main-Regular
  Math-BoldItalic Math-Italic
  SansSerif-Bold SansSerif-Italic SansSerif-Regular
  Script-Regular
  Size1-Regular Size2-Regular Size3-Regular Size4-Regular
  Typewriter-Regular
)
for face in "${FONT_FACES[@]}"; do
  dl "${CDN}/fonts/KaTeX_${face}.woff2" "${FONTS}/KaTeX_${face}.woff2"
done

# Rewrite the CSS font-face srcs to woff2-only (drop the woff/ttf
# fallbacks we deliberately didn't vendor, so the browser doesn't 404
# chasing them). Keeps the format('woff2') entry, strips the rest.
node - "$VENDOR/katex.min.css" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
let css = fs.readFileSync(p, 'utf8');
// In each @font-face src list, keep only the woff2 url(...) format('woff2').
css = css.replace(/src:[^;]*;/g, (m) => {
  const woff2 = m.match(/url\([^)]*\.woff2\)\s*format\(["']woff2["']\)/);
  return woff2 ? `src:${woff2[0]};` : m;
});
fs.writeFileSync(p, css);
console.log('  ~ rewrote katex.min.css font-face src → woff2-only');
NODE

echo "Done. Vendored to ${VENDOR} (+ fonts/)."
echo "Sanity:"
echo "  katex.min.js  $(wc -c < "${VENDOR}/katex.min.js") bytes"
echo "  katex.min.css $(wc -c < "${VENDOR}/katex.min.css") bytes"
echo "  fonts:        $(ls -1 "${FONTS}"/KaTeX_*.woff2 | wc -l) woff2 files"
