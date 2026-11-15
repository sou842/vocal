"""Style "Split Reader": darkened illustration on the left, sentence-by-sentence text on the right."""
import colorsys
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from ..core import ASSETS, H, W, Style, register

SERIF = r"C:\Windows\Fonts\georgia.ttf"

PANEL_W = 900                                   # left illustration panel
# Theme palettes: one per Tailwind color (accent = its 300 shade). Everything else is derived from the accent:
# bg = panel background, spoken/upcoming = current sentence, dim = other sentences, hue/sat = recoloring of the artwork.
# The bundled art is purple (hue ~255). "sat" scales the art's saturation (neutral colors are nearly gray).
_TAILWIND = [   # id, label, accent RGB, art saturation
    ("red", "Red", (252, 165, 165), 1), ("orange", "Orange", (253, 186, 116), 1), ("amber", "Amber", (252, 211, 77), 1),
    ("yellow", "Yellow", (253, 224, 71), 1), ("lime", "Lime", (190, 242, 100), 1), ("green", "Green", (134, 239, 172), 1),
    ("emerald", "Emerald", (110, 231, 183), 1), ("teal", "Teal", (94, 234, 212), 1), ("cyan", "Cyan", (103, 232, 249), 1),
    ("sky", "Sky", (125, 211, 252), 1), ("blue", "Blue", (147, 197, 253), 1), ("indigo", "Indigo", (165, 180, 252), 1),
    ("violet", "Violet", (196, 181, 253), 1), ("purple", "Purple", (216, 180, 254), 1),
    ("fuchsia", "Fuchsia", (240, 171, 252), 1), ("pink", "Pink", (249, 168, 212), 1), ("rose", "Rose", (253, 164, 175), 1),
    ("slate", "Slate", (203, 213, 225), 0.30), ("gray", "Gray", (209, 213, 219), 0.18), ("zinc", "Zinc", (212, 212, 216), 0.12),
    ("neutral", "Neutral", (212, 212, 212), 0.0), ("stone", "Stone", (214, 211, 209), 0.14),
]


def _rgb(h, l, s):
    return tuple(round(c * 255) for c in colorsys.hls_to_rgb(h, l, s))


def _make_theme(label, accent, sat):
    h, _, s = colorsys.rgb_to_hls(*(c / 255 for c in accent))
    return dict(label=label, hue=h * 360, sat=sat, accent=accent,
                bg=_rgb(h, 0.075, min(s, 0.5)), spoken=_rgb(h, 0.95, min(s, 1) * 0.9),
                upcoming=_rgb(h, 0.62, min(s, 1) * 0.30), dim=_rgb(h, 0.36, min(s, 1) * 0.16))


THEMES = {i: _make_theme(lb, ac, st) for i, lb, ac, st in _TAILWIND}
# The original hand-tuned purple stays the default look (the artwork's own hue, so it is never recolored).
THEMES["purple"] = dict(label="Purple", hue=255, sat=1, bg=(13, 11, 26), accent=(190, 160, 255), spoken=(240, 234, 255),
                        upcoming=(150, 136, 196), dim=(86, 80, 112))
DEFAULT_THEME = "purple"
TX0, TX1 = PANEL_W + 90, W - 110
FONT_SIZE, LINE_H, PARA_GAP = 50, 80, 44
FOCUS_Y = 400                                   # where the current sentence's first line sits
DEFAULT_IMAGE = os.path.join(ASSETS, "reader.png")


def _font(p, s):
    return ImageFont.truetype(p, s)


@register
class SplitReader(Style):
    id = "split_reader"
    name = "Split Reader"
    description = "Darkened artwork on the left with a player; the text scrolls sentence by sentence on the right."
    preview = "split_reader.png"
    options = [
        {"key": "theme", "type": "theme", "label": "Theme color", "default": DEFAULT_THEME,
         "choices": [{"id": k, "label": v["label"], "color": "#%02x%02x%02x" % v["accent"]} for k, v in THEMES.items()]},
        {"key": "image", "type": "image", "label": "Left image",
         "hint": "Portrait works best. It is cropped, darkened and tinted to the theme automatically. Leave empty for the default art."},
    ]

    def __init__(self, words, duration, options):
        super().__init__(words, duration, options)
        self.t = THEMES.get(options.get("theme"), THEMES[DEFAULT_THEME])
        self.cap_font = _font(SERIF, FONT_SIZE)
        self.base = self._build_base(options.get("image") or DEFAULT_IMAGE)
        self.sents = self._layout()
        self.mask = self._fade_mask()

    # ---- static background
    def _build_base(self, image_path):
        im = Image.open(image_path).convert("RGB")
        if image_path == DEFAULT_IMAGE and self.t is not THEMES[DEFAULT_THEME]:
            # recolor the bundled purple art to the theme: rotate the hue, scale the saturation
            # (uploaded images are left as they are)
            shift = round((self.t["hue"] - THEMES[DEFAULT_THEME]["hue"]) / 360 * 256) % 256
            hsv = np.asarray(im.convert("HSV")).copy()
            hsv[..., 0] = (hsv[..., 0].astype(np.int16) + shift) % 256
            hsv[..., 1] = (hsv[..., 1] * self.t["sat"]).astype(np.uint8)
            im = Image.fromarray(hsv, "HSV").convert("RGB")
        r = PANEL_W / im.width
        im = im.resize((PANEL_W, max(H, round(im.height * r))), Image.LANCZOS)
        top = min(max(0, round(im.height * 0.34)), im.height - H)
        a = np.asarray(im.crop((0, top, PANEL_W, top + H))).astype(np.float32)
        a *= 0.42                                                    # darker shade
        if self.t is THEMES[DEFAULT_THEME]:
            a = a * np.array([0.92, 0.88, 1.0], np.float32)          # keep the default art cool purple
        yy, xx = np.mgrid[0:H, 0:PANEL_W]
        vig = 1.0 - 0.55 * (((xx - PANEL_W * 0.5) / (PANEL_W * 0.75)) ** 2 + ((yy - H * 0.55) / (H * 0.8)) ** 2)
        a *= np.clip(vig, 0.3, 1)[..., None]
        fade = np.clip((PANEL_W - xx) / 160, 0, 1)[..., None]       # blend right edge into the text panel
        a = a * fade + np.array(self.t["bg"], np.float32) * (1 - fade)
        a += np.random.default_rng(1).normal(0, 1.6, a.shape)
        base = Image.new("RGB", (W, H), self.t["bg"])
        base.paste(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)), (0, 0))
        g = np.asarray(base).astype(np.float32)
        yy, xx = np.mgrid[0:H, PANEL_W:W]
        glow = np.clip(1 - np.sqrt(((xx - 1400) / 700) ** 2 + ((yy - 480) / 520) ** 2), 0, 1) ** 2
        g[:, PANEL_W:] += glow[..., None] * (np.array(self.t["accent"], np.float32) * 0.07)
        return Image.fromarray(np.clip(g, 0, 255).astype(np.uint8)).convert("RGBA")

    def _fade_mask(self):
        yy = np.arange(H, dtype=np.float32)[:, None] * np.ones((1, W), np.float32)
        m = np.clip(yy / 170, 0, 1) * np.clip((H - 60 - yy) / 170, 0, 1)
        m[:, :PANEL_W] = 1.0
        return m

    # ---- text layout
    def _layout(self):
        draw = ImageDraw.Draw(self.base)
        sents, cur = [], []
        for w in self.words:
            cur.append(dict(w))
            if w["w"][-1] in ".!?" and len(cur) >= 3:
                sents.append(cur); cur = []
        if cur:
            sents.append(cur)
        space = draw.textlength(" ", font=self.cap_font)
        max_w, y, out = TX1 - TX0, 0, []
        for s in sents:
            x, top = 0.0, y
            for w in s:
                ww = draw.textlength(w["w"], font=self.cap_font)
                if x and x + ww > max_w:
                    x, y = 0.0, y + LINE_H
                w.update(x=TX0 + x, y=y)
                x += ww + space
            y += LINE_H + PARA_GAP
            out.append({"words": s, "start": s[0]["start"], "top": top})
        return out

    def _scroll(self, t):
        """Active sentence index and an eased scroll position: glide to each sentence as it starts."""
        tops = [s["top"] for s in self.sents]
        k = max([i for i, s in enumerate(self.sents) if s["start"] <= t] or [0])
        prev = tops[k - 1] if k else tops[0]
        p = float(np.clip((t - self.sents[k]["start"]) / 0.45, 0, 1)) if k else 1.0
        p = p * p * (3 - 2 * p)
        return k, prev + (tops[k] - prev) * p

    # ---- one frame
    def frame(self, t):
        k, scroll = self._scroll(t)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        for i, s in enumerate(self.sents):
            sy = s["top"] - scroll + FOCUS_Y
            if sy > H + 40 or sy + 4 * LINE_H < -40:
                continue
            for w in s["words"]:
                y = w["y"] - scroll + FOCUS_Y
                if i != k:
                    col = self.t["dim"]
                elif w["start"] <= t < max(w["end"], w["start"] + 0.12):
                    col = self.t["accent"]
                elif w["start"] <= t:
                    col = self.t["spoken"]
                else:
                    col = self.t["upcoming"]
                d.text((w["x"], y), w["w"], font=self.cap_font, fill=col + (255,))
        a = np.asarray(layer).copy()
        a[..., 3] = (a[..., 3] * self.mask).astype(np.uint8)       # fade the top/bottom of the text column
        layer = Image.fromarray(a)
        return Image.alpha_composite(self.base, layer)
