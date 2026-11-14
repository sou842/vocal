# Vocal Studio

A local, single-user web app that:

1. **Generates speech from text** using [Chatterbox TTS](https://github.com/resemble-ai/chatterbox) (runs on CPU or GPU), with optional voice cloning from a short `.wav` sample.
2. **Extracts text from PDFs** using [pymupdf4llm](https://pymupdf.readthedocs.io/en/latest/pymupdf4llm) (layout-aware: headings, lists, tables and columns are preserved; headers/footers stripped), so pages can be reviewed, edited, and sent to the script.

Everything runs on your own machine at `http://127.0.0.1:8000` — no cloud service, no API key, no data leaves your computer.

## Requirements

- **Windows 10/11**, Python **3.11–3.12**
- **Node.js** (only needed once, to build the CSS — not required to run the app)
- A decent amount of free disk space (the Chatterbox model is downloaded on first run, ~2 GB)
- No GPU required, but generation is much faster with an NVIDIA GPU + CUDA. On CPU, expect roughly **15–25× slower than real time** (a 1-minute script can take 15–25 minutes to generate).

## Setup

```powershell
# 1. Create and activate a virtual environment
py -3.12 -m venv .venv

# 2. Install PyTorch (CPU build shown; see pytorch.org for a CUDA build if you have an NVIDIA GPU)
.venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# 3. Install the app's Python dependencies
.venv\Scripts\python.exe -m pip install chatterbox-tts pymupdf4llm

# 4. (Optional) rebuild the CSS — a built copy is already committed, so this is only needed
#    if you change web/input.css
npm install
npm run build:css
```

## Running

Double-click **`start.bat`**, or run:

```powershell
.venv\Scripts\python.exe server.py
```

This opens `http://127.0.0.1:8000` in your browser once the server is ready. Leave the console window open while you use the app; close it (or Ctrl+C) to stop.

## Using it

- **Create a project** from the sidebar. Everything you generate or extract is organized per project.
- **Generate speech**: paste or type text, optionally attach a ~10 second voice sample to clone, and click Generate. Output is saved as `projects/<Project>/<Project>_<N>.wav`.
- **Documents**: drop in a PDF to extract its text page by page. Extractions are saved, so re-uploading the same PDF reopens the saved copy instantly instead of re-processing it. Edit any page, search across the document, select pages, and send text straight to the script (with an optional "Clean for speech" pass that strips Markdown formatting).
- **Audio library**: every generated file for the current project, with play/download.

## Project layout

```
server.py         Backend: stdlib HTTP server, background workers for TTS + PDF extraction
tts.py            Text chunking + a standalone CLI (python tts.py "text" -o out.wav)
web/              Front-end (vanilla JS, Tailwind CSS v4)
  index.html
  app.js
  input.css       Tailwind source — edit this, then `npm run build:css`
  app.css         Built CSS (committed, so the app runs without Node)
  lucide.min.js   Icon library, vendored locally (fully offline)
projects/         Generated at runtime — NOT committed (see .gitignore)
  <Project>/
    <Project>_1.wav, <Project>_2.wav, ...
    documents/<id>/{doc.json, source.pdf}   saved PDF extractions
    texts/<name>.txt|.md                    text saved from the document viewer
voices/           Temporary uploaded voice samples — NOT committed
```

## Notes

- Only `127.0.0.1` is served, and requests are checked against the app's own Host/Origin — but there is no login, so anything else running as you on this machine can reach it. Don't expose port 8000 to a network.
- PDFs with no extractable text (scanned images) are flagged "Image only, no text" — OCR is intentionally not included.
- Chatterbox audio carries an inaudible watermark identifying it as AI-generated.
