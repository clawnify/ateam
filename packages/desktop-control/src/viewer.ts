export const viewerHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Desktop</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#17191d;color:#e8e9ec;font:13px system-ui;display:flex;flex-direction:column;height:100dvh}header{display:flex;align-items:center;gap:12px;padding:9px 12px;border-bottom:1px solid #34373d;min-height:48px}#status{flex:1}button{font:inherit;color:inherit;background:#353942;border:1px solid #555b66;border-radius:5px;padding:6px 10px;cursor:pointer}button:disabled{opacity:.5;cursor:default}#textbar{display:flex;gap:8px;padding:8px 12px;border-top:1px solid #34373d}#textbar[hidden]{display:none}#text{flex:1;min-width:0;font:16px system-ui;padding:6px;border:1px solid #555b66;border-radius:5px;background:#22252b;color:inherit}#screen{flex:1;min-height:0;overflow:hidden}#error{color:#ffb2a9;padding:0 12px;margin:0}button:focus-visible{outline:2px solid #87bfff;outline-offset:2px}
</style></head><body><header><span id="status" role="status">Connecting…</span><button id="take" disabled>Take control</button><button id="release" hidden>Release control</button></header><p id="error" role="alert"></p><main id="screen" aria-label="Remote desktop"></main><form id="textbar" hidden><input id="text" aria-label="Text to type on the desktop" placeholder="Type text…" autocomplete="off"><button id="send" type="submit">Send text</button><button id="enter" type="button">Enter</button></form><script type="module" src="/viewer.js"></script></body></html>`;

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
  finally { taking=false; await refresh(); if (!rfb.viewOnly) rfb.focus(); }
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
    connected=false; take.disabled=true; release.hidden=true; textbar.hidden=true; status.textContent='Disconnected · reconnecting…';
    clearTimeout(retry); retry=setTimeout(connect,2000);
  });
  rfb.addEventListener('securityfailure', () => { if(current!==rfb) return; error.textContent='Desktop authentication failed. Reopen the viewer from Ateam.'; });
}
connect();
const poll = setInterval(refresh,1000);
addEventListener('pagehide', () => { closing=true; clearInterval(poll); clearTimeout(retry); rfb?.disconnect(); });
`;
