# Local example projects

Use **Starter Mosh** with your own footage for a ready-made sequence. No footage is downloaded or bundled.

Home can also show a local examples shelf. Advanced users can create `config/examples.json` inside the app's user-data folder. Candidate and ordinary installations use separate profiles. The shelf is hidden when the file is absent; no drive is scanned.

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

`group` is `mix` or `pixelord`. Optional `preview` is an absolute local MP4 path. Projects must be local `.mosh` files; up to 96 entries are supported. Keep their source footage available: a project file does not contain that footage.

Choose a card to **open an unsaved copy** with a fresh identity. Save prompts for a destination; the example and its recovery journal are not changed. Choose a new filename to preserve the example. Existing unsaved work still gets the usual save/discard/cancel prompt.

This index is personal configuration. Do not commit it, private projects or footage to the public repository.
