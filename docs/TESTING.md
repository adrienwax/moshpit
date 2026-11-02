# Short Windows test: Moshpit

[← Moshpit](../README.md) · [Illustrated first project](first-project.md)

Download [Moshpit.exe](https://github.com/adrienwax/moshpit/releases/download/v1.0.0-rc.3-test/Moshpit.exe). This is an unsigned portable Windows x64 prerelease. There is no installation step and Sandbox is optional. Do not disable Windows security to bypass a block; report the exact warning instead.

## One small project

1. **Open:** double-click the EXE. It should reach Home without asking for Node.js or FFmpeg.
2. **Edit:** Home → Starter Mosh, choose three short clips you may use. Play, enable Melt on the middle motion block, change one value and Undo.
3. **Keep:** Ctrl+S saves a `.mosh` project. Close normally, reopen the same EXE and open that project.
4. **Export:** OUT → H.264, **Browse…** to an output folder, then Render. Play the finished video in your normal video player.

Tell us whether all four worked; if not, report the first failing step and the message from Notifications. No controller test or uninstall/reinstall is needed for this portable release. Your original footage must remain available when reopening a project.

Developer checks already cover the new Captures pane, keyboard focus, saved layouts and folder selection. This laptop check addresses a different machine; it is not a request to repeat every automated test.

For bugs, include the internal version from **Help → About Moshpit**, Windows version and numbered steps. Remove personal paths from shared details. Use [Issues](https://github.com/adrienwax/moshpit/issues); vulnerabilities go to [private reporting](https://github.com/adrienwax/moshpit/security/advisories/new).
