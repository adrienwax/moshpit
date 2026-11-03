Public starter pack authoring

This is a build-time tool, not an app-startup dependency. It creates original
procedural footage and renders four editable studies through Moshpit's actual
EngineService. No third-party footage, audio, font or image asset is used.

Prerequisites: existing locked Node dependencies, installed Electron runtime,
and the same reviewed FFmpeg binary used for the release. No extra npm packages.

From the repository root in PowerShell:
  $env:KRAB_SCRATCH_ROOT = 'E:/your-isolated-build-root'
  $env:MOSHPIT_FFMPEG = 'C:/your-reviewed-tools/ffmpeg.exe'
  node scripts/examples/build-pack.mjs --out E:/your-isolated-build-root/pack --work E:/your-isolated-build-root/work

Both output/work directories must be new and distinct, inside KRAB_SCRATCH_ROOT.
The command starts the existing managed process wrapper, generates the clips,
opens one hidden private Electron renderer for the engine/GPU, renders and fully
decodes all four previews, then quits normally. Do not run concurrently with
another native/GPU acceptance job. Failures retain evidence; no force-kill path.

For compile-only preparation, append --prepare-only and use different new paths.
No media generation or Electron launch occurs with that flag.

Checks without native/GPU:
  node --test scripts/examples/checks.test.mjs
  node scripts/examples/check-pack.mjs <absolute-pack-directory>

Output: manifest.json plus two source clips, four matching master/proxy files,
four projects, four H.264 previews and licensing/provenance. Project paths use
pack:// references; the application materializes the immutable pack in persistent
user storage before opening a copy. Never open these templates directly as if
pack:// were an ordinary filesystem path.

The first two examples are Pixelord-inspired mechanism studies, not assertions
of identical reproduction. Chroma ghost demonstrates channel history; Breathing
feedback demonstrates LFO modulation. The build report records actual engine
checks; software/native usability and visual judgement remain separate.

The generator is deterministic at the source-pixel level. Encoded results and
project IDs/timestamps may differ across runs, codecs or GPUs. Each generated
pack has exact file hashes. Keep one accepted pack pinned for a release instead
of silently regenerating assets under an existing release tag.
