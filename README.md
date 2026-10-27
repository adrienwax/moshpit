# Moshpit

**Turn footage into datamoshed edits, broken motion and layered effects.**

Moshpit is a local video editor built around editable blocks, frame controls and processing graphs. Import your own footage, experiment with effects, then keep both a rendered video and an editable `.mosh` project.

**Free, open-source development release. Source is available now; public Windows installers are not available yet.** Local unsigned installer candidates are being checked for portability, dependency licences and signing. They have not passed a fresh-Windows acceptance test. The installer changes are not yet on this public branch.

[Quick start](QUICKSTART.md) · [Report a bug](https://github.com/adrienwax/moshpit/issues) · [Report a vulnerability privately](https://github.com/adrienwax/moshpit/security/advisories/new) · [MIT licence](LICENSE)

## Make your first edit

| Workspace | What to do |
| --- | --- |
| **IN** | Import a clip and choose the section you want to use. |
| **MOSH** | Arrange blocks, add effects, and play or step through the result. |
| **GRAPH** | Inspect and adjust the selected block's processing connections. |
| **OUT** | Choose a destination and export a video. |

Save a **`.mosh` project** to return to an edit. Export a **video** to watch or share the result. Projects reference their source footage; saving a project does not collect that footage into the project file. Keep the original media available when reopening or transferring an edit.

Moshpit works with a mouse and keyboard. [CTserver](https://github.com/adrienwax/ctserver) provides optional Loupedeck CT control. Neither a controller nor a private companion library is required. Personal projects and footage are not bundled.

## Run from source

The current target is **Windows x64**. Other operating systems and architectures have not been validated.

You need Git, **Node.js 24 with npm**, and FFmpeg/FFprobe on PATH. Use the Electron version pinned in the lockfile. Codec availability depends on your FFmpeg build; a minimal build may not support every export/effect path.

```powershell
git clone https://github.com/adrienwax/moshpit.git
cd moshpit
npm ci
npm run build:app
npm start
```

`npm ci` can run dependency installation scripts, including downloading Electron. Review them before installing. `npm start` builds and launches the desktop app. `npm ci --ignore-scripts` is useful for source-only checks, but does not install the Electron runtime needed to launch.

If FFmpeg is not on PATH, set `MOSHPIT_FFMPEG` to its full executable path before starting. Build scratch files use `%LOCALAPPDATA%/KRAB/scratch`; set `KRAB_SCRATCH_ROOT` to an absolute path to choose another location. These are developer settings, not required application preferences.

## If something does not work

| Symptom | First check |
| --- | --- |
| App does not launch after installing dependencies | Confirm Node 24 and that Electron's installation script completed. Keep the terminal error for a bug report. |
| Import or export fails | Check FFmpeg/FFprobe availability and the selected codec. The Notifications pane retains error details for copying. |
| A saved project cannot find its footage | Restore the source file at the referenced location; a `.mosh` file is not a media archive. |
| A render differs on another machine | Compare encoder versions, codecs and graphics drivers. Byte-identical output across machines is not promised. |

## Development checks

```powershell
npm run typecheck
npm test
npm run test:app
node --test scripts/build-scratch/bootstrap.test.mjs scripts/check-public-defaults.mjs
```

Some integration harnesses need separately prepared media fixtures. Use disposable scratch folders for tests. Passing source/unit tests is separate from native playback, GPU behaviour and physical-controller testing.

The initial public source was checked on Windows with Node 24: dependency installation with scripts disabled, application build, typecheck and focused portability tests passed. That build produced Electron JavaScript and a renderer, not a public installer. Vite's upstream `use client` and chunk-size warnings were retained.

<details>
<summary>Packaging and optional test inputs</summary>

The public branch's packaging script is `app/pack.mjs`. It requires `MOSHPIT_FFMPEG_DIR` containing reviewed `ffmpeg.exe` and `ffprobe.exe`, electron-builder **26.15.3** installed locally or selected through `MOSHPIT_BUILDER_CLI`, and an icon PNG generated from the supplied SVG. The standalone public packaging procedure remains under review. Local installer fixes will be published separately after review; do not assume unpublished candidate flags exist here.

Optional preview benchmarks use explicit `PREVIEW_REAL` paths separated by semicolons. The long-render harness requires `LONG_SOURCE`; `LONG_DIR` selects a scratch parent. No personal test footage is supplied.

</details>

## Licences and redistribution

Original project code is **MIT**, copyright **2026 ak wax**. See [LICENSE](LICENSE), [third-party notices](THIRD-PARTY-NOTICES.txt), [asset notices](ASSET-NOTICES.txt) and the [third-party directory](third-party).

Dependencies retain their own licences. In particular, Mediabunny is MPL-2.0, and FFmpeg's obligations depend on the exact build and linked libraries. MIT on this repository does not relicense those components. The current local FFmpeg candidate is GPL-enabled; complete corresponding source/build materials remain a gate before distributing that binary. This source repository does not include that FFmpeg binary.

## Help and contributions

Use [GitHub Issues](https://github.com/adrienwax/moshpit/issues) for bugs and feature proposals. Include the commit/version, Windows version, steps, expected/actual behaviour, and relevant notification details. Use a small clip you have permission to share; remove private paths and credentials from logs.

For contributions, discuss substantial changes in an issue first, keep patches focused, and include a reproducer or regression check. Do not commit footage, caches, generated installers or credentials.

For security vulnerabilities, use [private reporting](https://github.com/adrienwax/moshpit/security/advisories/new), not a public issue. See [SECURITY.md](SECURITY.md) for scope and handling.
