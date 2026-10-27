# Moshpit

An offline video editor for datamoshing, frame manipulation and effect graphs.

**Source release. Windows binary downloads are not included.**

## Workflow

1. **IN**: import your footage and choose a range.
2. **MOSH**: arrange blocks, add effects and inspect the result.
3. **GRAPH**: connect and adjust a block's processing graph.
4. **OUT**: choose a destination and export. Save a `.mosh` project to keep an editable version.

No personal footage, projects or companion knowledge base is supplied.

## Source setup

Windows x64 is the current target. Use Node 24 and the exact Electron version
in `package.json`. Install locked dependencies with `npm ci`. Installation
can run third-party build scripts; inspect them before running on a new machine.
`npm run build:app` builds the app; `npm start` also opens it.

Build output uses `%LOCALAPPDATA%/KRAB/scratch`, or an absolute directory supplied
through `KRAB_SCRATCH_ROOT`. Set `MOSHPIT_FFMPEG` for an explicit FFmpeg executable;
otherwise development uses PATH. Packaging additionally requires
`MOSHPIT_FFMPEG_DIR` containing the reviewed FFmpeg and FFprobe binaries, and
electron-builder 26.15.3 (via `MOSHPIT_BUILDER_CLI` or a local installation).
These packaging requirements apply to future Windows downloads, not the source-only release.
The PNG app icon must also be generated from the supplied SVG before packaging;
a complete standalone packaging procedure remains unverified.

## Checks

`npm test` runs engine tests; `npm run test:app` runs application unit tests.
`node --test scripts/build-scratch/bootstrap.test.mjs scripts/check-public-defaults.mjs`
checks portable defaults without launching the app. Set TEMP/TMP to a disposable
test folder when running directly. These checks do not establish GPU, native
playback or physical-controller acceptance.

Some legacy integration harnesses still require separately prepared fixtures;
they are not substitutes for a first-use test on another Windows machine.

## Verified source checks

In a fresh local dependency folder on Windows with Node 24, `npm ci --ignore-scripts`,
`npm run build:app` and `npm run typecheck` passed. The build produced Electron
JavaScript and the Vite renderer, not a distributable EXE. Eleven focused default,
test-footage and cache tests also passed. The build reports an upstream `use client`
directive warning and a large-chunk warning; neither was suppressed.

Install scripts were deliberately disabled for those checks. A desktop launch
additionally needs Electron's runtime installation and FFmpeg. No clean-Windows,
GPU/playback or hardware acceptance is claimed by these source results.

## Licence

Original project code: MIT, copyright 2026 ak wax. Dependencies retain their
licences; see `THIRD-PARTY-NOTICES.txt` and `third-party/`. Binary redistribution
is still pending review. Outputs are not guaranteed byte-identical across
encoders, operating systems or graphics drivers.

## Bugs and security

Report reproducible bugs in [GitHub Issues](https://github.com/adrienwax/moshpit/issues). Include the
version or commit, steps, expected result and actual result. Remove personal
paths, footage and credentials from attachments.

For security vulnerabilities, use [private reporting](https://github.com/adrienwax/moshpit/security/advisories/new),
not a public issue. See [SECURITY.md](SECURITY.md).

Optional preview benchmarks read only explicitly supplied `PREVIEW_REAL` paths
(separated by semicolons). The long-render harness requires `LONG_SOURCE`;
`LONG_DIR` selects a scratch parent, with each run using its own temporary subfolder.
