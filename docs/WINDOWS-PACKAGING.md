# Windows packaging

The source includes a Windows x64 NSIS installer recipe. An [unsigned Windows installer](https://github.com/adrienwax/moshpit/releases/tag/v1.0.0-rc.2-test) is available; the Sandbox test kit is optional. Stable binary publication still requires signing, clean-Windows acceptance and review of the exact bundled third-party inputs.

## Local unsigned candidate

Install Node 24/npm, the lockfile-pinned Electron and electron-builder 26.15.3. Icon generation also requires Python with `Pillow==9.5.0` from `scripts/requirements-icons.txt` (only a build dependency). `npm ci` runs the dependency installation scripts; review them before installing.

Provide a reviewed directory containing both `ffmpeg.exe` and `ffprobe.exe`. Do not copy an arbitrary FFmpeg download into a public release: its notices and corresponding source/build inputs must match. Keep binary notices/source material in ignored `third-party-binary/`; the packager copies that directory into `resources/legal/binary`.

```powershell
npm ci
$env:KRAB_SCRATCH_ROOT = 'C:/BuildScratch/Moshpit'
$env:MOSHPIT_FFMPEG_DIR = 'C:/BuildInputs/ffmpeg'
# Choose a new output directory under KRAB_SCRATCH_ROOT for every build.
$env:MOSHPIT_PACK_OUT = 'C:/BuildScratch/Moshpit/candidate-01'
node app/pack.mjs --candidate --installer
```

The candidate has its own application ID, shortcuts, settings and control endpoint. Installation does not automatically launch it. Uninstallation retains application data. No step uploads artifacts; electron-builder uses `--publish never`.

The build manifest records source state and hashes of both media tools. Keep that manifest with the exact installer. Do not call a dirty-source build a reproducible release.

## Release gates

1. Freeze a clean source commit and lockfile; run typecheck, release tests and portability checks.
2. Verify the exact runtime dependency notices and FFmpeg source/build bundle; exclude personal configuration, footage, caches and development fixtures.
3. Test installation, import/edit, save/reopen, export, close/relaunch and uninstall on clean Windows. Preserve user data on upgrade/uninstall.
4. Integrate and verify signing of the owned app, generated uninstaller and final installer. Current candidates are unsigned; no signing-service acceptance is implied.
5. Publish the matching source/tag, approved installer, checksums, source materials and accurate release notes together.

The controlled FFmpeg recipe under `scripts/ffmpeg/` is local build preparation, not proof that any existing binary is cleared or feature-equivalent. Run its capability checks before choosing a replacement.
