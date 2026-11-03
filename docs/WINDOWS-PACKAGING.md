# Windows packaging

The default Windows x64 package is one **Moshpit.exe** portable download. The rc4 test package includes four original procedural example projects and their media. It bundles Electron, FFmpeg, FFprobe, fonts and licence notices; no installer or separate runtime download is needed. Source companions are supplied separately for licence compliance, not as a prerequisite to running the app.

## Build locally

Use Node.js 24/npm, the lockfile-pinned Electron and electron-builder 26.15.3, and Python 3.13 with `Pillow==12.3.0` from `scripts/requirements-icons.txt` for icon generation. `npm ci` runs dependency installation scripts; review them before installing.

Provide a reviewed folder containing `ffmpeg.exe` and `ffprobe.exe`. Populate ignored `third-party-binary/` with the matching notices, hashes, source-companion metadata and Mediabunny source archive. Do not substitute an arbitrary FFmpeg binary: notices and corresponding source must match. Raw configure/environment logs must never go into public artifacts.

```powershell
npm ci
python -m pip install -r scripts/requirements-icons.txt
$env:KRAB_SCRATCH_ROOT = 'C:/BuildScratch/Moshpit'
$env:MOSHPIT_FFMPEG_DIR = 'C:/BuildInputs/ffmpeg'
$env:MOSHPIT_FFMPEG = 'C:/BuildInputs/ffmpeg/ffmpeg.exe'
# Generate once, or reuse the exact accepted pack pinned for this release.
node scripts/examples/build-pack.mjs --out C:/BuildScratch/Moshpit/pack-01 --work C:/BuildScratch/Moshpit/pack-work-01
$env:MOSHPIT_EXAMPLE_PACK = 'C:/BuildScratch/Moshpit/pack-01'
node scripts/examples/check-pack.mjs $env:MOSHPIT_EXAMPLE_PACK
$env:MOSHPIT_PACK_OUT = 'C:/BuildScratch/Moshpit/portable-01'
node app/pack.mjs
```

The pack generator renders through the actual EngineService in a hidden private Electron/GPU session; do not run it alongside another native/GPU check. Its output and work directories must be new, distinct and inside `KRAB_SCRATCH_ROOT`. See [starter pack authoring](../scripts/examples/README.txt), including compile-only preparation. Packaging requires the pack; it does not generate one or download footage. `MOSHPIT_EXAMPLE_PACK` selects it explicitly (the packaging fallback is `examples/starter-pack`).

Use a fresh output directory for each build. `--candidate` creates **Moshpit-Preview.exe** with separate preview settings; `--installer` creates **Moshpit-Setup.exe** (or **Moshpit-Preview-Setup.exe**). Neither packaging nor installer completion launches the app automatically. No command uploads files: electron-builder uses `--publish never`.

The portable EXE extracts to a fresh temporary location per launch and cleans it after normal exit. User settings are retained in `%APPDATA%/Moshpit 3` for compatibility. A local installed launcher may use a different internal filename to preserve existing CT routes; publish the full portable artifact, never that small launcher by itself.

## Release checks

1. Freeze a clean source commit and lockfile; run typecheck, release regressions and portability checks.
2. Match runtime dependencies to notices, verify FFmpeg/FFprobe hashes and the privacy-reviewed corresponding-source companion. Exclude personal profiles, owner media, caches, tests and diagnostic logs from runtime assets. Bundle only the starter pack manifest and its verified file list, including `LICENSE.txt` and `PROVENANCE.json`; retain its exact manifest hash. Never include an owner `config/examples.json`.
3. Test the actual outer EXE: import, playback, save/reopen, export and normal close. For included examples, save a copy, close normally, then reopen it directly after restarting the portable EXE before visiting Browse; this checks durable media outside temporary extraction. Test the exact download on another Windows PC; record which checks were actually completed.
4. Current packages are **unsigned**. Publish only with that status explicit. If a signed release is later prepared, verify its signature; signing is a separate distribution decision, not evidence of functional correctness.
5. Publish the matching source/tag, executable, SHA256 sums, source materials and accurate release notes together. Keep the older release available for rollback.

The manifest records the source commit, dirty state and media-tool hashes. A dirty-source build is not a frozen release. The controlled FFmpeg recipe is in `scripts/ffmpeg/`; its GPL-enabled build has separate obligations described by [FFmpeg](https://ffmpeg.org/legal.html). Its source archive is an optional download for users who want source, not an installation requirement.
