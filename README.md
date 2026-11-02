# Moshpit

**Turn clips into motion trails, broken textures and deliberate video glitches.**

A local Windows editor for arranging footage, combining effects and exporting the result. Start with a ready-made sequence; explore individual nodes when you want more control. A Loupedeck CT is optional.

[Get started](#get-moshpit) · [Make your first mosh](#make-your-first-mosh) · [User guide](docs/first-project.md) · [Help](#when-something-goes-wrong) · [Developers](docs/DEVELOPMENT.md)

![Moshpit editing workspace: clips at left, preview and transport in the centre, effects at right and timeline below.](docs/images/moshpit-edit.png)
<sub>Actual Moshpit interface, captured with the built-in synthetic demo. The image illustrates the workspace; it is not a render from supplied footage. Click any screenshot to enlarge it.</sub>

## Get Moshpit

| What you want | Available today |
| --- | --- |
| Read the guide and see the interface | Right here—no installation needed. |
| Download a Windows installer | [Unsigned Windows test kit](https://github.com/adrienwax/moshpit/releases/tag/v1.0.0-rc.2-test) — for Windows Sandbox. A signed stable installer is not available yet. |
| Run or modify the source | [Windows source setup](docs/DEVELOPMENT.md#run-from-source): Git, Node.js 24, npm and FFmpeg/FFprobe. |
| Test the prerelease | Follow the [short first-use checklist](docs/TESTING.md). It is a test build, not a signed release. |

**GitHub’s “Code → Download ZIP” downloads source code, not an installable app.** Download the unsigned test kit from Releases and extract it fully; start with **START-CLEAN-TEST.cmd**. Fresh-Windows acceptance and signing remain pending. Windows x64 is the current target; other platforms are not validated.

## Make your first mosh

![Three stages: IN chooses footage, MOSH arranges and processes it, OUT exports a video.](docs/images/workflow.svg)

Bring **three short video clips you have permission to use**, together in one folder. Moving subjects and textured backgrounds make changes easier to see. No personal footage or sample catalogue is bundled.

1. **Home → Starter Mosh.** Choose that folder when asked. Wait for preparation to finish; Moshpit creates three blocks, using up to ten seconds from each clip.
2. **Press Play below the preview.** You are now in **MOSH**. The timeline is the sequence; the highlighted block is the part you are editing.
3. **Select the middle, MOTION block.** In **Applied effects & parameters**, select **Melt**. Turn **Bypass off** to enable the starter effect—it deliberately begins bypassed.
4. **Change one control, then compare.** Play from before the middle block. Try Bypass on/off; use **Edit → Undo** or **Ctrl+Z** to reverse an edit.
5. **Save the project with Ctrl+S.** Give the `.mosh` file a name. Keep the original clips where they are: the project references them.
6. **Open OUT → H.264.** Choose the output folder, then **Render · Add job**. Watch the render queue for completion and open the resulting video.

You now have **two different things**: a `.mosh` project you can keep editing, and an exported video you can play or share. [The illustrated walkthrough](docs/first-project.md) explains each step and the common terms.

## Know where you are

| Area | What you do there |
| --- | --- |
| **IN** | Browse clips, preview them and choose the range to use. |
| **MOSH** | Arrange picture/motion blocks, select effects and adjust their parameters. |
| **Graph / routing** | Inspect the processing connections for more detailed editing. Start with the effects list if nodes are new to you. |
| **OUT** | Choose a codec and output folder, render, and inspect the queue. H.264 is a useful first choice for sharing. |
| **INFO**, bottom left | Hover or focus a control for its explanation. |
| **Notifications**, bottom right | Reopen messages after popups disappear; expand a message to copy its details. |

**Picture** blocks introduce a fresh image. **Motion** blocks can carry changes from earlier images. A **recipe** groups several effects; a **parameter** is a setting within one. A **conform** is a prepared working copy of imported media. [More terms and examples](docs/first-project.md#the-small-glossary).

<details>
<summary><strong>See the export workspace</strong></summary>

![Moshpit OUT workspace with H.264 selected, output settings at left and render queue at right.](docs/images/moshpit-export.png)

This is the same synthetic UI demonstration. A saved project is not an export, and an empty render queue means no output job has been added yet.

</details>

## When something goes wrong

| Symptom | Try this |
| --- | --- |
| Starter Mosh asks for more clips | Choose one folder with three distinct playable video files. |
| The effect seems absent | Select the intended block/effect, check Bypass, then play from before that block. |
| A reopened project has missing footage | Restore the clips to their referenced paths. Saving `.mosh` does not collect the media. |
| Import or export fails | Open Notifications and copy the error. Source builds need a suitable FFmpeg **and** FFprobe. |
| You cannot find a control | Hover it for INFO; use the IN / MOSH / OUT workspace labels to orient yourself. |

[Report a bug](https://github.com/adrienwax/moshpit/issues) with your version, steps and notification details. Remove personal paths and share footage only if you have permission. Report vulnerabilities through [private security reporting](https://github.com/adrienwax/moshpit/security/advisories/new).

## Explore further

- [First-project guide](docs/first-project.md) · [Candidate test checklist](docs/TESTING.md)
- [Optional local example-project shelf](docs/EXAMPLE-PROJECTS.md)
- [CTserver: optional Loupedeck CT control](https://github.com/adrienwax/ctserver)
- [Source setup, checks and repository map](docs/DEVELOPMENT.md) · [Windows packaging](docs/WINDOWS-PACKAGING.md)

Original code is **MIT**, copyright 2026 **ak wax**. [Dependencies](THIRD-PARTY-NOTICES.txt) and [assets](ASSET-NOTICES.txt) retain their own licences. FFmpeg is an external tool with separate licensing and source requirements; see [packaging](docs/WINDOWS-PACKAGING.md). [Security policy](SECURITY.md).
