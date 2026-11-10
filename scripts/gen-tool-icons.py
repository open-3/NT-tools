# -*- coding: utf-8 -*-
"""为 18 个工具生成独立图标：彩色圆角方块 + 居中图标字。

输出：
  build/icons/<id>.png   256x256
  build/icons/<id>.ico   多尺寸 ICO（16~256）
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

# Windows 控制台默认 GBK，避免打印 emoji/符号时报 UnicodeEncodeError
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

APPDIR = r"D:\资料\AI\状态跟踪\app"
OUT = os.path.join(APPDIR, "build", "icons")
os.makedirs(OUT, exist_ok=True)

FONT_DIR = r"C:\Windows\Fonts"
FONT_SYMBOL = os.path.join(FONT_DIR, "seguisym.ttf")      # 符号/几何/Latin
FONT_EMOJI  = os.path.join(FONT_DIR, "seguiemj.ttf")       # 彩色 emoji
FONT_CJK    = os.path.join(FONT_DIR, "msyh.ttc")           # 中文字符

# (id, 图标内容, 类型, 背景色hex, 前景色hex 或 None=保留 emoji 本色)
# type: 'emoji' 用彩色 emoji 字体；'symbol' 用 Segoe UI Symbol；'cjk' 用微软雅黑
TOOLS = [
    ("jsonfmt",       "{ }", "symbol", "#3B82F6", "#FFFFFF"),
    ("translate",     "译",  "cjk",    "#10B981", "#FFFFFF"),
    ("ocr",           "文",  "cjk",    "#14B8A6", "#FFFFFF"),
    ("timestamp",     "⏱",   "symbol", "#F59E0B", "#FFFFFF"),
    ("codec",         "⇄",   "symbol", "#8B5CF6", "#FFFFFF"),
    ("regex",         ".*",  "symbol", "#EC4899", "#FFFFFF"),
    ("generate",      "⚄",   "symbol", "#6366F1", "#FFFFFF"),
    ("color",         "●",   "symbol", "#EF4444", "#FFFFFF"),
    ("jwt",           "🔑",  "emoji",  "#EAB308", "#FFFFFF"),
    ("screentranslate","📸", "emoji",  "#0EA5E9", "#FFFFFF"),
    ("imgcompress",   "🗜",  "emoji",  "#64748B", "#FFFFFF"),
    ("qrcode",        "▣",   "symbol", "#111827", "#FFFFFF"),
    ("table",         "⊞",   "symbol", "#06B6D4", "#FFFFFF"),
    ("diskusage",     "◔",   "symbol", "#059669", "#FFFFFF"),
    ("netstat",       "⬡",   "symbol", "#7C3AED", "#FFFFFF"),
    ("clipboard",     "📋",  "emoji",  "#F43F5E", "#FFFFFF"),
    ("env",           "🎛",  "emoji",  "#84CC16", "#1F2937"),
    ("cheatsheet",    "⌘",   "symbol", "#52525B", "#FFFFFF"),
]

SIZE = 256
RADIUS = 56


def font_for(kind: str, size: int):
    if kind == "emoji":
        return ImageFont.truetype(FONT_EMOJI, size)
    if kind == "cjk":
        return ImageFont.truetype(FONT_CJK, size)
    return ImageFont.truetype(FONT_SYMBOL, size)


def luminance(hex_color: str) -> float:
    r = int(hex_color[1:3], 16)
    g = int(hex_color[3:5], 16)
    b = int(hex_color[5:7], 16)
    return 0.299 * r + 0.587 * g + 0.114 * b


def draw_tile(text, kind, bg, fg):
    # 透明底 + 圆角方块
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=bg)

    glyph = text
    font_size = 150 if len(glyph) <= 2 else 120
    font = font_for(kind, font_size)
    color = fg if fg else None

    # 居中：用 textbbox 算宽高
    bbox = d.textbbox((0, 0), glyph, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (SIZE - w) / 2 - bbox[0]
    y = (SIZE - h) / 2 - bbox[1]

    # emoji 保留本色（不手动着色）；符号/CJK 用前景色
    fill = None if kind == "emoji" else (color or "#FFFFFF")
    d.text((x, y), glyph, font=font, fill=fill, embedded_color=(kind == "emoji"))

    return img


def main():
    for tool_id, glyph, kind, bg, fg in TOOLS:
        png_path = os.path.join(OUT, f"{tool_id}.png")
        ico_path = os.path.join(OUT, f"{tool_id}.ico")

        img = draw_tile(glyph, kind, bg, fg)
        # ICO 各尺寸缩放（高质量）
        sizes = [16, 24, 32, 48, 64, 128, 256]
        img.save(png_path)
        img.save(ico_path, sizes=[(s, s) for s in sizes])

        print(f"ok {tool_id:16s} {png_path}  ({glyph})")

    print("done, total", len(TOOLS))


if __name__ == "__main__":
    main()
