// noVNC accepts a WebSocket channel. Buffer its already-encoded input during
// takeover, rather than recreating its mouse, touch, or keyboard handling.
export const viewerInputScript = `
export class InputHandoff {
  constructor(socket, request, enable, fail) {
    this.socket=socket; this.request=request; this.enable=enable; this.fail=fail;
    this.owned=false; this.pending=false; this.closed=false; this.generation=0;
    this.queue=[]; this.bytes=0; this.releasing=Promise.resolve(); this.releasePending=false;
    this.send=socket.send.bind(socket);
    socket.send=data=>{
      if(this.closed) return;
      if(!this.pending) { this.send(data); return; }
      // noVNC reuses its send buffer immediately after send() returns.
      const copy=new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength).slice();
      this.bytes+=copy.byteLength;
      if(this.bytes>65536) { this.close(); this.fail(new Error('Input interrupted while reconnecting.')); return; }
      this.queue.push(copy);
    };
  }
  begin() {
    // Another viewer can take over between status polls. Confirm each new
    // gesture; the server treats a confirmation by the same owner as a no-op.
    if(this.closed) return Promise.resolve();
    if(this.pending) return this.taking;
    const generation=++this.generation;
    this.pending=true; this.enable(true);
    this.taking=(async()=>{
    try {
      await this.releasing;
      if(this.closed || generation!==this.generation) return;
      const state=await this.request('take');
      if(this.closed || generation!==this.generation) return;
      if(!state.controlling) throw new Error('Desktop control was interrupted. Try again.');
      this.owned=true; this.pending=false;
      for(const data of this.queue) this.send(data);
      this.queue=[]; this.bytes=0;
    } catch(e) {
      if(this.closed || generation!==this.generation) return;
      this.close(); this.fail(e);
    }
    })();
    return this.taking;
  }
  release() {
    if(this.closed) return;
    const pending=this.pending, owned=this.owned;
    const generation=++this.generation; this.owned=false; this.enable(false);
    if(pending) {
      // Closing this authenticated viewer also invalidates a late take request.
      this.close(); this.socket.close(); return;
    }
    if(owned) {
      this.releasePending=true;
      this.releasing=this.request('release').catch(e=>{
        if(!this.closed) { this.close(); this.fail(e); }
      }).finally(()=>{
        this.releasePending=false;
        if(this.generation===generation) ++this.generation;
      });
    }
  }
  sync(state, generation) {
    if(this.closed || this.pending || this.releasePending || generation!==this.generation) return;
    this.owned=state.controlling; this.enable(this.owned);
  }
  close() {
    this.closed=true; ++this.generation; this.owned=false; this.pending=false;
    this.queue=[]; this.bytes=0; this.enable(false);
  }
}
`;
