#!/usr/bin/env python3
"""ClipRelay Android 接收端（Termux 内运行）。

收到 POST /push {"text": "..."} 后写入手机剪贴板并弹通知。
依赖：pkg install python termux-api（并安装 Termux:API App）
常驻运行：termux-wake-lock && python receiver.py
"""
import json
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 47632


def run(cmd, input_text=None):
    subprocess.run(cmd, input=input_text, text=True, check=False)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/push":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
            text = data["text"]
            assert isinstance(text, str) and text
        except Exception:
            self.send_error(400)
            return

        run(["termux-clipboard-set"], input_text=text)
        run(["termux-notification", "--title", "ClipRelay 收到文本",
             "--content", text[:80]])
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    print(f"ClipRelay receiver listening on :{PORT}")
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
