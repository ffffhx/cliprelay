"""Render the toolbar proposal as editable SVG and a shareable PNG. No app assets required."""
from pathlib import Path
from html import escape
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent
W, H, SCALE = 1760, 1540, 2
image = Image.new("RGB", (W * SCALE, H * SCALE), "#f1f4f8")
draw = ImageDraw.Draw(image)
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">', '<rect width="100%" height="100%" fill="#f1f4f8"/>']
INK, MUTED, WHITE = "#152333", "#637184", "#ecf2fa"
BLUE, PURPLE, TEAL, GOLD = "#79b6ff", "#bca5ff", "#65dcc3", "#f2c578"
fonts = {}


def font(size, bold=False):
    key = (size, bold)
    if key not in fonts:
        fonts[key] = ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc", round(size * SCALE))
    return fonts[key]


def rect(x, y, w, h, fill, radius=0, stroke=None, sw=1):
    box = tuple(round(v * SCALE) for v in (x, y, x+w, y+h))
    draw.rounded_rectangle(box, radius=round(radius*SCALE), fill=fill, outline=stroke, width=round(sw*SCALE))
    svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill or "none"}" stroke="{stroke or "none"}" stroke-width="{sw}"/>')


def line(points, color, sw=2):
    draw.line([(round(x*SCALE), round(y*SCALE)) for x, y in points], fill=color, width=round(sw*SCALE), joint="curve")
    coords = " ".join(f"{x},{y}" for x, y in points)
    svg.append(f'<polyline points="{coords}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-linejoin="round" stroke-linecap="round"/>')


def circle(x, y, r, fill, stroke=None, sw=1):
    draw.ellipse(tuple(round(v*SCALE) for v in (x-r, y-r, x+r, y+r)), fill=fill, outline=stroke, width=round(sw*SCALE))
    svg.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill or "none"}" stroke="{stroke or "none"}" stroke-width="{sw}"/>')


def text(x, y, value, size=20, color=INK, bold=False, center=False):
    f = font(size, bold)
    width = draw.textlength(value, font=f) / SCALE
    if center:
        x -= width / 2
    draw.text((round(x*SCALE), round(y*SCALE)), value, font=f, fill=color, anchor="lt")
    svg.append(f'<text x="{x}" y="{y+size*.86}" fill="{color}" font-family="Microsoft YaHei, sans-serif" font-size="{size}" font-weight="{700 if bold else 400}">{escape(value)}</text>')


def icon(kind, x, y, color=WHITE, size=24):
    s = size / 24
    def L(points, width=1.8):
        line([(x+a*s, y+b*s) for a,b in points], color, width*s)
    def R(a,b,w,h,r=2,fill=None):
        rect(x+a*s,y+b*s,w*s,h*s,fill,r*s,color,1.8*s)
    def C(a,b,r,fill=None):
        circle(x+a*s,y+b*s,r*s,fill,color,1.8*s)
    if kind == "phone":
        R(5,1,14,22,3); L([(10,4),(14,4)]); L([(10,19),(14,19)])
        L([(12,8),(12,15)]); L([(10,8),(14,8)]); L([(10,15),(14,15)])
    elif kind in ("keyboard", "custom"):
        R(1,4,22,16,3)
        for a in (5,10,15,20):
            for b in (8,12):
                circle(x+a*s,y+b*s,.7*s,color)
        L([(7,16),(17,16)])
        if kind == "custom":
            L([(17,1),(17,7)]); L([(14,4),(20,4)])
    elif kind == "mic":
        R(8,1,8,14,4); L([(4,10),(4,13),(6,17),(10,19),(14,19),(18,17),(20,13),(20,10)])
        L([(12,19),(12,23)]); L([(8,23),(16,23)])
    elif kind == "image":
        R(2,2,20,20,3); C(8,8,2)
        L([(3,18),(9,12),(13,16),(17,11),(22,17)])
    elif kind == "home":
        L([(8,5),(2,11),(8,17)]); L([(2,11),(15,11)])
        L([(13,4),(22,4),(22,21),(13,21)])
    elif kind == "enter":
        L([(20,3),(20,14),(4,14)]); L([(10,8),(4,14),(10,20)])
    elif kind == "up":
        L([(12,21),(12,3)]); L([(5,10),(12,3),(19,10)])
    elif kind == "backspace":
        L([(21,12),(3,12)]); L([(10,5),(3,12),(10,19)])
    elif kind == "esc":
        R(1,4,22,16,3); text(x+12*s,y+8*s,"Esc",7*s,color,True,True)
    elif kind == "more":
        for a in (4,12,20): circle(x+a*s,y+12*s,1.7*s,color)
    elif kind == "mode":
        R(2,3,20,7,3); R(2,14,20,7,3); C(7,6.5,1.4,color); C(17,17.5,1.4,color)
    elif kind == "win":
        for a,b in ((2,2),(14,2),(2,14),(14,14)): rect(x+a*s,y+b*s,8*s,8*s,color,1*s)
    elif kind == "copy":
        R(8,7,13,15,2); L([(15,3),(3,3),(3,16)])
    elif kind == "paste":
        R(4,4,16,18,2); R(8,1,8,5,2)
    elif kind == "select":
        R(2,2,20,20,2); L([(6,12),(10,16),(18,8)])
    elif kind == "touch":
        L([(8,13),(8,3),(10,1),(12,3),(12,11),(18,9),(21,12),(20,19),(17,23),(9,23),(3,16),(4,13),(8,16)])
    elif kind in ("undo","redo"):
        pts=[(4,9),(13,9),(18,11),(20,16),(18,21)]
        arrow=[(8,4),(3,9),(8,14)]
        if kind=="redo": pts=[(24-a,b) for a,b in pts];arrow=[(24-a,b) for a,b in arrow]
        L(pts);L(arrow)
    elif kind in ("scrollup","scrolldown"):
        pts=[(5,10),(12,3),(19,10)];stem=[(12,3),(12,22)]
        if kind=="scrolldown": pts=[(a,24-b) for a,b in pts];stem=[(a,24-b) for a,b in stem]
        L(pts);L(stem)
    elif kind == "stats":
        L([(2,20),(22,20)]); L([(5,17),(5,11)]);L([(12,17),(12,4)]);L([(19,17),(19,8)])
    elif kind == "disconnect":
        L([(9,2),(9,8),(15,8),(15,2)]);L([(5,8),(19,8),(19,13),(15,18),(12,18),(12,23)])
        L([(2,2),(22,22)])
    elif kind == "files":
        L([(2,6),(2,21),(22,21),(22,6),(12,6),(9,3),(2,3),(2,6)])
    elif kind == "display":
        R(1,2,22,15,2);L([(12,17),(12,22)]);L([(7,22),(17,22)])
    elif kind == "clipboard":
        R(4,4,16,18,2);R(8,1,8,5,2);L([(8,11),(16,11)]);L([(8,16),(14,16)])
    elif kind == "privacy":
        L([(12,1),(21,5),(20,15),(16,21),(12,23),(8,21),(4,15),(3,5),(12,1)])
        L([(8,12),(11,15),(17,9)])
    elif kind == "terminal":
        R(1,3,22,18,2);L([(5,8),(9,12),(5,16)]);L([(12,16),(18,16)])
    elif kind == "wave":
        for a, height in ((3,6),(7,14),(12,22),(17,12),(21,6)):
            L([(a,12-height/2),(a,12+height/2)],2.4)
    elif kind == "loading":
        L([(19,7),(15,3),(8,3),(3,8),(3,16),(8,21),(16,21),(21,16)])
        L([(19,2),(19,8),(13,8)])


def toolbar_button(x,y,w,label,kind,color=WHITE,bg=None,selected=False):
    rect(x,y,w,58,bg or "#17202e",10,color if selected else None,1.6)
    icon(kind,x+14,y+17,color,24)
    text(x+48,y+19,label,18,color if bg else WHITE)


def render():
    text(64,40,"CLIPRELAY / TABLET",16,"#4b6b8b",True)
    text(64,78,"让底栏一眼就能认出来",42,INK,True)
    text(64,136,"平板横屏设计稿 · 全部按钮统一图标 · 模式、Win、自定义键移入“更多”",21,MUTED)
    rect(1510,63,186,38,"#e1e9f4",19)
    text(1603,72,"视觉提案  01",16,"#4c6686",True,True)

    # A schematic remote desktop: this is a design crop, not a device screenshot.
    rect(64,198,1632,472,"#0a1019",24)
    rect(80,214,1600,342,"#e9eef4",12)
    rect(80,214,1600,42,"#dce4ed",10)
    for i,c in enumerate(("#b1bfcd","#bdc9d5","#c7d2dd")): circle(105+i*22,235,5,c)
    text(154,226,"远程桌面 · 工作区示意",15,"#617589")
    rect(98,274,220,262,"#e0e7ef",10)
    text(116,296,"工作区",20,"#4b627a",True)
    for i,label in enumerate(("项目笔记","文件","最近打开")):
        if i==0: rect(108,339+i*54,200,40,"#cbd9e9",7)
        text(125,350+i*54,label,17,"#657d96")
    rect(342,274,1318,262,"#f7f9fc",10)
    text(378,309,"正在远程使用电脑",29,"#5f738a",True)
    text(378,355,"底栏位于画面下方的空白区域，保持桌面内容可见。",19,"#8292a3")
    for i,width in enumerate((940,1100,770)):
        rect(380,412+i*29,width,9,"#e8edf3",4)
    rect(80,570,1600,84,"#0d1520",12)
    toolbar_button(94,583,168,"本机输入法","phone",BLUE,"#172c44")
    toolbar_button(274,583,168,"电脑键盘","keyboard",PURPLE,"#2b2442")
    toolbar_button(454,583,168,"豆包语音","mic",TEAL,"#153730")
    toolbar_button(634,583,136,"传图片","image",GOLD,"#352d20")
    line([(799,595),(799,629)],"#2c3748",1)
    toolbar_button(826,583,196,"返回电脑列表","home")
    toolbar_button(1032,583,102,"Enter","enter")
    toolbar_button(1144,583,124,"Alt + ↑","up")
    toolbar_button(1278,583,104,"退格","backspace")
    toolbar_button(1392,583,98,"Esc","esc")
    toolbar_button(1500,583,164,"更多","more")
    text(93,691,"输入功能：蓝 / 紫 / 青绿 / 琥珀，图形轮廓各不相同",18,MUTED)
    text(1025,691,"常用操作：统一灰白，保留熟悉的按键名称",18,MUTED)

    text(64,756,"更多菜单",27,INK,True)
    text(716,756,"按钮状态与辨认方式",27,INK,True)
    rect(64,805,620,648,"#111a27",18)
    text(88,828,"更多",22,WHITE,True)
    text(659,832,"×",24,"#99a9bd",False,True)
    for i,(kind,label,detail) in enumerate((("mode","模式","桌面 / 游戏"),("win","Win 键","发送 Windows 键"),("custom","自定义键","管理常用组合键"))):
        y=877+i*65
        rect(82,y,584,56,"#1c293a",9)
        icon(kind,100,y+15,"#b3c4dc",24)
        text(139,y+17,label,19,WHITE)
        text(347,y+19,detail,16,"#91a4bb")
        if kind != "win": text(642,y+15,"›",25,"#91a4bb")
    line([(89,1086),(659,1086)],"#2d3b4d",1)
    others=[("copy","复制"),("paste","粘贴"),("select","全选"),("touch","触控方式"),("undo","撤销"),("redo","重做"),("scrollup","向上滚动"),("scrolldown","向下滚动"),("stats","串流信息"),("disconnect","断开连接"),("files","文件"),("display","显示器"),("clipboard","剪贴板"),("privacy","隐私模式"),("terminal","终端"),("mic","语音输入方式")]
    for i,(kind,label) in enumerate(others):
        x=100+(i%2)*283;y=1109+(i//2)*40
        icon(kind,x,y,"#a9bbd1",21)
        text(x+36,y+1,label,17,"#d3deeb")

    rect(716,805,980,648,"#ffffff",18)
    text(744,833,"形状 + 文字 + 颜色，三个线索一起区分",22,INK,True)
    text(744,873,"输入按钮带柔和底色；操作键使用同一套中性线条。",18,MUTED)

    def state_card(x,y,label,kind,color,bg,caption,selected=False):
        rect(x,y,434,152,"#f0f4f8",12)
        text(x+22,y+19,caption,17,"#62758a")
        rect(x+20,y+60,394,70,"#0d1520",10)
        toolbar_button(x+33,y+66,368,label,kind,color,bg,selected)

    state_card(744,920,"本机输入法","phone",BLUE,"#172c44","本机输入：手机外形 + 文字光标")
    state_card(1230,920,"电脑键盘","keyboard",PURPLE,"#2b2442","已打开：强化描边与选中状态",True)
    state_card(744,1094,"停止录音","wave",TEAL,"#153730","录音中：声波动画 + 明确停止动作",True)
    state_card(1230,1094,"连接中…","loading",GOLD,"#352d20","准备中：进度图标，完成后恢复原色")
    line([(746,1281),(1666,1281)],"#e0e7ef",1)
    text(746,1305,"图标规则",19,INK,True)
    text(746,1344,"统一线宽、大小和留白；Enter / Esc 用键帽语义。",18,MUTED)
    text(746,1382,"语音按钮跟随所选服务命名；此处展示“电脑 · 豆包”。",18,MUTED)
    text(64,1490,"2026.10.23   ·   视觉提案：颜色、图标、名称与更多菜单样式待确认后落地",17,"#7a899b")
    svg.append("</svg>")
    (OUT/"tablet-toolbar-design.svg").write_text("\n".join(svg),encoding="utf-8")
    image.resize((W,H),Image.Resampling.LANCZOS).save(OUT/"tablet-toolbar-design.png")
    print(OUT/"tablet-toolbar-design.png")


if __name__ == "__main__":
    render()
