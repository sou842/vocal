"""Style "Split Reader": darkened illustration on the left, sentence-by-sentence text on the right."""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from ..core import ASSETS, H, W, Style, register

F = r"C:\Windows\Fonts"
SERIF, SANS = F + r"\georgia.ttf", F + r"\segoeui.ttf"

PANEL_W = 900                                   # left illustration panel
# Theme palettes. hue = target hue of the artwork in degrees (the bundled art is purple, ~255).
# bg = panel background, accent = word being spoken / progress, spoken/upcoming = current sentence, dim = other sentences.
THEMES = {
    "purple": dict(label="Purple", hue=255, bg=(13, 11, 26), accent=(190, 160, 255), spoken=(240, 234, 255), upcoming=(150, 136, 196), dim=(86, 80, 112)),
    "blue":   dict(label="Blue",   hue=215, bg=(10, 16, 30), accent=(140, 190, 255), spoken=(232, 241, 255), upcoming=(124, 152, 200), dim=(72, 88, 116)),
    "teal":   dict(label="Teal",   hue=175, bg=(8, 22, 24),  accent=(110, 226, 210), spoken=(228, 252, 248), upcoming=(112, 176, 170), dim=(66, 100, 100)),
    "green":  dict(label="Green",  hue=135, bg=(10, 22, 14), accent=(150, 230, 150), spoken=(236, 252, 236), upcoming=(128, 176, 128), dim=(72, 100, 76)),
    "amber":  dict(label="Amber",  hue=35,  bg=(28, 19, 9),  accent=(255, 196, 110), spoken=(255, 244, 228), upcoming=(200, 162, 118), dim=(112, 92, 70)),
    "rose":   dict(label="Rose",   hue=335, bg=(28, 11, 20), accent=(255, 150, 190), spoken=(255, 236, 244), upcoming=(200, 128, 156), dim=(112, 76, 92)),
}
DEFAULT_THEME = "purple"
TX0, TX1 = PANEL_W + 90, W - 110
FONT_SIZE, LINE_H, PARA_GAP = 50, 80, 44
FOCUS_Y = 400                                   # where the current sentence's first line sits
DEFAULT_IMAGE = os.path.join(ASSETS, "reader.png")


def _font(p, s):
    return ImageFont.truetype(p, s)


def _fmt(s):
    s = int(s)
    return f"{s // 60:02d}:{s % 60:02d}"


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
        self.small = _font(SANS, 22)
        self.base = self._build_base(options.get("image") or DEFAULT_IMAGE)
        self.sents = self._layout()
        self.mask = self._fade_mask()

    # ---- static background
    def _build_base(self, image_path):
        im = Image.open(image_path).convert("RGB")
        if image_path == DEFAULT_IMAGE and self.t["hue"] != THEMES[DEFAULT_THEME]["hue"]:
            # recolor the bundled purple art to the theme (rotate the hue; uploaded images are left as they are)
            shift = round((self.t["hue"] - THEMES[DEFAULT_THEME]["hue"]) / 360 * 256) % 256
            hsv = np.asarray(im.convert("HSV")).copy()
            hsv[..., 0] = (hsv[..., 0].astype(np.int16) + shift) % 256
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

    # ---- overlays
    def _player(self, d, t):
        x0, x1, y = 70, PANEL_W - 70, H - 92
        p = min(1, t / self.duration) if self.duration else 0
        d.rounded_rectangle([x0, y - 3, x1, y + 3], radius=3, fill=(255, 255, 255, 55))
        xp = x0 + (x1 - x0) * p
        d.rounded_rectangle([x0, y - 3, max(x0 + 6, xp), y + 3], radius=3, fill=self.t["accent"] + (255,))
        d.ellipse([xp - 8, y - 8, xp + 8, y + 8], fill=(255, 255, 255, 255))
        d.text((x0, y + 18), _fmt(t), font=self.small, fill=(210, 200, 235, 255))
        d.text((x1, y + 18), _fmt(self.duration), font=self.small, fill=(210, 200, 235, 255), anchor="ra")

    def _pause(self, layer, t):
        cx, cy = PANEL_W // 2, H - 220
        pulse = 0.5 + 0.5 * np.sin(t * 2.2)
        glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(glow).ellipse([cx - 70, cy - 70, cx + 70, cy + 70], fill=self.t["accent"] + (int(40 + 30 * pulse),))
        layer.alpha_composite(glow.filter(ImageFilter.GaussianBlur(22)))
        d = ImageDraw.Draw(layer)
        d.ellipse([cx - 46, cy - 46, cx + 46, cy + 46], fill=(20, 16, 40, 200), outline=self.t["accent"] + (255,), width=3)
        for ox in (-10, 10):
            d.rounded_rectangle([cx + ox - 5, cy - 17, cx + ox + 5, cy + 17], radius=3, fill=(255, 255, 255, 255))

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
        self._pause(layer, t)
        self._player(ImageDraw.Draw(layer), t)
        return Image.alpha_composite(self.base, layer)
