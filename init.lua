-- ClipRelay：两台 Mac 局域网互传选中文本
--
-- 安装（两台 Mac 各做一次）：
--   1. brew install --cask hammerspoon
--   2. 打开 Hammerspoon，授予「辅助功能」权限（系统设置 → 隐私与安全性 → 辅助功能）
--   3. mkdir -p ~/.hammerspoon && cp init.lua ~/.hammerspoon/init.lua
--   4. 修改下方 PEER 为对方 Mac 的局域网 IP，然后在 Hammerspoon 菜单里点 Reload Config
--
-- 使用：选中任意文本（不用手动复制），按 Control+Option+G（⌃⌥G），
--       对方 Mac 会收到通知，文本已写入对方剪贴板，直接按 Command+V（⌘V）粘贴。

------------ 配置 ------------

local PEER = "peer-mac.local" -- 对方设备的局域网 IP 或 .local 主机名
local PORT = 47632
local HOTKEY_MODS = { "ctrl", "alt" } -- Hammerspoon 中对应 Mac 的 Control、Option 键
local HOTKEY_KEY = "g"

------------ 发送：热键 → 模拟复制 → POST 给对方 ------------

local function notifySendFailure(message)
  hs.notify.new({ title = "ClipRelay 发送失败", informativeText = message }):send()
end

local function sendText(text)
  local url = string.format("http://%s:%d/push", PEER, PORT)
  -- 用 curl 而非 hs.http：hs.http 会走系统代理，代理拦截局域网请求导致发送失败；
  -- curl 默认忽略系统代理，直连对方。
  local task = hs.task.new("/usr/bin/curl", function(exitCode, _stdOut, stdErr)
    if exitCode == 0 then
      hs.alert.show("ClipRelay 已发送", 0.6)
      return
    end

    local reason = (stdErr or ""):gsub("%s+$", "")
    if reason == "" then
      reason = string.format("curl 退出码 %d", exitCode)
    end
    notifySendFailure(reason:sub(1, 160))
  end, { "-sS", "-o", "/dev/null", "--fail", "--max-time", "5",
         "-X", "POST", "-H", "Content-Type: application/json",
         "--data", hs.json.encode({ text = text }), url })

  if not task or not task:start() then
    notifySendFailure("无法启动 curl")
  end
end

local function sendSelection()
  local pb = hs.pasteboard
  local oldData = pb.readAllData()

  hs.eventtap.keyStroke({ "cmd" }, "c", 0)
  pb.callbackWhenChanged(3, function(changed)
    if not changed then
      notifySendFailure("未检测到可复制的文本")
      return
    end

    local text = pb.getContents()
    if oldData and next(oldData) ~= nil then
      pb.writeAllData(oldData) -- 完整恢复剪贴板的文本和富文本数据
    else
      pb.clearContents()
    end

    if not text or text == "" then
      notifySendFailure("选中内容不是可发送的文本")
      return
    end

    sendText(text)
  end)
end

hs.hotkey.bind(HOTKEY_MODS, HOTKEY_KEY, sendSelection)

------------ 接收：HTTP 服务 → 写剪贴板 + 通知 ------------

-- 保留全局引用；若只用局部变量，Lua GC 后会释放 server 并停止监听。
clipRelayServer = hs.httpserver.new(false, false)
clipRelayServer:setPort(PORT) -- 不调用 setInterface，默认监听所有网卡
clipRelayServer:setCallback(function(method, path, _headers, body)
  if method == "POST" and path == "/push" then
    local ok, data = pcall(hs.json.decode, body)
    if ok and data and type(data.text) == "string" and data.text ~= "" then
      hs.pasteboard.setContents(data.text)
      local preview = data.text:sub(1, 80)
      hs.notify.new({ title = "ClipRelay 收到文本", informativeText = preview }):send()
      return "ok", 200, {}
    end
  end
  return "bad request", 400, {}
end)
clipRelayServer:start()

hs.alert.show("ClipRelay 已启动")
