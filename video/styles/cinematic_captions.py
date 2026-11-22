"""Style "Cinematic Captions": a full-screen darkened picture with a slow zoom and film-style captions at the bottom.

One short caption (max 2 lines) is on screen at a time. It fades in as it starts being spoken, the word being
spoken lights up in the theme color, and it fades out before the next caption. Same theme colors and image option
as Split Reader.
"""
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from ..core import H, W, Style, register
from .split_reader import DEFAULT_IMAGE, DEFAULT_THEME, SERIF, THEMES

FONT_SIZE, LINE_H = 60, 84
MAX_LINES = 2
TEXT_W = 1560                       # caption column width
BOTTOM = H - 125                    # bottom edge of the caption block
PAD = 40                            # room around the text for the shadow
FADE_IN, FADE_OUT = 0.35, 0.30      # seconds
LIFT = 14                           # captions rise this many pixels while fading in
ZOOM, ZOOM_PERIOD = 0.09, 60.0      # slow zoom in and out: +9 %, one full cycle per minute
INTRO, OUTRO = 0.8, 1.2             # fade from / to black at the start / end of the video


@register
class CinematicCaptions(Style):
    id = "cinematic_captions"
    name = "Cinematic Captions"
    description = "Full-screen darkened picture with a slow zoom; one caption at a time fades in at the bottom."
    preview = "cinematic_captions.png"
    options = [
        {"key": "theme", "type": "theme", "group": "Colors", "label": "Theme color", "default": DEFAULT_THEME,
         "choices": [{"id": k, "label": v["label"], "color": "#%02x%02x%02x" % v["accent"]} for k, v in THEMES.items()]},
        {"key": "image", "type": "image", "group": "Image", "label": "Background image",
         "hint": "Wide (16:9) works best. It is cropped, darkened and slowly zoomed. Leave empty for the default art."},
    ]

    def __init__(self, words, duration, options):
        super().__init__(words, duration, options)
        self.t = THEMES.get(options.get("theme"), THEMES[DEFAULT_THEME])
        self.font = ImageFont.truetype(SERIF, FONT_SIZE)
        self.bg = self._build_background(options.get("image") or DEFAULT_IMAGE)
        self.shade = self._build_shade()
        self.caps = self._layout()

    # ---- static pieces
    def _build_background(self, path):
        """Darkened, tinted picture a little larger than the screen, so the zoom has room to move."""
        im = Image.open(path).convert("RGB")
        if path == DEFAULT_IMAGE and self.t is not THEMES[DEFAULT_THEME]:
            shift = round((self.t["hue"] - THEMES[DEFAULT_THEME]["hue"]) / 360 * 256) % 256
            hsv = np.asarray(im.convert("HSV")).copy()
            hsv[..., 0] = (hsv[..., 0].astype(np.int16) + shift) % 256
            hsv[..., 1] = (hsv[..., 1] * self.t["sat"]).astype(np.uint8)
            im = Image.fromarray(hsv, "HSV").convert("RGB")
        bw, bh = round(W * (1 + ZOOM)), round(H * (1 + ZOOM))
        r = max(bw / im.width, bh / im.height)                      # "cover" scale
        im = im.resize((max(bw, round(im.width * r)), max(bh, round(im.height * r))), Image.LANCZOS)
        left, top = (im.width - bw) // 2, int((im.height - bh) * 0.4)   # a little above centre: keeps faces and the horizon
        a = np.asarray(im.crop((left, top, left + bw, top + bh))).astype(np.float32) * 0.62
        if self.t is THEMES[DEFAULT_THEME]:
            a *= np.array([0.92, 0.88, 1.0], np.float32)
        yy, xx = np.mgrid[0:bh, 0:bw]
        vig = 1.0 - 0.6 * (((xx - bw / 2) / (bw * 0.75)) ** 2 + ((yy - bh * 0.45) / (bh * 0.8)) ** 2)
        a *= np.clip(vig, 0.3, 1)[..., None]
        a += np.random.default_rng(1).normal(0, 1.4, a.shape)       # light grain hides gradient banding
        return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

    def _build_shade(self):
        """Fixed dark gradient over the lower half so the captions are always easy to read."""
        y = np.arange(H, dtype=np.float32)[:, None]
        alpha = np.clip((y - H * 0.42) / (H * 0.58), 0, 1) ** 1.4 * 0.78
        a = np.zeros((H, W, 4), np.uint8)
        a[..., :3] = self.t["bg"]
        a[..., 3] = np.broadcast_to(alpha * 255, (H, W)).astype(np.uint8)
        return Image.fromarray(a, "RGBA")

    # ---- captions
    def _layout(self):
        """Group the words into captions: sentences, split every MAX_LINES lines when a sentence is long."""
        draw = ImageDraw.Draw(Image.new("RGB", (8, 8)))
        space = draw.textlength(" ", font=self.font)
        sents, cur = [], []
        for w in self.words:
            cur.append(dict(w))
            if w["w"][-1] in ".!?" and len(cur) >= 3:
                sents.append(cur)
                cur = []
        if cur:
            sents.append(cur)
        caps = []
        def wrap(s, limit):
            lines, line, width = [], [], 0.0
            for w in s:
                if line and width + space + w["wd"] > limit:
                    lines.append(line)
                    line, width = [], 0.0
                width += (space if line else 0) + w["wd"]
                line.append(w)
            return lines + [line]

        for s in sents:
            for w in s:
                w["wd"] = draw.textlength(w["w"], font=self.font)
            lines = wrap(s, TEXT_W)
            if len(lines) == 2:     # balance two lines so the second is not a lone word or two
                limit = TEXT_W
                while limit > TEXT_W * 0.45 and len(wrap(s, limit - 20)) == 2:
                    limit -= 20
                lines = wrap(s, limit)
            for i in range(0, len(lines), MAX_LINES):
                chunk = lines[i:i + MAX_LINES]
                caps.append({"lines": chunk, "start": chunk[0][0]["start"], "end": chunk[-1][-1]["end"]})
        # a caption stays until the next one begins (or a short hold after its last word)
        for i, c in enumerate(caps):
            c["show_from"] = max(0.0, c["start"] - 0.12)
            c["show_to"] = c["end"] + 1.2
            if i + 1 < len(caps):
                c["show_to"] = max(min(c["show_to"], caps[i + 1]["start"] - 0.05), c["end"] + 0.15)
            self._place(c, space)
        return caps

    def _place(self, c, space):
        """Centre each line inside the caption's own small image area."""
        n = len(c["lines"])
        c["h"] = n * LINE_H
        for li, line in enumerate(c["lines"]):
            width = sum(w["wd"] for w in line) + space * (len(line) - 1)
            x = (W - width) / 2
            for w in line:
                w["x"], w["y"] = x, li * LINE_H
                x += w["wd"] + space

    def _caption_alpha(self, c, t):
        a_in = (t - c["show_from"]) / FADE_IN
        a_out = (c["show_to"] - t) / FADE_OUT
        return float(np.clip(min(a_in, a_out), 0, 1)), float(np.clip(a_in, 0, 1))

    def _draw_caption(self, frame, c, t, alpha, rise):
        box_w, box_h = W, c["h"] + PAD * 2
        layer = Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        for line in c["lines"]:
            for w in line:
                if w["start"] <= t < max(w["end"], w["start"] + 0.12):
                    col = self.t["accent"]
                elif w["start"] <= t:
                    col = self.t["spoken"]
                else:
                    col = self.t["upcoming"]
                d.text((w["x"], PAD + w["y"]), w["w"], font=self.font, fill=col + (255,))
        text_a = layer.getchannel("A")
        shadow = Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
        shadow.putalpha(text_a.filter(ImageFilter.GaussianBlur(9)).point(lambda v: min(255, int(v * 1.6))))
        layer = Image.alpha_composite(shadow, layer)
        layer.putalpha(layer.getchannel("A").point(lambda v: int(v * alpha)))
        top = round(BOTTOM - c["h"] - PAD + LIFT * (1 - rise) ** 2)
        frame.alpha_composite(layer, (0, top))

    # ---- one frame
    def frame(self, t):
        # slow zoom (smooth cosine loop) on the pre-darkened background
        z = 1 + ZOOM * (0.5 - 0.5 * math.cos(2 * math.pi * t / ZOOM_PERIOD))
        bw, bh = self.bg.size
        cw, ch = bw / z, bh / z
        x0, y0 = (bw - cw) / 2, (bh - ch) / 2
        frame = self.bg.resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch)).convert("RGBA")
        frame.alpha_composite(self.shade)
        for c in self.caps:
            if c["show_from"] <= t <= c["show_to"]:
                alpha, rise = self._caption_alpha(c, t)
                if alpha > 0:
                    self._draw_caption(frame, c, t, alpha, rise)
        frame = frame.convert("RGB")
        k = min(1.0, t / INTRO, max(0.0, (self.duration - t) / OUTRO))   # fade from / to black
        if k < 1:
            frame = Image.eval(frame, lambda v: int(v * k))
        return frame
