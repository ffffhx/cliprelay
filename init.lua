-- ClipRelay：Mac 与其他 ClipRelay 设备在局域网内互传选中文本
--
-- Mac 安装：
--   1. brew install --cask hammerspoon
--   2. 打开 Hammerspoon，授予「辅助功能」权限（系统设置 → 隐私与安全性 → 辅助功能）
--   3. mkdir -p ~/.hammerspoon && cp init.lua ~/.hammerspoon/init.lua
--   4. 可修改下方 DEFAULT_PEER，或启动后从 ClipRelay 菜单扫描设备
--
-- 使用：选中任意文本（不用手动复制），按 Ctrl+Alt+G，
--       对端设备会收到通知，文本已写入对方剪贴板，可直接粘贴。

------------ 配置 ------------

local DEFAULT_PEER = "peer-mac.local" -- mDNS 不可用时的手动回退地址
local LOCAL_PORT = 47632
local PEER = hs.settings.get("cliprelay.peer") or DEFAULT_PEER
local PEER_PORT = hs.settings.get("cliprelay.peerPort") or 47632
local PEER_TOKEN = hs.settings.get("cliprelay.peerToken") or ""
local DEVICE_NAME = hs.host.localizedName() or "Mac"
local DEVICE_ID = hs.settings.get("cliprelay.deviceId")
local DISCOVERY_ENABLED = hs.settings.get("cliprelay.discoveryEnabled")
if DISCOVERY_ENABLED == nil then DISCOVERY_ENABLED = true end
if not DEVICE_ID or DEVICE_ID == "" then
  DEVICE_ID = hs.host.uuid()
  hs.settings.set("cliprelay.deviceId", DEVICE_ID)
end
local HOTKEY_MODS = { "ctrl", "alt" } -- 热键修饰键，冲突可改
local HOTKEY_KEY = "g"

------------ 发送：热键 → 模拟复制 → POST 给对方 ------------

local function sendSelection()
  local pb = hs.pasteboard
  local old = pb.getContents()

  hs.eventtap.keyStroke({ "cmd" }, "c")
  hs.timer.doAfter(0.2, function()
    local text = pb.getContents()
    if old ~= nil then
      pb.setContents(old) -- 恢复自己剪贴板原内容
    end
    if not text or text == "" or text == old then
      return -- 发送方静默：无任何弹窗
    end

    local url = string.format("http://%s:%d/push", PEER, PEER_PORT)
    -- 用 curl 而非 hs.http：hs.http 会走系统代理，代理拦截局域网请求导致发送失败；
    -- curl 默认忽略系统代理，直连对方
    local args = { "-s", "-o", "/dev/null", "--fail", "--max-time", "5",
      "-X", "POST", "-H", "Content-Type: application/json" }
    if PEER_TOKEN ~= "" then
      table.insert(args, "-H")
      table.insert(args, "X-ClipRelay-Token: " .. PEER_TOKEN)
    end
    table.insert(args, "--data")
    table.insert(args, hs.json.encode({ text = text }))
    table.insert(args, url)
    hs.task.new("/usr/bin/curl", nil, args):start()
  end)
end

hs.hotkey.bind(HOTKEY_MODS, HOTKEY_KEY, sendSelection)

------------ 接收：HTTP 服务 → 写剪贴板 + 通知 ------------

-- 保留全局引用；若只用局部变量，Lua GC 后会释放 server 并停止监听。
clipRelayServer = hs.httpserver.new(false, false)
clipRelayServer:setPort(LOCAL_PORT) -- 不调用 setInterface，默认监听所有网卡
clipRelayServer:setCallback(function(method, path, _headers, body)
  if method == "POST" and path == "/push" then
    local ok, data = pcall(hs.json.decode, body)
    if ok and data and type(data.text) == "string" and data.text ~= "" then
      if data.probe == true then
        return "ok", 200, {}
      end
      hs.pasteboard.setContents(data.text)
      local preview = data.text:sub(1, 80)
      hs.notify.new({ title = "ClipRelay 收到文本", informativeText = preview }):send()
      return "ok", 200, {}
    end
  end
  return "bad request", 400, {}
end)
clipRelayServer:start()

------------ mDNS：发布本机并扫描其他 ClipRelay ------------

local function publishDiscovery()
  if clipRelayBonjour then
    clipRelayBonjour:stop()
    clipRelayBonjour = nil
  end
  if not DISCOVERY_ENABLED then return end

  clipRelayBonjour = hs.bonjour.service.new(DEVICE_NAME, "_cliprelay._tcp.", LOCAL_PORT)
  if clipRelayBonjour then
    clipRelayBonjour:txtRecord({
      id = DEVICE_ID,
      version = "1",
      platform = "macos",
      auth = "none",
    })
    clipRelayBonjour:publish(true, function(_, event, message)
      if event == "error" then
        hs.alert.show("ClipRelay 局域网声明失败：" .. tostring(message))
      end
    end)
  end
end

local function preferredIPv4(addresses)
  local fallback = nil
  for _, address in ipairs(addresses or {}) do
    if address:match("^%d+%.%d+%.%d+%.%d+$") then
      fallback = fallback or address
      if address:match("^10%.") or address:match("^192%.168%.") or
          address:match("^172%.1[6-9]%.") or address:match("^172%.2%d%.") or
          address:match("^172%.3[01]%.") then
        return address
      end
    end
  end
  return fallback
end

local function selectDiscoveredPeer(choice)
  if not choice then return end
  local token = ""
  if choice.requiresAuth then
    local button, entered = hs.dialog.textPrompt(
      "ClipRelay 访问密钥",
      choice.text .. " 要求访问密钥，请填写对方设备设置中的密钥。",
      PEER_TOKEN,
      "保存",
      "取消",
      true
    )
    if button ~= "保存" then return end
    token = entered or ""
  end
  PEER = choice.address
  PEER_PORT = choice.port
  PEER_TOKEN = token
  hs.settings.set("cliprelay.peer", PEER)
  hs.settings.set("cliprelay.peerPort", PEER_PORT)
  hs.settings.set("cliprelay.peerToken", PEER_TOKEN)
  hs.alert.show("ClipRelay 已选择：" .. choice.text)
end

local function scanForPeers()
  if clipRelayBrowser then clipRelayBrowser:stop() end
  clipRelayDiscovered = {}
  clipRelayResolvers = {}
  clipRelayBrowser = hs.bonjour.new()
  clipRelayBrowser:findServices("_cliprelay._tcp.", "local.", function(_, event, added, service)
    if event ~= "domain" or not added or not service then return end
    table.insert(clipRelayResolvers, service)
    service:resolve(2.0, function(resolved, resolveEvent)
      if resolveEvent == "resolved" then
        local txt = resolved:txtRecord() or {}
        local address = preferredIPv4(resolved:addresses())
        local port = resolved:port()
        local id = txt.id or (resolved:name() .. ":" .. tostring(port))
        if id ~= DEVICE_ID and address and port and port > 0 then
          clipRelayDiscovered[id] = {
            text = resolved:name(),
            subText = string.format("%s:%d%s", address, port,
              txt.auth == "required" and " · 需要访问密钥" or ""),
            address = address,
            port = port,
            requiresAuth = txt.auth == "required",
          }
        end
      end
      resolved:stop()
    end)
  end)

  hs.timer.doAfter(2.6, function()
    if clipRelayBrowser then clipRelayBrowser:stop() end
    local choices = {}
    for _, device in pairs(clipRelayDiscovered) do table.insert(choices, device) end
    table.sort(choices, function(left, right) return left.text < right.text end)
    if #choices == 0 then
      hs.alert.show("未发现其他 ClipRelay 设备")
      return
    end
    clipRelayChooser = hs.chooser.new(selectDiscoveredPeer)
    clipRelayChooser:placeholderText("选择 ClipRelay 接收设备")
    clipRelayChooser:choices(choices)
    clipRelayChooser:show()
  end)
end

clipRelayMenu = hs.menubar.new()
clipRelayMenu:setTitle("ClipRelay")
clipRelayMenu:setMenu(function()
  return {
    { title = string.format("发送到：%s:%d", PEER, PEER_PORT), disabled = true },
    { title = "扫描局域网设备…", fn = scanForPeers },
    { title = "允许局域网发现", checked = DISCOVERY_ENABLED, fn = function()
        DISCOVERY_ENABLED = not DISCOVERY_ENABLED
        hs.settings.set("cliprelay.discoveryEnabled", DISCOVERY_ENABLED)
        publishDiscovery()
      end },
  }
end)

publishDiscovery()

hs.alert.show("ClipRelay 已启动")
