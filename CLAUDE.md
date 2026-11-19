# Vocal Studio: project notes for Claude

Local, single-user Windows web app (http://127.0.0.1:8000) for **text to speech** (Chatterbox), **PDF text extraction** (pymupdf4llm), **saved narrator voices** and **read-along videos**. Stdlib HTTP server, vanilla JS, Tailwind v4. The owner's goal is personal audiobook-style narration and read-along videos; **voice quality is the top priority** (quality over speed, personal use only, male narrator). README.md covers setup; this file records how things fit and what was decided.

## Run and build
- Run: `.venv\Scripts\python.exe server.py` (or `start.bat`). Python 3.12 venv; video needs `stable-ts imageio-ffmpeg soundfile pillow` on top of the README packages.
- CSS: `npm run build:css` after adding Tailwind classes (`web/app.css` is committed). Web files are read per request (browser refresh); Python changes need a server restart.
- Fonts for videos are Windows system fonts (Georgia), so video creation is Windows-only.

## Saved voices (IN git)
`voices/library/` (narrator clips, e.g. "Mr. Writer") is committed on purpose so voices carry to other devices. Other files in `voices/` stay ignored.

## Per-device data (NOT in git)
`projects/` (audio, `scripts/`, `videos/`, documents), `settings.json` (engine choice plus the Colab address/key, which change every Colab session; never print the key). On a new device, re-add the narrator voice in the Generate page ("Add voice") and set up the engine in Settings.

## How it fits together
- `server.py`: one worker thread per job type (`tts_worker`, `extract_worker`, `video_worker`). Jobs are in-memory dicts polled by the UI (`/api/jobs/<id>`, `/api/extract/<id>`, `/api/video/jobs/<id>`); `/api/active` lets a reloaded page re-attach. Startup disables Windows console QuickEdit and removes stale uploads and half-made videos.
- **Speech engine** (`settings.json`): `local` CPU or `colab`. `colab/worker.py` runs Chatterbox on a Colab GPU behind a Cloudflare quick tunnel (Bearer key); the app sends one sentence per request. After editing `worker.py`, run `python colab/make_notebook.py`.
- `tts.py`: `split_story` (one sentence per chunk, pause per boundary), `polish_chunk` (trim silence, match loudness, fades), `time_stretch` (rubberband, optional).
- `voicecheck.py`: Whisper listens to each generated sentence and re-records glitches (`best_take`, up to 3 takes). `voicelib.py`: cleans and stores reference clips.
- `video/`: `core.py` (stable-ts alignment, FFmpeg render loop, style registry), `styles/split_reader.py` (only style). A new style = one new file in `video/styles/` with an `@register` class plus a preview PNG in `video/assets/previews/`. Option types the UI understands: `theme` and `image`.
- Each audio's text is saved to `projects/<P>/scripts/<audio>.txt` so a video can be aligned later (older audio has none; the user pastes the text).
- `web/app.js` sections: generate speech, audio library, documents, settings, saved voices, generate presets, video creation.

## Decisions to respect
- **Default voice settings** (chosen by the owner): Expression (`exaggeration`) 0.55, Pacing (`cfg`) 0.40, Speed 1.00x, Quality "Best", saved voice selected. The "Storyteller" preset equals these. Calm (0.40/0.30) and Dramatic (0.80/0.45) were Claude's guesses, not approved. Do not change agreed defaults without asking.
- Pacing minimum is 0.1 (cfg 0 crashes the Colab worker). Keep Speed near 1.00x.
- Video "Split Reader": no play/pause button, progress bar or timestamps (owner's request). 22 Tailwind theme colors; default "purple" is the original hand-tuned look.

## Voice quality findings
- Default Chatterbox speaks about 222 words/min with no pauses (a narrator is about 150-160). `cfg` barely changes tempo; very low Expression flattens pitch.
- Heavy time-stretching (FFmpeg `atempo` 0.70x) sounded robotic; stretching is only clean down to about 0.9x. The **reference voice clip is the biggest lever** (6 s is enough).
- Open roadmap: a text "director" pass (clean numbers/headings, per-sentence delivery), a blind model comparison on Colab (Chatterbox-Turbo, VibeVoice, DramaBox, Fish Audio S2), audio finishing (even loudness, room tone, smoother joins), an A/B listening page. Parallel video frame rendering and saving each video's theme/settings next to it are also undecided.

## Working rules for Claude here
- **Never `git commit` or `git push` unless the owner explicitly asks that time.** Report changed files and say "not committed".
- "Just tell me" means answer in words only. For bigger work: short plan, then do it. Use plain wording.
- Be honest about what was not tested (audio cannot be heard; UI checks are screenshots). Verify with measurements or screenshots.
- Keep the UI friendly (clear labels, sensible defaults, advanced options collapsed). Clean up test files.
- Testing without disturbing a running server: a throwaway script that imports `server`, overrides `PORT`/`ALLOWED_HOSTS`/`ALLOWED_ORIGINS`, and serves on port 8001. Use the `Prototype` project for tests and delete what you create. With the Colab engine selected, generation tests hit the owner's real Colab, so send only throwaway text.
- Long Bash heredocs with quotes/backticks can fail in this environment; write scripts to files and run them.
