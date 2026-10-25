'use strict';
// The desktop app answers LAN pairing requests automatically. The installed
// service still owns the generation-bound approval gate; this module only
// supplies the decision, so a service without a running app never approves.
const token = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const code = value => typeof value === 'string' && /^[A-F0-9]{4}( [A-F0-9]{4}){2}$/.test(value);
class PairingAutoApprover {
  constructor({request, pollMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout, onError = () => {}}) {
    Object.assign(this, {request, pollMs, setTimer, clearTimer, onError});
    this.timer = null; this.started = false; this.pending = false; this.seen = new Set();
  }
  start() { if (this.started) return; this.started = true; this.schedule(0); }
  stop() { this.started = false; if (this.timer) { this.clearTimer(this.timer); this.timer = null; } }
  schedule(delay = this.pollMs) {
    if (!this.started || this.timer) return;
    this.timer = this.setTimer(() => { this.timer = null; void this.poll().finally(() => this.schedule()); }, delay);
    this.timer?.unref?.();
  }
  async poll() {
    if (!this.started || this.pending) return;
    this.pending = true;
    try {
      const result = await this.request('remote', {action: 'lanPairings'});
      if (!result?.ok) return;
      for (const request of result.data?.pairings || []) {
        if (request.state !== 'waiting' || request.automatic !== true) continue;
        if (!token(request.id) || !token(request.generation) || !code(request.verification)) continue;
        const key = request.id + ':' + request.generation;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        while (this.seen.size > 128) this.seen.delete(this.seen.values().next().value);
        try { await this.request('remote', {action: 'lanPairApprove', id: request.id, generation: request.generation, verification: request.verification}); }
        catch (error) { this.onError(error); }
      }
    } catch (error) { this.onError(error); }
    finally { this.pending = false; }
  }
}
module.exports = {PairingAutoApprover};
