// Plain .mjs, same reason as the other script tests.
//
// Only the RENDERING is tested here — the pure half that turns resolved paths into a plist or a
// Scheduled Task XML. Handing those to `launchctl` / `schtasks` needs the actual OS and cannot
// run on the other platform at all, so it lives in `npm run service:doctor` instead: a one-time
// check per machine at install time rather than a per-change test.
//
// The assertions concentrate on absolute paths. A LaunchAgent gets a minimal environment, so a
// bare `node`, `npm` or `git` in the generated artifact is the single most likely way a real
// install breaks — and the git/npm case breaks UPDATING rather than starting, which surfaces
// weeks later as an operator complaint.
import { describe, expect, test } from 'vitest';
import {
  SERVICE_LABEL,
  TASK_NAME,
  adapterFor,
  renderHiddenShim,
  renderLaunchAgent,
  renderScheduledTask,
  resolvePaths,
} from '../../scripts/service.mjs';

/** A macOS install. `platform` is explicit so the suite behaves the same on any machine. */
const PATHS = resolvePaths({
  root: '/Users/rep/linkedin-conn',
  execPath: '/opt/homebrew/bin/node',
  which: (cmd) => (cmd === 'npm' ? '/opt/homebrew/bin/npm' : '/usr/local/git/bin/git'),
  platform: 'darwin',
});

/** A Windows install. */
const WIN_PATHS = resolvePaths({
  root: 'C:\\Users\\rep\\machine',
  execPath: 'C:\\Program Files\\nodejs\\node.exe',
  which: (cmd) => (cmd === 'npm' ? 'C:\\Program Files\\nodejs\\npm' : 'C:\\Program Files\\Git\\bin\\git.exe'),
  platform: 'win32',
});

describe('resolvePaths', () => {
  test('locates node, npm AND git — the update needs all three', () => {
    expect(PATHS.node).toBe('/opt/homebrew/bin/node');
    expect(PATHS.npm).toBe('/opt/homebrew/bin/npm');
    expect(PATHS.git).toBe('/usr/local/git/bin/git');
  });

  test('puts every tool directory on the baked PATH', () => {
    // Without git's directory here, The Machine starts perfectly and then cannot update —
    // the most confusing version of this bug.
    expect(PATHS.pathDirs).toContain('/opt/homebrew/bin');
    expect(PATHS.pathDirs).toContain('/usr/local/git/bin');
  });

  test('does not repeat a directory shared by two tools', () => {
    const dirs = resolvePaths({ execPath: '/usr/bin/node', which: () => '/usr/bin/npm', platform: 'darwin' }).pathDirs;
    expect(dirs.filter((d) => d === '/usr/bin')).toHaveLength(1);
  });

  test('a missing tool is reported as null rather than crashing the install', () => {
    const p = resolvePaths({ execPath: '/usr/bin/node', which: () => null, platform: 'darwin' });
    expect(p.npm).toBeNull();
    expect(p.git).toBeNull();
  });

  test('the fallback directories and separator match the target platform', () => {
    // POSIX directories on a Windows PATH are not just untidy: they are noise in the one place
    // somebody will be reading when they are trying to work out why an update cannot find git.
    expect(PATHS.pathSep).toBe(':');
    expect(PATHS.pathDirs).toContain('/usr/bin');
    expect(WIN_PATHS.pathSep).toBe(';');
    expect(WIN_PATHS.pathDirs.some((d) => d.startsWith('/'))).toBe(false);
    expect(WIN_PATHS.pathDirs.join(';')).toMatch(/System32/i);
  });

  test('points at supervisor.mjs, never at the app directly', () => {
    // The app cannot restart itself; pointing the login hook at it would lose Update entirely.
    expect(PATHS.supervisor).toMatch(/supervisor\.mjs$/);
    expect(PATHS.supervisor).not.toMatch(/index\.ts/);
  });

  test('builds paths with the TARGET platform\'s separator, not the host\'s', () => {
    // Otherwise a `platform` argument that appears to work silently produces artifacts with the
    // wrong separators whenever the suite runs on the other OS.
    expect(PATHS.supervisor).toBe('/Users/rep/linkedin-conn/scripts/supervisor.mjs');
    expect(PATHS.logOut).toBe('/Users/rep/linkedin-conn/data/service.out.log');
    expect(WIN_PATHS.supervisor).toBe('C:\\Users\\rep\\machine\\scripts\\supervisor.mjs');
  });
});

describe('renderLaunchAgent', () => {
  const plist = renderLaunchAgent(PATHS);

  test('runs node by absolute path, with the supervisor as its argument', () => {
    expect(plist).toContain('<string>/opt/homebrew/bin/node</string>');
    // Asserted against the resolved value rather than a literal: node:path uses the separator
    // of the machine running the suite, and this renderer only ever executes on macOS in real
    // life. The invariant that matters is that the plist points at whatever was resolved.
    expect(plist).toContain(`<string>${PATHS.supervisor}</string>`);
    expect(PATHS.supervisor).toMatch(/supervisor\.mjs$/);
  });

  test('sets the working directory to the checkout', () => {
    expect(plist).toContain('<key>WorkingDirectory</key>');
    expect(plist).toContain('<string>/Users/rep/linkedin-conn</string>');
  });

  test('bakes a PATH that includes git and npm', () => {
    expect(plist).toMatch(/<key>PATH<\/key>\s*<string>[^<]*\/usr\/local\/git\/bin[^<]*<\/string>/);
  });

  test('RunAtLoad, and deliberately NO KeepAlive', () => {
    // The supervisor owns restarts. KeepAlive would be a second, dumber restart policy
    // fighting the good one, and launchd would hammer a config-broken app.
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).not.toContain('KeepAlive');
  });

  test('is a per-user Agent, carrying the shared label', () => {
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain('<key>ProcessType</key>');
  });

  test('sends output to a file, since there is no console to read', () => {
    expect(plist).toContain('service.out.log');
  });

  test('escapes a path containing an ampersand rather than emitting invalid XML', () => {
    const odd = resolvePaths({ root: '/Users/rep/R&D/machine', execPath: '/usr/bin/node', which: () => '/usr/bin/npm', platform: 'darwin' });
    expect(renderLaunchAgent(odd)).toContain('R&amp;D');
    expect(renderLaunchAgent(odd)).not.toMatch(/R&D/);
  });

  test('joins the PATH with colons, not semicolons', () => {
    expect(plist).toMatch(/<string>[^<]*:[^<]*<\/string>/);
    expect(plist).not.toMatch(/<key>PATH<\/key>\s*<string>[^<]*;[^<]*<\/string>/);
  });
});

describe('renderHiddenShim', () => {
  const shim = renderHiddenShim(PATHS);

  test('bakes the PATH, because Task Scheduler XML cannot declare environment variables', () => {
    // Without this, Windows has the same latent bug as a LaunchAgent with a bare `node`: The
    // Machine starts perfectly and then cannot UPDATE, because git and npm are missing from
    // whatever PATH the logon session handed it.
    const winShim = renderHiddenShim(WIN_PATHS);
    expect(winShim).toContain('sh.Environment("PROCESS")("PATH")');
    expect(winShim).toContain('C:\\Program Files\\Git\\bin');
    // Prepended to the inherited PATH rather than replacing it.
    expect(winShim).toContain('ExpandEnvironmentStrings("%PATH%")');
  });

  test('hides the window and does not wait', () => {
    // node.exe is a console-subsystem binary and there is no nodew.exe; wscript.exe is the
    // GUI-subsystem host Windows already ships. 0 = hidden, False = do not wait.
    expect(shim).toMatch(/sh\.Run .*, 0, False/);
  });

  test('runs node and the supervisor by absolute path, quoted', () => {
    expect(shim).toContain('"/opt/homebrew/bin/node"');
    expect(shim).toContain('supervisor.mjs');
  });

  test('redirects output to service.out.log — otherwise a hidden failure is invisible', () => {
    // Found in real-world testing: nothing ever wrote to service.out.log on Windows. With no
    // console and no redirect, a service that fails to start gives the operator nothing but
    // "the dashboard will not load", and service:doctor cannot say why. WScript.Shell.Run
    // cannot redirect, hence the cmd /c wrapper.
    const winShim = renderHiddenShim(WIN_PATHS);
    expect(winShim).toContain('cmd /c');
    expect(winShim).toContain('service.out.log');
    expect(winShim).toContain('2>&1');
    // Appended, not truncated: the previous run's failure is usually the interesting one.
    expect(winShim).toMatch(/>>\s*""/);
  });

  test('sets the working directory', () => {
    expect(shim).toContain('sh.CurrentDirectory = "/Users/rep/linkedin-conn"');
  });

  test('doubles embedded quotes, which is how VBScript escapes them', () => {
    // The command is one VBScript string literal, so its inner quotes must be doubled or the
    // shim is a syntax error and nothing starts at all. Verified for real against wscript.exe
    // during development; `npm run service:doctor` is what re-checks it per machine.
    expect(renderHiddenShim(WIN_PATHS)).toContain('""C:\\Program Files\\nodejs\\node.exe""');
  });
});

describe('renderScheduledTask', () => {
  const xml = renderScheduledTask(PATHS, { userId: 'CORP\\rep', shimPath: 'C:\\m\\data\\start-hidden.vbs' });

  test('triggers at logon for that user', () => {
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('CORP\\rep');
  });

  test('uses an INTERACTIVE token — without it the LinkedIn browser can never be seen', () => {
    // This is the whole reason this is a Scheduled Task and not a Windows service: a Session 0
    // process has no desktop, so nobody could log in to LinkedIn or solve a checkpoint.
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  test('launches through wscript, not node directly', () => {
    expect(xml).toContain('<Command>wscript.exe</Command>');
    expect(xml).toContain('start-hidden.vbs');
  });

  test('never stops the task on a time limit — this runs all day', () => {
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  });

  test('a second logon does not start a second copy', () => {
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  });

  test('keeps running on battery — a laptop unplugged mid-afternoon must not stop', () => {
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
  });

  test('is declared UTF-16, which is what schtasks /XML requires', () => {
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-16"\?>/);
  });

  test('carries the shared task name', () => {
    expect(xml).toContain(TASK_NAME);
  });
});

describe('resolvePaths knows where the lock lives', () => {
  test('exposes dataDir, so the installer can ask whether a copy is already running', () => {
    // Found in real-world testing: registering a LOGON-triggered Scheduled Task does not run it,
    // unlike `launchctl bootstrap` on a RunAtLoad agent. The installer used to print "it is
    // starting now" either way, so on Windows nothing happened until the next login — which
    // reads exactly like a broken install. It now runs the task, unless a copy holds the lock.
    expect(PATHS.dataDir).toBe('/Users/rep/linkedin-conn/data');
    expect(WIN_PATHS.dataDir).toBe('C:\\Users\\rep\\machine\\data');
  });
});

describe('adapterFor', () => {
  test('picks an adapter per platform, and admits when there is none', () => {
    expect(adapterFor('darwin')).not.toBeNull();
    expect(adapterFor('win32')).not.toBeNull();
    expect(adapterFor('linux')).toBeNull();
  });

  test('every adapter offers the same three verbs', () => {
    for (const platform of ['darwin', 'win32']) {
      const a = adapterFor(platform);
      expect(typeof a.install).toBe('function');
      expect(typeof a.uninstall).toBe('function');
      expect(typeof a.status).toBe('function');
    }
  });
});
