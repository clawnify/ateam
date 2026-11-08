export const viewerHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Desktop</title>
<style>
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:#080e18;color:#e8e9ec;font:13px system-ui;height:100dvh;overflow:hidden}#screen{width:100%;height:100%;overflow:hidden}button,input{font:inherit}button{color:inherit;background:#353942;border:1px solid #555b66;border-radius:7px;padding:9px 12px;cursor:pointer;min-height:40px}button:disabled{opacity:.5;cursor:default}button:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid #87bfff;outline-offset:2px}#controls{position:fixed;bottom:max(12px,env(safe-area-inset-bottom));left:max(12px,env(safe-area-inset-left));z-index:2}summary{display:flex;align-items:center;justify-content:center;width:44px;height:44px;list-style:none;cursor:pointer;border:1px solid #ffffff20;border-radius:12px;background:#141a24d9;color:#b9c4d3;opacity:.35;transition:opacity .15s}summary::-webkit-details-marker{display:none}summary:hover,summary:focus-visible,#controls[open]>summary{opacity:1}#controls[data-controlling="true"]>summary{color:#a5d3ff;border-color:#87bfff80;opacity:.8}#panel{position:absolute;bottom:52px;left:0;width:340px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 80px);overflow:auto;background:#141a24f5;border:1px solid #ffffff24;border-radius:12px;padding:14px;box-shadow:0 12px 40px #0006}#status{display:block;line-height:1.5;color:#bac5d4;margin-bottom:12px}#textbar{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}#text{flex:1 1 100%;min-width:0;width:100%;font:16px system-ui;padding:10px;border:1px solid #555b66;border-radius:7px;background:#222b39;color:inherit}#error{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:3;max-width:calc(100vw - 24px);padding:10px 14px;margin:0;background:#301d20ed;color:#ffb2a9;border-radius:8px;line-height:1.5}#error:empty{display:none}@media(max-width:180px){#controls{display:none}}@media(prefers-reduced-motion:reduce){summary{transition:none}}
</style></head><body><main id="screen" aria-label="Remote desktop"></main><details id="controls"><summary aria-label="Desktop controls" title="Desktop controls"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="#141a24"/><circle cx="15" cy="17" r="3" fill="#141a24"/></svg></summary><section id="panel" aria-label="Desktop controls"><span id="status" role="status">Connecting…</span><button id="take" disabled>Take control</button><button id="release" hidden>Release control</button><form id="textbar" hidden><input id="text" aria-label="Text to type on the desktop" placeholder="Type text…" autocomplete="off"><button id="send" type="submit">Send text</button><button id="enter" type="button">Enter</button></form></section></details><p id="error" role="alert"></p><script type="module" src="/viewer.js"></script></body></html>`;

export const viewerScript = `
import RFB from '/core/rfb.js';
const settings = new URLSearchParams(location.hash.slice(1));
const token = settings.get('controlToken');
const password = settings.get('password');
const status = document.getElementById('status');
const error = document.getElementById('error');
const take = document.getElementById('take');
const release = document.getElementById('release');
const textbar=document.getElementById('textbar');
const text=document.getElementById('text');
const send=document.getElementById('send');
const controls=document.getElementById('controls');
const toggle=controls.querySelector('summary');
controls.addEventListener('keydown', e=>{ if(e.key==='Escape'){ e.stopPropagation(); controls.open=false; toggle.focus(); } });
let rfb, clientId, connected = false, taking = false, closing = false, polling = false;
let retry;
async function request(action) {
  const response = await fetch('/viewer/control', {
    method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({action,clientId}),
  });
  const body = await response.json();
  if (!response.ok) { const e = new Error(body.error || 'Desktop request failed'); e.status=response.status; throw e; }
  return body;
}
async function refresh() {
  if (!connected || taking || polling) return;
  polling=true; const current=rfb;
  try {
    const state = await request('status');
    if (current!==rfb || taking || !connected) return;
    error.textContent='';
    rfb.viewOnly = !state.controlling;
    controls.dataset.controlling=String(state.controlling);
    toggle.title=state.controlling?'Desktop controls · You have control':'Desktop controls';
    take.disabled = state.controlling;
    release.hidden = !state.controlling; textbar.hidden=!state.controlling;
    status.textContent = state.controlling ? 'You have control · desktop agent input is blocked' :
      state.owner ? 'Watching · '+state.owner.label+' has control' : 'Watching · desktop is available';
  } catch(e) {
    if (current===rfb) { error.textContent=e.message; rfb.viewOnly=true; take.disabled=true; if(e.status===409) rfb.disconnect(); }
  } finally { polling=false; }
}
take.onclick = async () => {
  taking=true; take.disabled=true; error.textContent=''; status.textContent='Taking control…';
  try { await request('take'); } catch(e) { error.textContent=e.message; }
  finally { taking=false; await refresh(); if (!rfb.viewOnly) { controls.open=false; rfb.focus(); } }
};
release.onclick = async () => {
  rfb.viewOnly=true;
  try { await request('release'); } catch(e) { error.textContent=e.message; }
  await refresh();
};
textbar.onsubmit=async (e) => {
  e.preventDefault(); if(!connected || rfb.viewOnly || send.disabled) return;
  const current=rfb; const value=text.value; send.disabled=true;
  try {
    for (const char of value) {
      if (current!==rfb || rfb.viewOnly || !connected) throw new Error('Control changed; text was interrupted.');
      const code=char.codePointAt(0);
      rfb.sendKey(code<=255?code:0x01000000|code);
      await new Promise(r=>setTimeout(r,12));
    }
    if(text.value===value) text.value='';
  } catch(e) { error.textContent=e.message; }
  finally { send.disabled=false; }
};
document.getElementById('enter').onclick=()=>{ if(connected && !rfb.viewOnly) rfb.sendKey(0xff0d); };
function connect() {
  if (closing) return;
  if (!token || !password) { error.textContent='Open this desktop from Ateam to authenticate.'; return; }
  clientId=crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
  rfb = new RFB(document.getElementById('screen'),
    (location.protocol==='https:'?'wss://':'ws://')+location.host+'/websockify?viewer='+clientId,
    { credentials:{password}, shared:true, wsProtocols:['binary','desktop-view.'+token] });
  const current=rfb;
  rfb.viewOnly=true; rfb.scaleViewport=true; rfb.resizeSession=false;
  rfb.addEventListener('connect', () => { if(current!==rfb) return; connected=true; error.textContent=''; take.disabled=false; refresh(); });
  rfb.addEventListener('disconnect', () => {
    if(current!==rfb) return;
    connected=false; controls.dataset.controlling='false'; error.textContent='Disconnected · reconnecting…'; take.disabled=true; release.hidden=true; textbar.hidden=true; status.textContent='Disconnected · reconnecting…';
    clearTimeout(retry); retry=setTimeout(connect,2000);
  });
  rfb.addEventListener('securityfailure', () => { if(current!==rfb) return; error.textContent='Desktop authentication failed. Reopen the viewer from Ateam.'; });
}
connect();
const poll = setInterval(refresh,1000);
addEventListener('pagehide', () => { closing=true; clearInterval(poll); clearTimeout(retry); rfb?.disconnect(); });
`;
