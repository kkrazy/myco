// CodeMirror 6 entry point for esbuild bundling. The bundler stitches
// these imports into a single IIFE-wrapped `window.MycoCM` global the
// client uses to instantiate editors. Kept intentionally minimal — only
// the modes the file viewer actually needs (js/json/markdown/html/css/
// python). Adding a new mode is a one-line import + one-line factory
// entry + rebuild.
//
// Build: `npm run build:editor` → web/public/vendor/codemirror.bundle.js
// (~250 KB minified). Re-run after bumping CodeMirror versions in
// package.json.

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';

// Language modes — lazy-instantiated by the factory so the bundle doesn't
// pay the parser cost for files that don't use them.
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { python } from '@codemirror/lang-python';

// Pick a language extension from a file path suffix. Returns [] when no
// mode matches — the editor still works, just without syntax highlighting.
function languageForPath(path) {
  const p = String(path || '').toLowerCase();
  if (/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(p)) return [javascript({ jsx: /\.(jsx|tsx)$/.test(p), typescript: /\.(ts|tsx)$/.test(p) })];
  if (/\.json$/.test(p)) return [json()];
  if (/\.(md|markdown)$/.test(p)) return [markdown()];
  if (/\.html?$/.test(p)) return [html()];
  if (/\.(css|scss|sass)$/.test(p)) return [css()];
  if (/\.py$/.test(p)) return [python()];
  return [];
}

// Factory: create a fresh EditorView wired to a host element with the
// usual myco defaults. `onChange(doc)` fires on every transaction that
// modifies the doc (used by the client's dirty-state tracker).
function createEditor({ parent, doc, path, onChange, readOnly = false }) {
  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged && typeof onChange === 'function') {
      try { onChange(u.state.doc.toString()); } catch {}
    }
  });
  const extensions = [
    lineNumbers(),
    foldGutter(),
    history(),
    drawSelection(),
    bracketMatching(),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap, indentWithTab]),
    oneDark,
    EditorView.lineWrapping,
    EditorState.readOnly.of(readOnly),
    updateListener,
    ...languageForPath(path),
  ];
  const state = EditorState.create({ doc: doc || '', extensions });
  return new EditorView({ state, parent });
}

// Tiny API surface exposed to app.js as window.MycoCM. Kept thin so
// refactoring the bundle internals doesn't ripple into the client.
export { createEditor, EditorView, EditorState, languageForPath };
