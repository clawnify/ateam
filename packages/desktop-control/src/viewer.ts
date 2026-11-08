/** The viewer owns only human input. The authenticated gateway enforces ownership. */
export const viewerHtml = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Desktop</title><style>
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:#080e18;color:#e8e9ec;font:13px system-ui;height:100dvh;overflow:hidden}#screen{width:100%;height:100%;overflow:hidden}button,input{font:inherit}button{color:inherit;background:#141a24d9;border:1px solid #ffffff30;border-radius:9px;padding:9px 12px;cursor:pointer;min-height:40px}button:focus-visible,input:focus-visible{outline:2px solid #87bfff;outline-offset:2px}#keyboard{display:none;position:fixed;bottom:max(12px,env(safe-area-inset-bottom));left:12px;z-index:2;width:44px;padding:8px;opacity:.6}#textbar{position:fixed;bottom:max(12px,env(safe-area-inset-bottom));left:64px;right:12px;z-index:2;display:flex;gap:6px}#text{flex:1;min-width:0;font:16px system-ui;padding:9px;border:1px solid #555b66;border-radius:8px;background:#141a24f5;color:inherit}#error{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:3;max-width:calc(100vw - 24px);padding:10px 14px;margin:0;background:#301d20ed;color:#ffb2a9;border-radius:8px;line-height:1.5}#error:empty{display:none}@media(pointer:coarse) and (min-width:181px){#keyboard{display:block}}@media(max-width:180px){#textbar{display:none}}
</style></head><body><main id="screen" aria-label="Remote desktop"></main><button id="keyboard" aria-label="Show desktop keyboard" title="Show desktop keyboard"><svg width="24" height="20" viewBox="0 0 24 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1" y="3" width="22" height="14" rx="2"/><path d="M4 7h2m2 0h2m2 0h2m2 0h2m2 0h1M4 10h2m2 0h2m2 0h2m2 0h2m2 0h1M6 13h12"/></svg></button><form id="textbar" hidden><input id="text" aria-label="Text to type on the desktop" placeholder="Type text…" autocomplete="off"><button id="send" type="submit">Send</button><button id="enter" type="button">↵</button></form><p id="error" role="alert"></p><script type="module" src="/viewer.js"></script></body></html>`;

export const viewerScript = `
import RFB from '/core/rfb.js';
import {InputHandoff} from '/viewer-input.js';
const settings=new URLSearchParams(location.hash.slice(1));
const token=settings.get('controlToken'), password=settings.get('password');
const screen=document.getElementById('screen'), error=document.getElementById('error');
const keyboard=document.getElementById('keyboard'), textbar=document.getElementById('textbar');
const text=document.getElementById('text'), send=document.getElementById('send');
let current, retry, closing=false;
// noVNC 1.x defers resizing to requestAnimationFrame. An initially hidden
// Electron iframe can retain a zero-sized canvas after its container opens.
const resize=new ResizeObserver(()=>{ if(current?.rfb) current.rfb.scaleViewport=true; });
resize.observe(screen);
async function request(connection, action) {
  const abort=new AbortController(), timer=setTimeout(()=>abort.abort(),5000);
  try {
    const response=await fetch('/viewer/control', {
      method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
      body:JSON.stringify({action,clientId:connection.id}), signal:abort.signal,
    });
    const state=await response.json();
    if(!response.ok) throw new Error(state.error || 'Desktop request failed.');
    return state;
  } catch(e) {
    if(abort.signal.aborted) throw new Error('Desktop connection timed out. Reconnecting…');
    throw e;
  } finally { clearTimeout(timer); }
}
function fail(connection, e) {
  if(connection!==current) return;
  error.textContent=e.message;
  connection.handoff.close(); connection.socket.close();
}
function begin() {
  if(!current?.connected || innerWidth<=180) return;
  error.textContent='';
  return current.handoff.begin();
}
// Capture intent before noVNC handles it. Its encoded first click/key is queued
// until the existing server lock has cancelled and cleaned up agent input.
for(const event of ['mousedown','touchstart','wheel','keydown'])
  screen.addEventListener(event, begin, {capture:true,passive:true});
function release() { current?.handoff.release(); }
addEventListener('blur', release);
document.addEventListener('visibilitychange', ()=>{
  if(document.hidden) release();
  else if(current?.rfb) current.rfb.scaleViewport=true;
});
addEventListener('resize', ()=>{ if(innerWidth<=180) { release(); textbar.hidden=true; } });
keyboard.onclick=()=>{
  textbar.hidden=!textbar.hidden;
  keyboard.setAttribute('aria-label',textbar.hidden?'Show desktop keyboard':'Hide desktop keyboard');
  if(!textbar.hidden) { begin(); text.focus(); }
};
text.addEventListener('focus',begin);
textbar.onsubmit=async e=>{
  e.preventDefault(); if(!current?.connected || send.disabled) return;
  const connection=current, value=text.value; send.disabled=true;
  try {
    await begin();
    for(const char of value) {
      if(connection!==current || connection.handoff.closed || connection.rfb.viewOnly)
        throw new Error('Control changed; text was interrupted.');
      const code=char.codePointAt(0);
      connection.rfb.sendKey(code<=255?code:0x01000000|code);
      await new Promise(resolve=>setTimeout(resolve,12));
    }
    if(text.value===value) text.value='';
  } catch(e) { error.textContent=e.message; }
  finally { send.disabled=false; }
};
document.getElementById('enter').onclick=async()=>{
  const connection=current;
  await begin();
  if(connection===current && connection?.connected && !connection.rfb.viewOnly)
    connection.rfb.sendKey(0xff0d);
};
async function refresh() {
  const connection=current;
  if(!connection?.connected || connection.polling || connection.handoff.pending || connection.handoff.releasePending) return;
  connection.polling=true; const generation=connection.handoff.generation;
  try {
    const state=await request(connection,'status');
    if(connection===current && connection.connected) connection.handoff.sync(state,generation);
  } catch(e) { fail(connection,e); }
  finally { connection.polling=false; }
}
function connect() {
  if(closing) return;
  if(!token || !password) { error.textContent='Open this desktop from Ateam to authenticate.'; return; }
  const id=crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
  const socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/websockify?viewer='+id,['binary','desktop-view.'+token]);
  const connection={id,socket,connected:false,polling:false};
  current=connection;
  connection.handoff=new InputHandoff(socket, action=>request(connection,action),
    enabled=>{ if(connection.rfb) connection.rfb.viewOnly=!enabled; }, e=>fail(connection,e));
  connection.rfb=new RFB(screen,socket,{credentials:{password},shared:true});
  const rfb=connection.rfb;
  rfb.viewOnly=true; rfb.scaleViewport=true; rfb.resizeSession=false;
  rfb.addEventListener('connect',()=>{
    if(connection!==current) return;
    connection.connected=true; rfb.scaleViewport=true; error.textContent=''; refresh();
  });
  rfb.addEventListener('disconnect',()=>{
    if(connection!==current) return;
    connection.connected=false; connection.handoff.close();
    error.textContent='Disconnected · reconnecting…';
    clearTimeout(retry); retry=setTimeout(connect,2000);
  });
  rfb.addEventListener('securityfailure',()=>{
    if(connection===current) error.textContent='Desktop authentication failed. Reopen the viewer from Ateam.';
  });
}
connect();
const poll=setInterval(refresh,1000);
addEventListener('pagehide',()=>{
  closing=true; clearInterval(poll); clearTimeout(retry); resize.disconnect();
  current?.handoff.close(); current?.rfb.disconnect();
});
`;
