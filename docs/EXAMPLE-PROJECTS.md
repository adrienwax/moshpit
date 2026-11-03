# Browse projects

[← Moshpit](../README.md) · [Quick start](QUICKSTART.md)

**The [rc4 test download](https://github.com/adrienwax/moshpit/releases/tag/v1.0.0-rc.4-test) includes four examples and their media.** You can start without your own clips. No stable release has been accepted yet.

## Watch → open a copy → make it yours

1. On **Home → Browse projects**, select a project. Use Search or **Pixelord inspired / Recipe mixes** to narrow the list.
2. Play the recorded preview; it loops and has its own playback controls. This is a finished example, not the live editor.
3. Choose **Open a copy** to enter MOSH with the editable project. Press Play beneath the main viewer.
4. Try the suggested control below. **Ctrl+Z** undoes the change.
5. **Ctrl+S** saves your copy to a chosen `.mosh` file. Export a shareable video through **OUT → H.264 → Browse… → Render · Add job**.

| Included project | What it teaches | First experiment |
| --- | --- | --- |
| **Replay one P-frame** | Repeating an encoded motion update can drift the picture instead of freezing a displayed frame. | Select Hold and change Times. |
| **Texture carry / clean reset** | Motion can carry an earlier texture; Picture introduces a fresh image. | Change the middle block between Motion and Picture. |
| **Chroma ghost** | Delayed colour channels and a chroma trail separate colour from moving shapes. | Change Chroma trail Back or Wet. |
| **Breathing feedback** | An LFO varies Feedback trail Amount over time. | Open Modulation and change Breathing trail period. |

The first two are **Pixelord-inspired mechanism studies**, not claims of identical recreation. All four use original procedural footage; no outside clips or downloads are required by the packaged app. They demonstrate selected techniques, not every Moshpit feature.

## Your copies and their media

**Open a copy** creates a fresh unsaved project with `(copy)` in its name. The original project and its recovery journal stay unchanged. Existing unsaved work still gets the usual save/discard/cancel prompt.

Included assets are verified and retained under the app's user-data folder at `examples/packs/<manifest hash>`. Normal Windows releases retain settings in `%APPDATA%/Moshpit 3`; private test profiles can use another folder. Saved copies reference these durable media files, not the portable EXE's temporary extraction. Keep this folder: it is not disposable cache. Moving just the `.mosh` file to another computer does not collect its media.

## Add your own local examples

Advanced users can add `config/examples.json` inside the app's user-data folder. These entries appear as **Local** beside the **Included** projects. No drive is scanned, and the app does not rewrite your index.

```json
{
  "schemaVersion": 1,
  "examples": [{
    "id": "my-texture-study",
    "title": "Texture study",
    "group": "mix",
    "file": "C:/My Examples/Texture study.mosh",
    "seconds": 12,
    "hint": "Compare the clean cut and the held motion."
  }]
}
```

`group` is `mix` or `pixelord`. Optional `preview` is an absolute local MP4 path. Projects must be local `.mosh` files; the combined collection is limited to 128 entries, including the four built-in projects. Keep their source footage available: a project file does not contain that footage.

Choose **Open a copy**, then save to a new filename. Your local project still needs its original media. A missing project is marked unavailable; a missing recorded preview does not prevent opening an otherwise available project.

This index is personal configuration. Do not commit it, private projects or footage to the public repository. Source developers can generate the public pack using [the authoring instructions](../scripts/examples/README.txt).
