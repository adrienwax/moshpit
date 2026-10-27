// Settings → Media root → Browse… opens the REAL native folder dialog; Win32 messages type a
// folder into it and presses Select Folder; the setting takes it and the library rescans to it.
//   node app/test/picker.e2e.mjs                         (dev build: node app/build.mjs first)
//   MOSHPIT_EXE=<built .exe> node app/test/picker.e2e.mjs (packaged, driven over CDP)
import { _electron as electron, chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Test windows open off-screen and never take focus (electron/main.ts).
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-picker');
const userData = path.join(out, 'userdata');
const pickDir = path.join(root, 'fixtures');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

// Win32 (the folder box and buttons are not in the UI Automation tree): wait for the dialog by
// title, set the Folder box, click IDOK (Select Folder).
const uia = path.join(out, 'pick.ps1');
fs.writeFileSync(uia, `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class W {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr d, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, Cb f, IntPtr l);
  public static IntPtr ById(IntPtr d, int id) { IntPtr r = IntPtr.Zero; EnumChildWindows(d, (h, l) => { if (GetDlgCtrlID(h) == id) { r = h; return false; } return true; }, IntPtr.Zero); return r; }
  public static string Dump(IntPtr d) { var sb = new StringBuilder(); EnumChildWindows(d, (h, l) => { var c = new StringBuilder(64); GetClassName(h, c, 64); sb.Append(c + "#" + GetDlgCtrlID(h) + " "); return true; }, IntPtr.Zero); return sb.ToString(); }
}
"@
$dlg = [IntPtr]::Zero
for ($i = 0; $i -lt 100 -and $dlg -eq [IntPtr]::Zero; $i++) { $dlg = [W]::FindWindow('#32770', $args[0]); if ($dlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 } }
if ($dlg -eq [IntPtr]::Zero) { 'no dialog'; exit 1 }
'dialog'
$edit = [IntPtr]::Zero
for ($i = 0; $i -lt 50 -and $edit -eq [IntPtr]::Zero; $i++) {
  $edit = [W]::ById($dlg, 1152)   # the Folder: box
  if ($edit -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
}
if ($edit -eq [IntPtr]::Zero) { 'no folder box: ' + [W]::Dump($dlg); exit 1 }
[void][W]::SendMessage($edit, 0x000C, [IntPtr]::Zero, $args[1])   # WM_SETTEXT
[void][W]::SendMessage([W]::ById($dlg, 1), 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)   # BM_CLICK on IDOK (Select Folder)
'selected'
`);

const exe = process.env.MOSHPIT_EXE;
let pid, win;
if (exe) {
  pid = spawn(exe, [`--user-data-dir=${userData}`, '--remote-debugging-port=9336'], { stdio: 'ignore' }).pid;
  let browser;
  for (let i = 0; i < 120 && !browser; i++) browser = await chromium.connectOverCDP('http://127.0.0.1:9336').catch(() => new Promise((r) => setTimeout(r, 1000)));
  for (let i = 0; i < 60 && !win; i++) {
    win = browser?.contexts().flatMap((c) => c.pages()).find((p) => p.url().endsWith('index.html'));
    if (!win) await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`packaged: ${exe}`);
} else {
  const app = await electron.launch({ args: [path.join(root, 'app/dist/main.cjs'), `--user-data-dir=${userData}`], cwd: root, timeout: 30000 });
  pid = app.process().pid;
  win = await app.firstWindow();
}
try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  await win.locator('.topbar .cog').click();
  await win.getByText('Folders & paths', { exact: true }).first().click();
  const input = win.getByRole('textbox', { name: 'Media root(s)' });
  const browse = input.locator('xpath=following-sibling::button[1]');
  check('Browse… is enabled in the desktop app', await browse.isEnabled(), await browse.getAttribute('title'));
  await browse.click();
  let ps;
  try { ps = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', uia, 'Choose Media root(s)', pickDir], { encoding: 'utf8', timeout: 40000 }); } catch (e) { ps = String(e.stdout ?? e); }
  check('the native folder dialog opened', /dialog/.test(ps), ps.trim().replace(/\s+/g, ' '));
  check('a folder was typed into it and Select Folder pressed', /selected/.test(ps));
  await win.waitForFunction((want) => document.querySelector('input[aria-label="Media root(s)"]')?.value === want, pickDir, { timeout: 10000 }).catch(() => {});
  check('the setting took the picked folder', (await input.inputValue()) === pickDir, await input.inputValue());
  const toastEl = win.locator('.toasts .toast', { hasText: 'Library rescanned' });
  check('the library rescanned at once (no restart)', await toastEl.first().waitFor({ timeout: 15000 }).then(() => true, () => false), await toastEl.first().innerText().catch(() => ''));
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell').first().waitFor({ timeout: 20000 });
  const names = await win.locator('.gcell').allInnerTexts();
  check('Browse lists the picked folder\'s clips', names.some((n) => /src-a\.mp4/.test(n)), `${names.length} clips`);
  const cfg = path.join(userData, 'config', 'settings.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(cfg, 'utf8')).paths.media; } catch { return undefined; } };
  for (let i = 0; i < 50 && read() !== pickDir; i++) await new Promise((r) => setTimeout(r, 100));
  check('the choice is saved to settings.json on disk', read() === pickDir, `${read()} | via app: ${await win.evaluate(() => window.moshpitHost.readConfig('settings').then((x) => x?.paths?.media))}`);
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
} finally {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `picker: ${failed} FAILED` : 'picker: all ok');
process.exit(failed ? 1 : 0);
