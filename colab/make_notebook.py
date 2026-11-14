"""Regenerate colab/vocal_worker.ipynb from colab/worker.py.

Run after editing worker.py:   python colab/make_notebook.py
The notebook embeds worker.py verbatim (via %%writefile), so it works without cloning the repo.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
worker_src = open(os.path.join(HERE, "worker.py"), encoding="utf-8").read()


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(keepends=True)}


def code(text):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [],
            "source": text.strip("\n").splitlines(keepends=True)}


cells = [
    md("""
# Vocal Studio — GPU worker

Runs the Chatterbox voice model on Colab's GPU so **Vocal Studio** on your computer can generate speech much faster.

**Every session:**
1. `Runtime → Change runtime type → T4 GPU` (only needed once per notebook).
2. `Runtime → Run all` (or Ctrl+F9). The first run installs packages (~3–5 min); later runs in the same session are faster.
3. When the last cell prints **READY**, copy the **Address** and **Key** into Vocal Studio → **Settings** → **Colab GPU** → **Test connection**.
4. Keep this tab open while you generate. Stopping the last cell (or closing the tab / the session timing out) shuts the worker down — Vocal Studio will tell you, and you can switch back to *Local CPU*.

Your text and voice samples are only processed in this session; nothing is kept after it ends.
"""),
    code("""
# 1) Check the GPU, install the voice model and the Cloudflare tunnel tool
!nvidia-smi -L || echo "NO GPU FOUND -> Runtime > Change runtime type > T4 GPU, then Run all again"
!pip -q install chatterbox-tts
# chatterbox-tts installs the exact torch version it needs. Colab's preinstalled torchvision was built for a
# different torch and breaks the model import ("operator torchvision::nms does not exist"). Chatterbox doesn't
# use torchvision, so remove it.
!pip -q uninstall -y torchvision
!test -x cloudflared || (wget -q -O cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x cloudflared)
# Fail here (not later) if the model package can't be imported:
!python -c "from chatterbox.tts import ChatterboxTTS; print('Voice model package OK')"
print("Setup done.")
"""),
    code("%%writefile worker.py\n" + worker_src),
    code("""
# 3) Start the worker (keep this cell running). Copy the Address and Key it prints into Vocal Studio -> Settings.
!python worker.py --tunnel
"""),
]

nb = {"nbformat": 4, "nbformat_minor": 0,
      "metadata": {"accelerator": "GPU", "colab": {"provenance": [], "gpuType": "T4"},
                   "kernelspec": {"name": "python3", "display_name": "Python 3"},
                   "language_info": {"name": "python"}},
      "cells": cells}

out = os.path.join(HERE, "vocal_worker.ipynb")
with open(out, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(nb, fh, indent=1, ensure_ascii=False)
print("wrote", out)
