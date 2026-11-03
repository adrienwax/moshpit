# Short Windows test: Moshpit

[← Moshpit](../README.md) · [Illustrated first project](first-project.md)

Download [Moshpit.exe](https://github.com/adrienwax/moshpit/releases/download/v1.0.0-rc.4-test/Moshpit.exe). This is an unsigned portable Windows x64 prerelease. There is no installation step and Sandbox is optional. Do not disable Windows security to bypass a block; report the exact warning instead.

## Latest test rc4: included examples and durable copies

No stable release has been accepted yet. These steps are the short independent laptop workflow before stable promotion; they do not need your own footage or a controller.

1. **Browse:** Home → Browse projects. Confirm the four Included entries; select one, play its recorded preview and try a category/search.
2. **Edit:** Open a copy, play it in MOSH, change the suggested parameter and Undo. Ctrl+S saves to a new `.mosh` file.
3. **Reopen:** close Moshpit normally. Start the same portable EXE and open your saved project directly, before visiting Browse. It should play with its media intact.
4. **Export:** OUT → H.264 → Browse… → Render · Add job. Play the exported video. Revisit the included example to confirm it is unchanged.

No separate footage download is needed for these four examples. Record the exact version/hash and first failing step. Source, packaged-app, native playback and another-PC checks remain separate evidence.

Developer checks already cover the new Captures pane, keyboard focus, saved layouts and folder selection. This laptop check addresses a different machine; it is not a request to repeat every automated test.

For bugs, include the internal version from **Help → About Moshpit**, Windows version and numbered steps. Remove personal paths from shared details. Use [Issues](https://github.com/adrienwax/moshpit/issues); vulnerabilities go to [private reporting](https://github.com/adrienwax/moshpit/security/advisories/new).
