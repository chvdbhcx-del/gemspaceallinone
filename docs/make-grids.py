#!/usr/bin/env python3
"""Build the README screenshot grids from docs/screens (made by docs/make-screens.js).

Every desktop tile and every phone tile lands at the same pixel size with its caption baked in
as a pill, so GitHub can't stretch columns by caption length.

    python3 docs/make-grids.py [grid-name ...]          (needs Pillow)

The caption font is the app's own Nunito SemiBold from the Android resources.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, 'screens')
FONT = os.path.join(HERE, '..', 'android', 'app', 'src', 'main', 'res', 'font', 'nunito_semibold.ttf')

PHONE = (540, 1169)      # all phone tiles
DESK = (1440, 900)       # all desktop tiles
GAP = 40
PILL_BG = (40, 42, 46, 255)
PILL_FG = (240, 240, 242, 255)

GRIDS = {
    'grid-desktop': ('desk', 2, [
        ('desktop-add', 'Новый аккаунт с прокси'),
        ('desktop-menu', 'Меню аккаунта'),
        ('desktop-notify', 'Уведомление с именем аккаунта'),
        ('desktop-settings', 'Настройки'),
    ]),
    'grid-phone': ('phone', 5, [
        ('android-main', 'Аккаунты сверху'),
        ('android-feed', 'Лента'),
        ('android-add', 'Новый аккаунт'),
        ('android-menu', 'Меню аккаунта'),
        ('android-notify', 'Уведомления'),
    ]),
}


def rounded(img, r):
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), r, fill=255)
    out = img.convert('RGBA')
    out.putalpha(mask)
    return out


def build(name, kind, cols, items):
    tw, th = PHONE if kind == 'phone' else DESK
    fsize = 44 if kind == 'phone' else 52
    font = ImageFont.truetype(FONT, fsize)
    pill_h = int(fsize * 1.9)
    cell_h = th + 20 + pill_h
    rows = (len(items) + cols - 1) // cols
    W = cols * tw + (cols - 1) * GAP
    H = rows * cell_h + (rows - 1) * GAP
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    for i, (src, caption) in enumerate(items):
        x = (i % cols) * (tw + GAP)
        y = (i // cols) * (cell_h + GAP)
        shot = Image.open(os.path.join(ROOT, src + '.png')).convert('RGB')
        assert abs(shot.width / shot.height - tw / th) < 0.003, src
        shot = shot.resize((tw, th), Image.LANCZOS)
        canvas.alpha_composite(rounded(shot, 36 if kind == 'phone' else 20), (x, y))
        tw_txt = d.textlength(caption, font=font)
        pw = int(tw_txt + fsize * 1.4)
        px = x + (tw - pw) // 2
        py = y + th + 20
        d.rounded_rectangle((px, py, px + pw, py + pill_h), pill_h // 2, fill=PILL_BG)
        # vertical centring by the glyph box, not the ascent
        bb = d.textbbox((0, 0), caption, font=font, anchor='ls')
        cy = py + pill_h / 2 - (bb[1] + bb[3]) / 2
        d.text((x + tw / 2 - tw_txt / 2, cy), caption, font=font, fill=PILL_FG, anchor='ls')
    out = os.path.join(ROOT, name + '.png')
    canvas.save(out, optimize=True)
    print(name, canvas.size, os.path.getsize(out) // 1024, 'KB')


ONLY = set(sys.argv[1:])
for n, (k, c, it) in GRIDS.items():
    if not ONLY or n in ONLY:
        build(n, k, c, it)
