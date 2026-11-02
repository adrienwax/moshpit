# Controlled local FFmpeg build

This recipe builds external command-line tools for Moshpit. It does not install or replace an existing app and never uploads anything. It is not a signing or redistribution approval.

The pinned FFmpeg revision matches the original local tool's FFmpeg code. External libraries are now built from the exact archives in `sources.json`; no claim is made that the old binary used those same external inputs.

Runtime inputs: FFmpeg, x264 (H.264 encode), Snappy (Hap compression), zlib (PNG/compression), dav1d (AV1 decode), zimg with its graphengine submodule (HDR conversion). Optional external encoders used solely to *generate* test inputs are not part of this build. Native FFmpeg decoders/encoders/filters remain enabled. Network input is disabled for this local-file editor.

## Prepare and build

Use an isolated MSYS2 UCRT64 environment with GCC, make, CMake, Ninja, NASM, pkgconf, Meson, autoconf, automake and libtool. Python prepares the inputs. The local validation used the official MSYS2 20260927 portable archive; its SHA256 is `ea2f31a0b6ade63914ce441ffb022f0f6aa96982bfefa2326460a26d5fb01322`. Each build records its actual package/compiler versions. Compiler versions are not locked by this recipe; bit-identical rebuilds are not promised.

```powershell
python scripts/ffmpeg/prepare-sources.py --output C:/BuildScratch/ffmpeg-01
```

Then in that UCRT64 shell (no spaces in the build-root path):

```sh
bash /path/to/moshpit/scripts/ffmpeg/build-ucrt64.sh /c/BuildScratch/ffmpeg-01
```

`KRAB_BUILD_JOBS` defaults to 4. All download hashes are checked before extraction. Build stages use archived inputs, disable optional test/example subprojects and Meson downloads, and produce `prefix/bin/ffmpeg.exe` and `ffprobe.exe`. zimg's documentation links are materialized from files within its own archive. Its runtime graphengine submodule is pinned separately; optional googletest and Snappy benchmark/test submodules are not built.

Keep `archives/`, `sources.json`, this recipe, generated configuration/logs, notices, compiler/package inventory and binary hashes together as the corresponding-source/build record. Review imported DLLs and the notices for any statically linked toolchain runtime. Do not label source collection alone as binary clearance.

## Required checks before packaging

Run `check-capabilities.py` against the new pair in a fresh output directory. Then run Moshpit's conform/bitstream/preview/export tests with `MOSHPIT_FFMPEG` pointing to the new executable, using synthetic fixtures (including HEVC/VP9/AV1/HDR imports). Check the standalone files without the build toolchain on PATH. Fresh-Windows application acceptance and signing remain separate gates.
