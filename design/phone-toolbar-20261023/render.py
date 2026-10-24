"""Phone proposal, sharing the approved tablet icon and color vocabulary."""
from pathlib import Path
import importlib.util
from PIL import Image, ImageDraw

OUT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("tablet_drawing", OUT.parent / "tablet-toolbar-20261023/render.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
d.W, d.H = 1800, 1680
d.image = Image.new("RGB", (d.W*d.SCALE, d.H*d.SCALE), "#f1f4f8")
d.draw = ImageDraw.Draw(d.image)
d.svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{d.W}" height="{d.H}" viewBox="0 0 {d.W} {d.H}">', '<rect width="100%" height="100%" fill="#f1f4f8"/>']
rect, text, line, circle, icon = d.rect, d.text, d.line, d.circle, d.icon
INK, MUTED, WHITE = d.INK, d.MUTED, d.WHITE
BLUE, PURPLE, TEAL, GOLD = d.BLUE, d.PURPLE, d.TEAL, d.GOLD

text(64,40,"CLIPRELAY / PHONE",16,"#4b6b8b",True)
text(64,78,"左手输入，右手操作",42,INK,True)
text(64,138,"手机横屏设计稿 · 沿用平板图标与配色 · 用好两侧黑边，留出完整电脑画面",21,MUTED)
rect(1538,63,198,38,"#e1e9f4",19)
text(1637,72,"手机提案  01",16,"#4c6686",True,True)

# 20:9 phone around a 16:9 desktop; not a fabricated live screenshot.
rect(64,200,1672,762,"#0a1019",52)
rect(81,217,1638,728,"#050a10",39)
circle(103,581,7,"#152234")
vx, vy, vw, vh = 253,232,1280,720
rect(vx,vy,vw,vh,"#e9eef4",0)
rect(vx,vy,vw,42,"#dce4ed",0)
text(vx+22,vy+13,"远程桌面 · 工作区示意",16,"#617589")
rect(vx+18,vy+61,210,vh-126,"#e0e7ef",10)
text(vx+42,vy+90,"工作区",21,"#4b627a",True)
for i,label in enumerate(("项目笔记","文件","最近打开")):
    if i==0: rect(vx+30,vy+143,186,43,"#cbd9e9",7)
    text(vx+47,vy+157+i*59,label,18,"#657d96")
rect(vx+247,vy+61,vw-265,vh-126,"#f7f9fc",10)
text(vx+283,vy+100,"保持电脑画面清楚、完整",31,"#5f738a",True)
text(vx+283,vy+151,"常用按钮靠近左右拇指，不叠在桌面上。",20,"#8292a3")
for i,width in enumerate((850,760,670,820,540)):
    rect(vx+286,vy+223+i*42,width,10,"#e8edf3",5)
rect(vx+247,vy+434,vw-265,160,"#eef3f8",9)
text(vx+280,vy+465,"输入位置",18,"#8a9bad")
rect(vx+280,vy+507,650,47,"#f8fafc",6,"#d8e1eb")
line([(vx+300,vy+521),(vx+300,vy+541)],"#91a7bd",2)
rect(vx,vy+vh-45,vw,45,"#d7e0eb",0)
for i,c in enumerate(("#9cb3cc","#a9bbd2","#adc6c4","#c5b7d1","#bcc8d4")):
    rect(vx+512+i*53,vy+vh-34,28,26,c,6)

def rail_button(x,y,w,h,label,kind,color=WHITE,bg="#182231",selected=False):
    rect(x,y,w,h,bg,12,color if selected else None,1.5)
    icon(kind,x+w/2-15,y+16,color,30)
    text(x+w/2,y+h-34,label,19,color,False,True)

# Four fixed inputs. Same color means the same function on the tablet.
for i,(label,kind,color,bg) in enumerate((("本机输入","phone",BLUE,"#172c44"),("电脑键盘","keyboard",PURPLE,"#2b2442"),("豆包语音","mic",TEAL,"#153730"),("传图片","image",GOLD,"#352d20"))):
    rail_button(121,344+i*124,111,108,label,kind,color,bg)

# Six actions, including More, fit in a roughly 340dp-high landscape viewport.
for i,(label,kind) in enumerate((("电脑列表","home"),("Enter","enter"),("Alt + ↑","up"),("退格","backspace"),("Esc","esc"),("更多","more"))):
    rail_button(1556,250+i*113,128,103,label,kind)

text(121,985,"左侧：4 个常用输入入口",21,INK,True)
text(1110,985,"右侧：5 个操作键 + 固定“更多”",21,INK,True)
text(121,1024,"“本机输入”打开当前手机输入法；完整名称保留在无障碍描述中。",17,MUTED)

text(64,1090,"短名称，图形区分",26,INK,True)
rect(64,1140,1030,426,"#ffffff",18)
for i,(label,kind,color,bg,hint) in enumerate((("本机输入","phone",BLUE,"#172c44","手机外形 + 光标"),("电脑键盘","keyboard",PURPLE,"#2b2442","按键格子"),("停止录音","wave",TEAL,"#153730","声波 + 明确停止"),("传图片","image",GOLD,"#352d20","图片轮廓"))):
    x=94+i*244
    rect(x,1170,218,202,"#edf2f7",12)
    rail_button(x+48,1192,122,122,label,kind,color,bg,i==2)
    text(x+109,1336,hint,16,MUTED,False,True)
text(94,1414,"建议与平板一致：模式、Win、自定义键统一放入“更多”。",19,INK,True)
text(94,1460,"图标上、文字下；右侧“更多”固定在底部，其他操作可按高度滚动。",18,MUTED)
text(94,1498,"屏幕或黑边空间不足时，保留可收起的工具入口。",18,MUTED)

text(1130,1090,"更多：从右侧打开",26,INK,True)
rect(1130,1140,606,426,"#111a27",18)
text(1156,1164,"更多操作",23,WHITE,True)
text(1704,1163,"×",24,"#9eb0c6",False,True)
for i,(kind,label,desc) in enumerate((("mode","模式","桌面 / 游戏"),("win","Win 键","发送按键"),("custom","自定义键","组合键管理"))):
    y=1215+i*70
    rect(1148,y,570,60,"#1c293a",10)
    icon(kind,1168,y+18,"#b5c6dc",24)
    text(1210,y+20,label,19,WHITE)
    text(1500,y+21,desc,16,"#91a4bb")
    if kind!="win": text(1695,y+16,"›",25,"#91a4bb")
line([(1156,1434),(1710,1434)],"#304055",1)
for i,(kind,label) in enumerate((("copy","复制"),("paste","粘贴"),("files","文件"),("mic","语音方式"))):
    x=1164+(i%2)*278;y=1457+(i//2)*48
    icon(kind,x,y,"#a8bbd1",23);text(x+38,y+2,label,18,"#d4dfeb")
text(64,1613,"2026.10.23   ·   手机视觉提案，尚未替换手机界面。完整更多功能保留，卡片展示常用项目。",17,"#7a899b")
d.svg.append("</svg>")
(OUT/"phone-toolbar-design.svg").write_text("\n".join(d.svg),encoding="utf-8")
d.image.resize((d.W,d.H),Image.Resampling.LANCZOS).save(OUT/"phone-toolbar-design.png")
print(OUT/"phone-toolbar-design.png")
