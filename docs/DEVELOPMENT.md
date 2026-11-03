# Moshpit: source and repository guide

[← User guide](../README.md) · [Windows packaging](WINDOWS-PACKAGING.md)

## Run from source

Current target: **Windows x64, Node.js 24, npm and Git**. Use the Electron version in the lockfile. FFmpeg and FFprobe must be available together; codecs depend on that build.

```powershell
git clone https://github.com/adrienwax/moshpit.git
cd moshpit
npm ci
# If FFmpeg is not on PATH:
$env:MOSHPIT_FFMPEG = 'C:/Tools/ffmpeg/bin/ffmpeg.exe'
npm start
```

`npm ci` can run third-party installation scripts and download Electron. `npm ci --ignore-scripts` is suitable for source-only inspection but does not install the Electron runtime. `npm start` builds and launches the app; `npm run build:app` only builds it.

Build/test scratch defaults to `%LOCALAPPDATA%/KRAB/scratch`. Set `KRAB_SCRATCH_ROOT` to an absolute local folder to choose another location. Do not point it at personal media or a release installation.

## Include the public examples

Source runs can start without an example pack, but Browse will report that built-in examples are unavailable. To exercise the same four examples as the rc4 test package, generate a pack with the existing Electron runtime and reviewed FFmpeg, then set its path before starting the app:

```powershell
$env:KRAB_SCRATCH_ROOT = 'C:/BuildScratch/Moshpit'
$env:MOSHPIT_FFMPEG = 'C:/Tools/ffmpeg/bin/ffmpeg.exe'
node scripts/examples/build-pack.mjs --out C:/BuildScratch/Moshpit/pack-01 --work C:/BuildScratch/Moshpit/pack-work-01
$env:MOSHPIT_EXAMPLE_PACK = 'C:/BuildScratch/Moshpit/pack-01'
npm start
```

The generator uses a hidden private Electron/GPU session; keep it separate from other native checks. Use new output/work directories and follow [the authoring instructions](../scripts/examples/README.txt). `--prepare-only` compiles without generating media or launching Electron. A source build does not automatically generate the pack; Windows packaging requires a verified one. Never open raw `pack://` templates directly: the app resolves them to durable user storage before opening a copy.

## Checks

```powershell
npm run typecheck
npm run test:release
node --test scripts/build-scratch/bootstrap.test.mjs scripts/check-public-defaults.mjs
node --test scripts/examples/checks.test.mjs
# After generating a pack:
node scripts/examples/check-pack.mjs $env:MOSHPIT_EXAMPLE_PACK
```

`npm test` runs the wider suite. Some engine/integration checks require synthetic fixtures: `npm run fixtures` generates them using FFmpeg with the necessary test encoders. `npm run test:engine` selects the engine tests; `npm run test:app` selects the app tests. Use the managed scripts so temporary files remain isolated.

Browser/Electron/GPU harnesses are separate from offline tests. Passing a unit test is not evidence of native playback or controller acceptance. `PREVIEW_REAL` and `LONG_SOURCE` are optional explicit test inputs; no private footage is supplied.

## Repository map

| Folder | Purpose |
| --- | --- |
| `app/` | Electron host, UI, packaging and app tests. |
| `engine/` | Conforming, bitstreams, processing, playback/export and engine tests. |
| `core/` | Shared data types and contracts. |
| `shared/` | Shared UI tokens. |
| `scripts/` | Build/test tooling and the pinned FFmpeg source recipe. |
| `harness/`, `e2e/` | Integration and native checks; these are not loose app assets. |
| `fixtures/` | Instructions plus ignored generated test media. |
| `docs/` | User guides, screenshots, testing and packaging documentation. |
| `third-party/` | Dependency licences and provenance; retain these in distributions. |

Generated `node_modules/`, caches, outputs, test footage and installers are ignored. Keep user profiles, endpoint tokens, private project catalogues and owner media out of commits.

## Packaging and contributions

Use [Windows packaging](WINDOWS-PACKAGING.md) and the [controlled FFmpeg recipe](../scripts/ffmpeg/README.md). The current [unsigned rc4 test prerelease](https://github.com/adrienwax/moshpit/releases/tag/v1.0.0-rc.4-test) is a portable EXE; no installer or Sandbox is required. The four-project Browse pack and its media are included. No stable release has been accepted. The binary, corresponding sources and notices must match; the original app’s MIT licence does not replace dependency licences.

Keep changes focused. Run checks for the affected path and document any native behaviour not exercised. Discuss major feature changes in [Issues](https://github.com/adrienwax/moshpit/issues) first. Use [private security reporting](https://github.com/adrienwax/moshpit/security/advisories/new) for vulnerabilities.
