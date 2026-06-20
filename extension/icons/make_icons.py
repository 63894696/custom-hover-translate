#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Custom Hover Translate — 图标生成器

确定性生成 16/32/48/128 px 的 "译" 字图标 PNG(透明背景)。
无需任何 API key / 网络 / 模型,纯 Pillow 绘制。

设计:
  - 透明底
  - 圆角方块徽章(渐变蓝 #2563eb → #1d4ed8)
  - 居中白色 "译" 字(YaHei Bold,粗体在小尺寸更清晰)
  - 徽章四边留 ~8% 内边距,保证 16px 下仍可辨

用法:
  python make_icons.py            # 生成 16/32/48/128
  python make_icons.py 64 96     # 生成自定义尺寸

字体回退顺序:msyhbd.ttc(雅黑粗)> simhei.ttf(黑体)> msyh.ttc(雅黑)> 系统默认。
"""
import sys, os
from PIL import Image, ImageDraw, ImageFont

SIZES = [16, 32, 48, 128]
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
FONTS = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
]

# 徽章颜色(顶部 → 底部渐变)
TOP_COLOR = (37, 99, 235, 255)     # #2563eb blue-600
BOT_COLOR = (29, 78, 216, 255)     # #1d4ed8 blue-700
CHAR = "译"


def load_font(size_px):
    for fp in FONTS:
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, size_px)
            except Exception:
                continue
    return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def make_icon(size):
    """透明背景 + 圆角蓝徽章 + 白色 译 字。"""
    pad = max(1, round(size * 0.08))          # 徽章内边距
    badge = (pad, pad, size - pad, size - pad)
    radius = max(2, round(size * 0.22))       # 圆角半径

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # 渐变徽章:逐行 lerp 填充圆角蒙版区域
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grad)
    for y in range(badge[1], badge[3]):
        t = (y - badge[1]) / max(1, (badge[3] - badge[1] - 1))
        gdraw.rectangle([badge[0], y, badge[2] - 1, y], fill=lerp(TOP_COLOR, BOT_COLOR, t))
    # 圆角 mask:把徽章切成圆角
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(badge, radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    # 白色 "译" 字
    draw = ImageDraw.Draw(img)
    # 字号略小于徽章内高,确保不顶满;粗体下更可辨
    font = load_font(round(size * 0.62))
    try:
        bbox = draw.textbbox((0, 0), CHAR, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        tx = (size - tw) / 2 - bbox[0]
        ty = (size - th) / 2 - bbox[1] - round(size * 0.02)
    except Exception:
        tx = ty = (size - size * 0.62) / 2
    draw.text((tx, ty), CHAR, font=font, fill=(255, 255, 255, 255))

    return img


def main():
    sizes = [int(x) for x in sys.argv[1:]] or SIZES
    for s in sizes:
        out = os.path.join(OUT_DIR, f"{s}.png")
        make_icon(s).save(out, "PNG")
        print(f"  {s:>4} px -> {out}  ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    main()
