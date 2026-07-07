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

  // Touch scrollback: xterm only scrolls on wheel events (none on touch), so map a
  // vertical drag to term.scrollLines. A drag scrolls; a tap (no real movement)
  // focuses to bring the keyboard back after it was dismissed.
  var el = document.getElementById("term");
  var startY = 0, lastY = 0, moved = false;
  var CELL = 17; // ~fontSize 12 line height; good enough for touch scroll feel
  el.addEventListener("touchstart", function (e) {
    startY = lastY = e.touches[0].clientY; moved = false;
  }, { passive: true });
  el.addEventListener("touchmove", function (e) {
    var y = e.touches[0].clientY;
    var dy = lastY - y;
    if (Math.abs(y - startY) > 6) moved = true;
    var lines = (dy / CELL) | 0;
    if (lines !== 0) { term.scrollLines(lines); lastY = y; }
  }, { passive: true });
  el.addEventListener("touchend", function () {
    if (!moved) term.focus(); // a tap (not a scroll) re-opens the keyboard
  });

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
