# First-use check: Moshpit

[← Moshpit](../README.md) · [Illustrated first project](first-project.md)

For someone trying a candidate supplied by the maintainer. There is no public signed installer yet. Use the supplied clean-Windows/Sandbox kit when available; **do not disable Windows security or install on your main editing setup just to get past a warning**. Report the exact warning instead.

## One useful session

1. **Install and open.** Can you find the app and reach Home without developer tools? Record the version and any warning.
2. **Bring footage.** Use three small clips you may use. Can you find Starter Mosh and understand when preparation is finished?
3. **Make a change.** Play, select the middle block, enable Melt, change a parameter, then Undo. Is it clear what is selected and what changed?
4. **Keep the work.** Save `.mosh`, close normally and reopen it. Are the clips and edits still there?
5. **Share the result.** Export H.264 and play the file outside Moshpit. Does it contain the expected picture and audio?
6. **Finish safely.** In the disposable test environment, check uninstall/reinstall and whether expected user data remains. Do not use your only copy of a project for this.

## Tell us what was confusing

- Which instruction first required guessing? Quote the button or paragraph.
- What did you expect to happen, and what happened instead?
- Could you distinguish a **project** from an **export**, and **browsing** from **adding a clip**?
- Which error or waiting state did not explain what to do next?

For a failure, include app version, Windows version, numbered steps and copied notification details. Share a screenshot or small clip only after checking it for private paths and content. Use [Issues](https://github.com/adrienwax/moshpit/issues); vulnerabilities go to [private reporting](https://github.com/adrienwax/moshpit/security/advisories/new).

A developer-machine pass does not establish clean-Windows compatibility. A clean-Windows pass does not establish performance on every GPU. Record what was actually tried.
