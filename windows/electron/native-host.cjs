'use strict';
const {EventEmitter} = require('node:events');
const {spawn} = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

function readAgentDebugPort(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, 'desktop-agent.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  const port = JSON.parse(text.replace(/^\uFEFF/, '')).debugPort;
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new Error('Invalid Agent debug port.');
  return port;
}

function parseArguments(args) {
  const result = {openSettings: false};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--open-settings') result.openSettings = true;
    else if (arg === '--background') continue;
    // Electron consumes these switches too; permit the optional local Agent
    // connection without passing its settings to the native clipboard engine.
    else if (arg.startsWith('--remote-debugging-port=')) {
      const value = arg.slice('--remote-debugging-port='.length);
      if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Invalid remote debugging port.');
    } else if (arg === '--remote-debugging-address=127.0.0.1') continue;
    else if (arg === '--port') {
      const value = args[++i];
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 65535) throw new Error('Invalid --port.');
      result.port = Number(value);
    } else if (arg === '--peer') {
      const value = args[++i];
      if (!value || /[\s/\\:"\x00-\x1f]/.test(value) || value.startsWith('-')) throw new Error('Invalid --peer.');
      result.peer = value;
    } else throw new Error(`Unknown ClipRelay argument: ${arg}`);
  }
  return result;
}

class NativeHost extends EventEmitter {
  constructor({root, launcher, port, peer, openSettings = false, spawnProcess = spawn, startupTimeout = 60000}) {
    super();
    Object.assign(this, {root, launcher, port, peer, spawnProcess, startupTimeout});
    this.pendingOpen = openSettings;
    this.stopping = false;
    this.finished = false;
    this.requests = new Map();
    this.sequence = 0;
  }

  async start() {
    this.pipeName = 'cliprelay-desktop-' + crypto.randomBytes(24).toString('hex');
    this.server = net.createServer(socket => this.connect(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen('\\\\.\\pipe\\' + this.pipeName, resolve);
    });
    this.server.on('error', error => this.fail(error));
    this.launch();
  }

  launch() {
    this.ready = false;
    this.restart = false;
    this.nativeExit = false;
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', this.launcher,
      '-ClientPath', path.join(this.root, 'cliprelay.ps1'), '-HostPipe', this.pipeName];
    if (this.port) args.push('-Port', String(this.port));
    if (this.peer) args.push('-Peer', this.peer);
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CHROME_CRASHPAD_PIPE_NAME;
    // This helper launches the actual STA UI with ProcessStartInfo and NO
    // redirected streams. Node pipes/NUL handles must never reach NotifyIcon.
    this.child = this.spawnProcess(executable, args, {cwd: this.root, windowsHide: true, stdio: 'ignore', env});
    this.child.once('error', error => { this.emit('failure', error); this.child = null; this.finish(); });
    this.child.once('exit', async code => {
      clearTimeout(this.startupTimer);
      this.child = null;
      // Process exit can be delivered before the final pipe data event. Drain
      // the native engine's restart/exit marker before choosing its successor.
      if (this.socket && !this.socket.destroyed && !this.socket.readableEnded && !this.stopping && !this.restart && !this.nativeExit) {
        const socket=this.socket;
        await new Promise(resolve=>{
          const done=()=>{clearTimeout(timer);socket.removeListener('end',done);socket.removeListener('close',done);resolve();};
          const timer=setTimeout(done,250);socket.once('end',done);socket.once('close',done);
        });
      }
      this.socket?.destroy();
      this.socket = null;
      for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('后台服务正在重启。')); }
      this.requests.clear();
      if (this.restart && !this.stopping && code === 0) {
        // Settings have already been persisted by the original engine. Do not
        // reapply first-launch overrides after a port/discovery change.
        this.port = undefined;
        this.peer = undefined;
        this.launch();
      } else {
        if (code !== 0 && !this.stopping) this.emit('failure', new Error(`ClipRelay 后台异常退出（${code}）。请重新打开应用。`));
        this.finish();
      }
    });
    this.startupTimer = setTimeout(() => this.fail(new Error('ClipRelay 后台启动超时，请检查配置和监听端口。')), this.startupTimeout);
  }

  connect(socket) {
    if (this.socket || this.stopping) { socket.destroy(); return; }
    this.socket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', data => {
      buffer += data;
      if (buffer.length > 1048576) { socket.destroy(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (message === 'ready') {
          this.ready = true;
          clearTimeout(this.startupTimer);
          if (this.pendingOpen) this.open();
          this.emit('ready');
        } else if (message === 'restart') this.restart = true;
        else if (message === 'exit') this.nativeExit = true;
        else if (message.startsWith('{')) {
          try {
            const response = JSON.parse(message);
            if (response.event) this.emit('message', response);
            else {
              const pending = this.requests.get(response.id);
              if (pending) {
                clearTimeout(pending.timer);
                this.requests.delete(response.id);
                if (response.ok) pending.resolve(response.data);
                else pending.reject(new Error(response.error || '操作未完成。'));
              }
            }
          } catch { this.fail(new Error('后台通信格式错误。')); }
        }
      }
    });
  }

  open() {
    this.pendingOpen = true;
    if (this.ready && this.socket && !this.socket.destroyed) {
      this.socket.write('open\n');
      this.pendingOpen = false;
    }
  }

  request(action, data = {}) {
    if (!this.ready || !this.socket || this.socket.destroyed) return Promise.reject(new Error('后台服务正在启动，请稍后重试。'));
    return new Promise((resolve, reject) => {
      const id = String(++this.sequence);
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('操作超时。')); }, 30000);
      this.requests.set(id, {resolve, reject, timer});
      this.socket.write(JSON.stringify({id, action, data}) + '\n');
    });
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.startupTimer);
    // Pipe EOF is also a quit request, including host crashes and logout.
    if (this.socket) this.socket.end('quit\n');
    else this.server?.close();
    if (!this.child) this.finish();
  }

  fail(error) {
    if (this.finished || this.stopping) return;
    this.emit('failure', error);
    this.stop();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.startupTimer);
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('后台服务已退出。')); }
    this.requests.clear();
    this.socket?.destroy();
    this.server?.close();
    this.emit('exit');
  }
}

module.exports = {NativeHost, parseArguments, readAgentDebugPort};
