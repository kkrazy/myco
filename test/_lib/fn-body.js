// test/_lib/fn-body.js
// Helpers for slicing function bodies out of a source string without
// having to hard-code a window size.
//
// Why a helper at all:
// Tests historically used `src.slice(at, at + N)` with a hard-coded
// `N` (60, 600, 8000, …). As source files grow, `N` becomes too small
// and the assertions stop covering the lines the test author cared
// about — silently. bug-52 + td-33 both hit this on 2026-06-05 when
// bug-71 added 21 lines to `_renderVerdictPanel` and the fixed
// 8000/12000-byte windows dropped the textarea / retry-handler off
// the end. The fix-of-the-day was bumping `N`; the structural fix is
// to size the window to the actual function body.
//
// End-of-function detection: the convention throughout this codebase
// for both top-level `function foo() { … }` and `async function`
// declarations is the closing `}` lives on a line by itself at
// column 0. Inner closures / object literals have their braces
// indented, so this `^}$` heuristic reliably stops at the outer
// function's end. The same convention is used by the awk patterns
// in `test/test.sh` (`awk '/^function …/,/^}$/'`).
//
// Both helpers are pure string ops — no AST, no I/O, no deps — so
// they cost ~zero per call and run anywhere Node runs.

// sliceFn: slice from `anchor` (an offset into `src`) to the end of
// the enclosing top-level function body. Returns the empty string if
// `anchor` is null / negative (no function found).
//
// Typical call site (replaces `src.slice(at, at + N)`):
//   const at = src.search(/function\s+foo\s*\(/);
//   const body = sliceFn(src, at);
function sliceFn(src, anchor) {
  if (anchor == null || anchor < 0) return '';
  const rest = src.slice(anchor);
  // Match the first standalone-`}` line: `\n}` followed by optional
  // whitespace and then a newline or EOF. Indented braces are
  // skipped (the inner-closure end markers we don't want to catch).
  const m = rest.match(/\n}\s*?(\r?\n|$)/);
  return m ? rest.slice(0, m.index + m[0].length) : rest;
}

// fnBody: convenience wrapper that searches for `fnRegex` in `src`
// and returns the body. Returns '' if no match.
//   const body = fnBody(src, /function\s+foo\s*\(/);
function fnBody(src, fnRegex) {
  return sliceFn(src, src.search(fnRegex));
}

module.exports = { sliceFn, fnBody };
