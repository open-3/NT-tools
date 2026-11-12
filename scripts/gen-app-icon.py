# -*- coding: utf-8 -*-
"""生成 Agent Pulse 应用级主图标：彩色频谱圆环（蓝→青绿→黄→橙渐变），透明底。

输出：
  build/icon.png   256x256
  build/icon.ico   多尺寸 ICO（16~256）
  覆盖 Electron 默认 atom 图标，改的是 exe 内嵌图标（任务栏/文件/快捷方式/卸载器）。
  透明背景：只保留彩色圆环，环内外均为透明（任务栏不再显示黑色方块底）。
"""
import os
import sys
import math
from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

APPDIR = r"D:\资料\AI\状态跟踪\app"
SIZE = 512  # 高分辨率母版，导出时缩放

# 频谱环：沿圆周 angle -> 颜色。走完整一整圈色相（0→1），
# 起点/终点都回到同一色相，无缝衔接，避免蓝橙硬边界。
HUE_START = 0.58   # 蓝（0.58 = ~208°）
HUE_SPAN = 1.0     # 整圈，无缝
# 环半径：外 46%、内 30%，环宽约 16% * SIZE；整体缩小一点给透明边缘留天
R_OUT = 0.44
R_IN = 0.30


def hue_color(h):
    """h in [0,1) -> (r,g,b) 0..255，全饱和偏亮。"""
    import colorsys
    r, g, b = colorsys.hsv_to_rgb(h, 1.0, 1.0)
    return (int(r * 255), int(g * 255), int(b * 255))


def main():
    # 透明底：只画圆环，环内外保持透明
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    cx = cy = SIZE / 2.0
    r_out = SIZE * R_OUT
    r_in = SIZE * R_IN

    # 逐像素扫描环带，按角度映射色相
    for y in range(SIZE):
        for x in range(SIZE):
            dx = x - cx
            dy = y - cy
            dist = math.hypot(dx, dy)

            # 环带内：上色；带一点 1px 抗锯齿羽化（内外边缘各 1px 过渡）
            alpha = 255
            edge = 1.0
            if dist < r_in:
                # 内边缘羽化
                if dist > r_in - edge:
                    alpha = int(255 * (dist - (r_in - edge)) / edge)
                else:
                    continue
            elif dist > r_out:
                # 外边缘羽化
                if dist < r_out + edge:
                    alpha = int(255 * ((r_out + edge) - dist) / edge)
                else:
                    continue

            if alpha <= 0:
                continue

            # 角度：0 在正右，逆时针；atan2 返回 [-pi, pi]
            ang = math.atan2(-dy, dx)  # 屏幕 y 向下，取 -dy 使顺时针
            if ang < 0:
                ang += 2 * math.pi
            t = ang / (2 * math.pi)  # 0..1 顺时针
            h = (HUE_START + t * HUE_SPAN) % 1.0
            col = hue_color(h)
            img.putpixel((x, y), col + (alpha,))

    # 保存 256 母版
    icon256 = img.resize((256, 256), Image.LANCZOS)

    png_path = os.path.join(APPDIR, "build", "icon.png")
    ico_path = os.path.join(APPDIR, "build", "icon.ico")
    icon256.save(png_path)
    icon256.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    print("ok", png_path)
    print("ok", ico_path)


if __name__ == "__main__":
    main()
