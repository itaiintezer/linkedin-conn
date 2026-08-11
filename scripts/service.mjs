/**
 * Make The Machine start itself at login:  npm run service:install
 *
 * One contract, two thin adapters. The OS is responsible for exactly one thing — run
 * `<node> scripts/supervisor.mjs` in this folder when the operator logs in. Restart policy,
 * locking, updating and rollback all live in the supervisor, so both platforms behave
 * identically and neither adapter has to be clever.
 *
 * WHY NOT A REAL SERVICE. Windows services run in Session 0, which has no interactive desktop
 * (and macOS LaunchDaemons are the same). The Machine drives a VISIBLE Chromium that a human has
 * to be able to see and click — LinkedIn login, and solving a checkpoint. A Session 0 process
 * cannot show them either. That is not a limitation we are working around: a service's whole
 * selling point is running with nobody logged in, which for us is useless, because with no
 * interactive session there is no browser and no LinkedIn work can happen at all. A
 * logon-triggered per-user task is the mechanism that actually matches the app's lifetime.
 *
 * WHY THE WSCRIPT SHIM ON WINDOWS. A task whose principal is interactive (which we need, for the
 * reason above) runs `node.exe` on the user's desktop, and node.exe is a console-subsystem
 * binary, so Windows gives it a console window. Node ships no GUI-subsystem variant — there is
 * no `nodew.exe`. `wscript.exe` IS a GUI-subsystem binary shipped with Windows, so a two-line
 * WSH shim is the OS's own supported way to launch without a window. A visible console would
 * also be a window an operator can close, silently stopping everything until the next login.
 *
 * Zero dependencies, plain ESM: same reason as supervisor.mjs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..');

/** One identifier, both platforms. Reverse-DNS for launchd, bare name for Task Scheduler. */
export const SERVICE_LABEL = 'com.intezer.themachine';
export const TASK_NAME = 'TheMachine';

/**
 * Everything the generated artifact needs, resolved to ABSOLUTE paths at install time.
 *
 * This is the part that actually breaks real installs. A LaunchAgent gets a minimal
 * environment — no nvm, no Homebrew — so a bare `node` in the plist may not exist at login.
 * Worse, it is not only node: the update shells out to GIT and NPM, so a service that starts
 * perfectly will fail to UPDATE, which is a much more confusing bug to be handed. All three are
 * located now and their directories baked into the artifact's PATH.
 */
export function resolvePaths({
  root = ROOT, execPath = process.execPath, which = defaultWhich, platform = process.platform,
} = {}) {
  // Paths are built with the TARGET platform's rules, not the host's. In production these are
  // the same thing (adapterFor picks by process.platform, so macOS artifacts are only ever
  // rendered on macOS) — but a `platform` argument that silently does not affect the paths it
  // produces is a trap for whoever writes the next test against it.
  const P = platform === 'win32' ? win32 : posix;
  const node = execPath;
  const npm = which('npm');
  const git = which('git');
  const dirs = [P.dirname(node), npm ? P.dirname(npm) : null, git ? P.dirname(git) : null].filter(Boolean);
  // Platform-appropriate fallbacks. Putting POSIX directories on a Windows PATH (or the reverse)
  // is not merely untidy — it is the sort of noise that makes a broken PATH hard to read when
  // somebody is trying to work out why an update cannot find git.
  const standard = platform === 'win32'
    ? [process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32']
    : ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return {
    root,
    node,
    npm,
    git,
    platform,
    supervisor: P.join(root, 'scripts', 'supervisor.mjs'),
    logOut: P.join(root, 'data', 'service.out.log'),
    pathSep: platform === 'win32' ? ';' : ':',
    // Deduplicated: a plist PATH is whatever we say it is, so say it once.
    pathDirs: [...new Set([...dirs, ...standard])],
  };
}

function defaultWhich(cmd) {
  const isWin = process.platform === 'win32';
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8', timeout: 15_000 });
    return out.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Artifact rendering — pure, and unit-tested. The impure half only hands these to the OS.
// ---------------------------------------------------------------------------

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/**
 * A per-user LaunchAgent. RunAtLoad only — the supervisor owns restarts, so KeepAlive would be
 * a second, dumber restart policy fighting the good one (and launchd would hammer a
 * config-broken app).
 */
export function renderLaunchAgent(paths, { label = SERVICE_LABEL } = {}) {
  const args = [paths.node, paths.supervisor];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(paths.root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(paths.logOut)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(paths.logOut)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(paths.pathDirs.join(paths.pathSep ?? ':'))}</string>
  </dict>
</dict>
</plist>
`;
}

/**
 * The two-line hidden launcher. `0` is "hide the window", `false` is "do not wait".
 * See the header for why this exists rather than pointing the task at node.exe directly.
 */
export function renderHiddenShim(paths) {
  const cmd = `"${paths.node}" "${paths.supervisor}"`;
  const vb = (s) => String(s).replace(/"/g, '""');
  // The PATH is set here rather than in the task XML because Task Scheduler's format has no
  // way to declare environment variables. Without this, Windows has the same latent bug as a
  // macOS LaunchAgent: The Machine starts perfectly and then cannot UPDATE, because `git` and
  // `npm` are not on whatever PATH the logon session happens to hand it.
  return `' Launches The Machine with no console window. wscript.exe is a GUI-subsystem binary,
' which node.exe is not — see scripts/service.mjs for the full reason.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "${vb(paths.root)}"
sh.Environment("PROCESS")("PATH") = "${vb(paths.pathDirs.join(';'))};" & sh.ExpandEnvironmentStrings("%PATH%")
sh.Run "${vb(cmd)}", 0, False
`;
}

/**
 * Scheduled Task XML, logon-triggered, per user.
 *
 * LogonType Interactive and RunLevel LeastPrivilege on purpose: an interactive token is what
 * gives the process a desktop to put the LinkedIn browser on, and nothing here needs admin.
 */
export function renderScheduledTask(paths, { userId = 'USER', shimPath = '' } = {}) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts The Machine (LinkedIn outreach) at logon.</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${xmlEscape(shimPath)}"</Arguments>
      <WorkingDirectory>${xmlEscape(paths.root)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

const plistPath = (label = SERVICE_LABEL) => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const shimPath = (root) => join(root, 'data', 'start-hidden.vbs');

function run(cmd, args, { check = true } = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    if (check) return { ok: false, out: String(e?.stderr || e?.stdout || e?.message || e) };
    return { ok: false, out: '' };
  }
}

const mac = {
  install(paths) {
    const target = plistPath();
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(dirname(paths.logOut), { recursive: true });
    writeFileSync(target, renderLaunchAgent(paths));
    // bootout first so a re-install replaces cleanly rather than erroring as already loaded.
    run('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}/${SERVICE_LABEL}`], { check: false });
    const res = run('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? ''}`, target]);
    return res.ok ? { ok: true, where: target } : { ok: false, where: target, error: res.out };
  },
  uninstall() {
    const target = plistPath();
    run('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}/${SERVICE_LABEL}`], { check: false });
    if (existsSync(target)) rmSync(target, { force: true });
    return { ok: true, where: target };
  },
  status() {
    const target = plistPath();
    if (!existsSync(target)) return { installed: false, detail: 'no LaunchAgent file' };
    const res = run('launchctl', ['print', `gui/${process.getuid?.() ?? ''}/${SERVICE_LABEL}`], { check: false });
    return { installed: true, running: res.ok, detail: target };
  },
};

const win = {
  install(paths) {
    mkdirSync(dirname(paths.logOut), { recursive: true });
    const shim = shimPath(paths.root);
    writeFileSync(shim, renderHiddenShim(paths));

    const userId = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`.replace(/^\\/, '');
    const xmlFile = join(paths.root, 'data', 'themachine-task.xml');
    // schtasks reads the XML as UTF-16LE with a BOM, per the declaration we render.
    writeFileSync(xmlFile, '﻿' + renderScheduledTask(paths, { userId, shimPath: shim }), 'utf16le');

    run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { check: false });
    const res = run('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', xmlFile]);
    rmSync(xmlFile, { force: true });
    return res.ok ? { ok: true, where: `Scheduled Task "${TASK_NAME}"` } : { ok: false, where: TASK_NAME, error: res.out };
  },
  uninstall(paths) {
    run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { check: false });
    rmSync(shimPath(paths.root), { force: true });
    return { ok: true, where: `Scheduled Task "${TASK_NAME}"` };
  },
  status() {
    const res = run('schtasks', ['/Query', '/TN', TASK_NAME], { check: false });
    return { installed: res.ok, running: undefined, detail: res.ok ? res.out.trim().split('\n').slice(-1)[0] : 'not registered' };
  },
};

/** The adapter for this machine, or null on a platform we do not automate. */
export function adapterFor(platform = process.platform) {
  if (platform === 'darwin') return mac;
  if (platform === 'win32') return win;
  return null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const UNSUPPORTED = `
Automatic start-at-login is set up for macOS and Windows only.

On Linux, the equivalent is a user systemd unit running:
  <node> scripts/supervisor.mjs   (WorkingDirectory = this folder)
`;

async function main() {
  const action = (process.argv[2] ?? 'install').replace(/^--/, '');
  const adapter = adapterFor();
  if (!adapter) {
    console.error(UNSUPPORTED);
    process.exit(1);
  }
  const paths = resolvePaths();

  if (action === 'status') {
    const s = adapter.status(paths);
    console.log(`\nThe Machine — start at login: ${s.installed ? 'INSTALLED' : 'not installed'}`);
    console.log(`  ${s.detail}\n`);
    return;
  }

  if (action === 'uninstall') {
    const r = adapter.uninstall(paths);
    console.log(`\nRemoved ${r.where}. The Machine will no longer start when you log in.`);
    console.log('It is not running any differently right now — this only affects the next login.\n');
    return;
  }

  if (action !== 'install') {
    console.error(`Unknown action "${action}". Use install, uninstall or status.`);
    process.exit(1);
  }

  // Missing git or npm is not fatal for STARTING, but it is fatal for updating — and finding
  // that out weeks later, from an operator, is the failure mode this warning exists to prevent.
  for (const [name, found] of [['npm', paths.npm], ['git', paths.git]]) {
    if (!found) console.warn(`Warning: could not find ${name} on the PATH. The Machine will start, but updating it will fail.`);
  }

  const r = adapter.install(paths);
  if (!r.ok) {
    console.error(`\nCould not set up start-at-login.\n\n${r.error}\n`);
    console.error('You can still run The Machine by hand with `npm start`.\n');
    process.exit(1);
  }

  console.log('\nDone. The Machine will start by itself every time you log in.');
  console.log(`  Registered:  ${r.where}`);
  console.log(`  Dashboard:   http://localhost:${process.env.PORT ?? 4400}`);
  console.log('\nIt is starting now. Give it a few seconds, then open the dashboard link above');
  console.log('and bookmark it — that page is how you use and control The Machine.\n');
}

const invoked = process.argv[1] ?? '';
const isMain =
  invoked !== '' &&
  (pathToFileURL(invoked).href === import.meta.url || basename(invoked) === basename(fileURLToPath(import.meta.url)));

if (isMain) await main();
