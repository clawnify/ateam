// The HTML document that runs inside the terminal WebView: xterm.js + the fit
// addon (both inlined, offline) plus a small bridge to the React Native host.
//
// Bridge protocol (mirrors the desktop Terminal.tsx + connect-cli exactly):
//   RN → webview   window.__termWrite(str)  write PTY bytes into xterm
//                  window.__termFit()       refit to the viewport, report new size
//                  window.__termFocus()     focus (pop the keyboard)
//   webview → RN   postMessage {type:"ready", cols, rows}   xterm mounted
//                  postMessage {type:"input", data}          user keystrokes → pty.write
//                  postMessage {type:"resize", cols, rows}   fit changed → pty.resize
import { FIT_ADDON_JS, XTERM_CSS, XTERM_JS } from "./xterm-assets";

// Terminal look matches the desktop renderer (black bg, #e6e6ea fg, mono).
export function buildTerminalHtml(): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<style>
${XTERM_CSS}
html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
#term { position: absolute; inset: 0; padding: 6px 8px; box-sizing: border-box; }
.xterm { height: 100%; }
</style>
</head>
<body>
<div id="term"></div>
<script>${XTERM_JS}</script>
<script>${FIT_ADDON_JS}</script>
<script>
(function () {
  var post = function (msg) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  };
  var Term = (window.Terminal || (window.xterm && window.xterm.Terminal));
  var FitCtor = (window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon));
  var term = new Term({
    fontSize: 12,
    fontFamily: 'ui-monospace, Menlo, "SF Mono", monospace',
    cursorBlink: true,
    theme: { background: "#000000", foreground: "#e6e6ea" },
    scrollback: 5000,
    // Touch scrolling: let the WebView own vertical drags for scrollback.
    macOptionIsMeta: true
  });
  var fit = new FitCtor();
  term.loadAddon(fit);
  term.open(document.getElementById("term"));

  function refit() {
    try { fit.fit(); } catch (e) {}
    post({ type: "resize", cols: term.cols, rows: term.rows });
  }

  // RN → webview
  window.__termWrite = function (s) { term.write(s); };
  window.__termFit = function () { refit(); };
  window.__termFocus = function () { term.focus(); };
  // Blur the hidden textarea → iOS dismisses the keyboard, revealing the full terminal.
  window.__termBlur = function () {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  };

  // webview → RN
  term.onData(function (d) { post({ type: "input", data: d }); });
  window.addEventListener("resize", refit);

  // Touch scrollback: xterm only scrolls on wheel events (none on touch). Handle it
  // at the DOCUMENT level with capture + preventDefault, so xterm's focused hidden
  // textarea can't swallow the gesture. A drag scrolls the buffer; a tap (no real
  // movement) focuses to bring the keyboard back after it was dismissed. (On an
  // alt-screen TUI like Claude there's no scrollback, so scrollLines is a no-op —
  // that's expected; use "Hide keyboard" to see the full screen there.)
  var startY = 0, lastY = 0, moved = false, tracking = false;
  var CELL = 16; // ~fontSize 12 line height; good enough for touch scroll feel
  document.addEventListener("touchstart", function (e) {
    startY = lastY = e.touches[0].clientY; moved = false; tracking = true;
  }, { passive: false, capture: true });
  document.addEventListener("touchmove", function (e) {
    if (!tracking) return;
    var y = e.touches[0].clientY;
    if (Math.abs(y - startY) > 4) moved = true;
    var dy = lastY - y;
    var lines = dy > 0 ? Math.floor(dy / CELL) : Math.ceil(dy / CELL);
    if (lines !== 0) { term.scrollLines(lines); lastY = y - (dy % CELL); }
    if (moved) e.preventDefault();
  }, { passive: false, capture: true });
  document.addEventListener("touchend", function () {
    if (tracking && !moved) term.focus(); // a tap re-opens the keyboard
    tracking = false;
  }, { capture: true });

  // First paint: fit, then tell RN we're ready (it snapshots + streams from here).
  setTimeout(function () {
    refit();
    term.focus();
    post({ type: "ready", cols: term.cols, rows: term.rows });
  }, 0);
})();
true;
</script>
</body>
</html>`;
}
