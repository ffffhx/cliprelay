-- ClipRelay：两台 Mac 局域网互传选中文本
--
-- 安装（两台 Mac 各做一次）：
--   1. brew install --cask hammerspoon
--   2. 打开 Hammerspoon，授予「辅助功能」权限（系统设置 → 隐私与安全性 → 辅助功能）
--   3. mkdir -p ~/.hammerspoon && cp init.lua ~/.hammerspoon/init.lua
--   4. 修改下方 PEER 为对方 Mac 的局域网 IP，然后在 Hammerspoon 菜单里点 Reload Config
--
-- 使用：选中任意文本（不用手动复制），按 Ctrl+Alt+G，
--       对方 Mac 会收到通知，文本已写入对方剪贴板，直接 Cmd+V 粘贴。

------------ 配置 ------------

local PEER = "192.168.1.100" -- 对方 Mac 的局域网 IP，两台机器互相填对方的
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
      hs.alert.show("ClipRelay：没有选中新文本")
      return
    end

    local url = string.format("http://%s:%d/push", PEER, PORT)
    hs.http.asyncPost(url, hs.json.encode({ text = text }),
      { ["Content-Type"] = "application/json" },
      function(status)
        if status == 200 then
          hs.alert.show("ClipRelay：已发送（" .. #text .. " 字节）")
        else
          hs.alert.show("ClipRelay：发送失败，对方可达吗？")
        end
      end)
  end)
end

hs.hotkey.bind(HOTKEY_MODS, HOTKEY_KEY, sendSelection)

------------ 接收：HTTP 服务 → 写剪贴板 + 通知 ------------

local server = hs.httpserver.new(false, false)
server:setPort(PORT) -- 不调用 setInterface，默认监听所有网卡
server:setCallback(function(method, path, _headers, body)
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
server:start()

hs.alert.show("ClipRelay 已启动")
