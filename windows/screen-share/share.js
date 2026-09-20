'use strict';
const $ = id => document.getElementById(id);
const bridge = message => window.cliprelay.postMessage(message);
let config, pc, stream, ended = false, starting = false, statsTimer, connectTimer, disconnectTimer;
let lastStats;
function status(text) { $('status').textContent = text; }
function finish(reason, notify = true) {
  if (ended) return;
  ended = true;
  clearInterval(statsTimer); clearTimeout(connectTimer); clearTimeout(disconnectTimer);
  if (stream) stream.getTracks().forEach(track => track.stop());
  if (pc) pc.close();
  $('video').srcObject = null;
  document.body.className = 'ended'; $('empty').hidden = false;
  $('headline').textContent = '共享已结束'; $('detail').textContent = reason;
  $('start').hidden = true; $('stop').textContent = '关闭窗口';
  $('stats').textContent = ''; status('已结束');
  if (notify) bridge({type:'stop', reason});
}
function waitForIce(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('无法完成网络连接准备，请检查网络后重新共享。')); }, 12000);
    const changed = () => { if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); } };
    function cleanup() { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); }
    peer.addEventListener('icegatheringstatechange', changed);
  });
}
function createPeer() {
  const peer = new RTCPeerConnection({iceServers:[], bundlePolicy:'max-bundle'});
  peer.onconnectionstatechange = () => {
    if (ended) return;
    if (peer.connectionState === 'connected') {
      clearTimeout(connectTimer); clearTimeout(disconnectTimer); status('实时连接');
    } else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') finish('连接已断开，请重新发起共享。');
    else if (peer.connectionState === 'disconnected') {
      status('连接中断，正在恢复');
      clearTimeout(disconnectTimer);
      disconnectTimer = setTimeout(() => finish('网络连接中断。'), 10000);
    }
  };
  peer.ontrack = event => {
    $('video').srcObject = event.streams[0] || new MediaStream([event.track]);
    $('video').play().catch(() => {});
    $('empty').hidden = true; document.body.className = 'live';
    event.track.onended = () => finish('对方停止了共享。');
  };
  connectTimer = setTimeout(() => finish('等待连接超时，请确认对方已接受邀请且两台电脑网络互通。'), 90000);
  statsTimer = setInterval(async () => {
    if (ended) return;
    const reports = await peer.getStats();
    reports.forEach(report => {
      if (!['inbound-rtp','outbound-rtp'].includes(report.type) || report.kind !== 'video') return;
      const bytes = report.bytesReceived ?? report.bytesSent ?? 0;
      const bitrate = lastStats ? Math.max(0, (bytes-lastStats.bytes)*8/(report.timestamp-lastStats.time)/1000) : 0;
      lastStats = {bytes, time:report.timestamp};
      $('stats').textContent = `${report.frameWidth || 0} × ${report.frameHeight || 0} · ${Math.round(report.framesPerSecond || 0)} fps · ${bitrate.toFixed(1)} Mbps`;
      bridge({type:'stats', value:{width:report.frameWidth,height:report.frameHeight,fps:report.framesPerSecond,bytes,frames:report.framesDecoded ?? report.framesEncoded,bitrate}});
    });
  }, 1000);
  return peer;
}
async function start() {
  if (starting || ended || !config) return;
  starting = true; $('start').disabled = true;
  try {
    if (config.role === 'sender') {
      stream = await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:30,max:30},width:{ideal:1920},height:{ideal:1080}},audio:false});
      if (ended) { stream.getTracks().forEach(t => t.stop()); return; }
      const track = stream.getVideoTracks()[0]; track.contentHint = 'detail';
      track.onended = () => finish('你已停止屏幕捕获。');
      pc = createPeer();
      const sender = pc.addTrack(track, stream);
      const parameters = sender.getParameters();
      parameters.encodings = [{maxBitrate:8000000,maxFramerate:30}];
      parameters.degradationPreference = 'maintain-resolution';
      await sender.setParameters(parameters);
      // A local video preview would capture itself recursively during whole-screen sharing.
      $('headline').textContent = '正在共享整个主屏幕';
      $('detail').textContent = '对方接受后即可观看。你可以切回要演示的内容，结束时点击下方按钮。';
      $('start').hidden = true; $('fullscreen').hidden = true;
      document.body.className = 'sharing';
      status('正在邀请对方观看');
      await pc.setLocalDescription(await pc.createOffer()); await waitForIce(pc);
      if (!ended) bridge({type:'offer', sdp:pc.localDescription.sdp});
    } else {
      $('stop').textContent = '结束观看';
      pc = createPeer(); status('正在连接共享画面');
      await pc.setRemoteDescription({type:'offer',sdp:config.sdp});
      await pc.setLocalDescription(await pc.createAnswer()); await waitForIce(pc);
      if (!ended) bridge({type:'answer',sdp:pc.localDescription.sdp});
    }
  } catch (error) { finish(error.name === 'NotAllowedError' ? '无法采集主屏幕，请检查屏幕录制权限后重试。' : error.message); }
}
window.cliprelay.onMessage(async event => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      config = message; $('peer').textContent = message.peer;
      $('title').textContent = config.role === 'sender' ? '共享我的屏幕' : '观看屏幕共享';
      if (config.role === 'receiver') {
        $('headline').textContent = '有人邀请你观看屏幕';
        $('detail').textContent = `${message.peer} 正在共享画面。接受后将在此窗口播放。`;
        $('start').textContent = '接受并观看'; $('stop').textContent = '拒绝邀请';
        $('start').disabled = false; status('等待接受');
      } else {
        $('start').hidden = true; $('fullscreen').hidden = true;
        status('正在共享主屏幕');
        await start();
      }
    } else if (message.type === 'answer' && pc && !ended) await pc.setRemoteDescription({type:'answer',sdp:message.sdp});
    else if (message.type === 'stop') finish(message.reason || '对方已结束共享。', false);
    else if (message.type === 'error') finish(message.reason);
  } catch (error) { finish(error.message); }
});
$('start').onclick = () => start();
$('stop').onclick = () => ended ? bridge({type:'close'}) : finish(config?.role === 'receiver' && !starting ? '对方拒绝了观看邀请。' : '已结束本次共享。');
$('fullscreen').onclick = () => document.fullscreenElement ? document.exitFullscreen() : $('video').requestFullscreen();
bridge({type:'ready'});
