# Short Windows test: Moshpit

[← Moshpit](../README.md) · [Illustrated first project](first-project.md)

Download [Moshpit.exe](https://github.com/adrienwax/moshpit/releases/download/v1.0.0-rc.3-test/Moshpit.exe). This is an unsigned portable Windows x64 prerelease. There is no installation step and Sandbox is optional. Do not disable Windows security to bypass a block; report the exact warning instead.

## Current public rc3: one small project

1. **Open:** double-click the EXE. It should reach Home without asking for Node.js or FFmpeg.
2. **Edit:** Home → Starter Mosh, choose three short clips you may use. Play, enable Melt on the middle motion block, change one value and Undo.
3. **Keep:** Ctrl+S saves a `.mosh` project. Close normally, reopen the same EXE and open that project.
4. **Export:** OUT → H.264, **Browse…** to an output folder, then Render. Play the finished video in your normal video player.

Tell us whether all four worked; if not, report the first failing step and the message from Notifications. No controller test or uninstall/reinstall is needed for this portable release. Your original footage must remain available when reopening a project.

## Upcoming rc4: included examples and durable copies

Use the exact reviewed candidate supplied for this check; the rc3 download above does not contain the new pack. These are acceptance steps, not a claim they have all passed.

1. **Browse:** Home → Browse projects. Confirm the four Included entries; select one, play its recorded preview and try a category/search.
2. **Edit:** Open a copy, play it in MOSH, change the suggested parameter and Undo. Ctrl+S saves to a new `.mosh` file.
3. **Reopen:** close Moshpit normally. Start the same portable EXE and open your saved project directly, before visiting Browse. It should play with its media intact.
4. **Export:** OUT → H.264 → Browse… → Render · Add job. Play the exported video. Revisit the included example to confirm it is unchanged.

No separate footage download is needed for these four examples. Record the exact candidate/hash and first failing step. Source, packaged-app, native playback and another-PC checks remain separate evidence.

Developer checks already cover the new Captures pane, keyboard focus, saved layouts and folder selection. This laptop check addresses a different machine; it is not a request to repeat every automated test.

For bugs, include the internal version from **Help → About Moshpit**, Windows version and numbered steps. Remove personal paths from shared details. Use [Issues](https://github.com/adrienwax/moshpit/issues); vulnerabilities go to [private reporting](https://github.com/adrienwax/moshpit/security/advisories/new).
