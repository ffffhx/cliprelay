-- ClipRelay：Mac 与其他 ClipRelay 设备在局域网内互传选中文本
--
-- Mac 安装：
--   1. brew install --cask hammerspoon
--   2. 打开 Hammerspoon，授予「辅助功能」权限（系统设置 → 隐私与安全性 → 辅助功能）
--   3. mkdir -p ~/.hammerspoon && cp init.lua ~/.hammerspoon/init.lua
--   4. 修改下方 PEER 为对端设备的局域网 IP，然后在 Hammerspoon 菜单里点 Reload Config
--
-- 使用：选中任意文本（不用手动复制），按 Ctrl+Alt+G，
--       对端设备会收到通知，文本已写入对方剪贴板，可直接粘贴。

------------ 配置 ------------

local PEER = "peer-mac.local" -- 对方设备的局域网 IP 或 .local 主机名
local PORT = 47632
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

    local url = string.format("http://%s:%d/push", PEER, PORT)
    -- 用 curl 而非 hs.http：hs.http 会走系统代理，代理拦截局域网请求导致发送失败；
    -- curl 默认忽略系统代理，直连对方
    hs.task.new("/usr/bin/curl", nil, { "-s", "-o", "/dev/null", "--fail", "--max-time", "5",
           "-X", "POST", "-H", "Content-Type: application/json",
           "--data", hs.json.encode({ text = text }), url }):start()
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

hs.alert.show("ClipRelay 已启动")
