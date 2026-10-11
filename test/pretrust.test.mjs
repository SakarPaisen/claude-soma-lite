import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

test('preTrust sets hasTrustDialogAccepted true, preserving existing keys', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { '/other': { x: 1 } }, foo: 'bar' }));
  const { preTrust } = await import('../bin/lib/pretrust.mjs?' + Date.now());
  preTrust('/w/cr-1', home);
  const j = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  assert.equal(j.projects['/w/cr-1'].hasTrustDialogAccepted, true);
  assert.equal(j.projects['/other'].x, 1);
  assert.equal(j.foo, 'bar');
});

// ---------------------------------------------------------------------------
// Helpers. Every test gets its own throwaway HOME; nothing here may go near the
// operator's real ~/.claude.json, which is the whole point of the `home` param.
// ---------------------------------------------------------------------------

// `CLAUDE_CONFIG_DIR` moves the file preTrust writes, and it is *set* on the machine this
// ships to — so an unpinned suite would send every one of these writes into the operator's
// live config dir instead of its temp HOME. Pinned to `''` rather than deleted so the suite
// also holds the module to `||`-not-`??`: with `??` the empty string survives and every test
// below writes a cwd-relative `./.claude.json`. Inherited by the spawned racers too.
process.env.CLAUDE_CONFIG_DIR = '';

/** POSIX modes and symlinks; the repo targets macOS, Linux and WSL. */
const POSIX = process.platform !== 'win32';

const load = async (tag) => (await import('../bin/lib/pretrust.mjs?' + tag + '-' + Date.now())).preTrust;

/** A temp HOME, cleaned up after the test, optionally seeded with a `.claude.json`. */
function freshHome(t, seed) {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (seed !== undefined) {
    writeFileSync(join(home, '.claude.json'), typeof seed === 'string' ? seed : JSON.stringify(seed, null, 2));
  }
  return home;
}

const cfgPath = (home) => join(home, '.claude.json');
const rawCfg = (home) => readFileSync(cfgPath(home), 'utf8');
const readCfg = (home) => JSON.parse(rawCfg(home));
const mode = (fp) => statSync(fp).mode & 0o777;
/** Leftovers of a write: the scratch copy and the lock. Neither may outlive the call. */
const scratch = (home) => readdirSync(home).filter((n) => n.includes('.tmp') || n.endsWith('.lock'));

const pretrustUrl = new URL('../bin/lib/pretrust.mjs', import.meta.url).href;

/**
 * One `preTrust` in its own process, held at a shared barrier so N of them collide.
 *
 * Real processes are the shape the lost-update bug lives in: two soma processes (a manual
 * `soma_spawn` against the watchdog's admission tick) each read the same config and each
 * rename their own version over it. Resolves rather than rejects on a non-zero exit, so the
 * assertions can name which cwd failed and show its stderr.
 */
function racer(home, cwd, startAt) {
  const src = `
    import { preTrust } from ${JSON.stringify(pretrustUrl)};
    while (Date.now() < ${startAt});
    preTrust(${JSON.stringify(cwd)}, ${JSON.stringify(home)});
  `;
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', reject);
    cp.on('exit', (code) => resolve({ cwd, code, err }));
  });
}

test('creates the config on a machine claude has never run on', async (t) => {
  const home = freshHome(t); // no ~/.claude.json at all — first spawn on a fresh box
  const preTrust = await load('create');

  preTrust('/w/cr-1', home);

  assert.deepEqual(readCfg(home), { projects: { '/w/cr-1': { hasTrustDialogAccepted: true } } });
  // The file we create holds nothing secret yet, but claude will fill it with an OAuth
  // account, so it is born as tight as claude's own 0600 rather than umask-wide.
  if (POSIX) assert.equal(mode(cfgPath(home)), 0o600, 'a new config must not be group/world readable');
  assert.deepEqual(scratch(home), [], 'tmp+rename must leave no scratch behind');
});

test('keeps the cwd entry\'s own fields and flips an explicit false', async (t) => {
  // A worktree being retried (retry policy: reuse a clean worktree) already has an entry,
  // and claude keeps real state in it. Clobbering that is how a lead loses its history.
  const entry = {
    allowedTools: ['Bash(git status)'],
    history: [{ display: 'fix the flake', pastedContents: {} }],
    mcpServers: { kite: { command: 'kite' } },
    hasTrustDialogAccepted: false,
    projectOnboardingSeenCount: 3,
    exampleFilesGeneratedAt: 1748000000,
  };
  const home = freshHome(t, { projects: { '/w/cr-1': entry } });
  const preTrust = await load('entry-merge');

  preTrust('/w/cr-1', home);

  const got = readCfg(home).projects['/w/cr-1'];
  assert.equal(got.hasTrustDialogAccepted, true);
  assert.deepEqual(got, { ...entry, hasTrustDialogAccepted: true }, 'every sibling field must survive');
  // The flag was already there, so it keeps its slot instead of being appended: the diff
  // against the operator's previous config is exactly one line.
  assert.deepEqual(Object.keys(got), Object.keys(entry));
});

test('leaves every unrelated top-level key exactly as it was', async (t) => {
  // Shaped like a real ~/.claude.json: settings-gen reads `mcpServers` straight back out of
  // it, and `oauthAccount` is why the file is 0600. Losing any of it is a broken machine.
  const before = {
    numStartups: 572,
    installMethod: 'native',
    autoUpdates: true,
    tipsHistory: { 'ide-hotkey': 12, 'shift-enter': 3 },
    mcpServers: { kite: { command: 'kite-mcp' }, notion: { type: 'http', url: 'https://x/y' } },
    oauthAccount: { accountUuid: 'u-1', emailAddress: 'op@example.com' },
    cachedChangelog: '# 2.1.150\n- things\n',
    fallbackAvailableWarningThreshold: 0.5,
    projects: { '/other': { allowedTools: [], hasTrustDialogAccepted: true } },
  };
  const home = freshHome(t, before);
  const preTrust = await load('toplevel');

  preTrust('/w/cr-1', home);

  const after = readCfg(home);
  assert.deepEqual(after.projects['/w/cr-1'], { hasTrustDialogAccepted: true });
  delete after.projects['/w/cr-1'];
  assert.deepEqual(after, before, 'the only difference may be the entry we added');
});

test('publishes by rename, never by writing the config in place', async (t) => {
  const home = freshHome(t, { projects: { '/other': { hasTrustDialogAccepted: true } } });
  const inoBefore = statSync(cfgPath(home)).ino;
  const preTrust = await load('rename');

  preTrust('/w/cr-1', home);

  // A new inode under the same name is the signature of tmp+rename. An in-place truncate
  // and rewrite would keep the inode — and hand a claude reading concurrently a torn file.
  assert.notEqual(statSync(cfgPath(home)).ino, inoBefore, 'the config must be replaced, not truncated');
  assert.equal(readCfg(home).projects['/w/cr-1'].hasTrustDialogAccepted, true);
  assert.deepEqual(scratch(home), []);
});

test('the config ends up 0600 even if it was lax, and no readable copy is left behind', async (t) => {
  if (!POSIX) return t.skip('POSIX modes');
  const home = freshHome(t, { projects: {} });
  chmodSync(cfgPath(home), 0o644); // an operator (or a restore from backup) widened it
  const preTrust = await load('mode');

  preTrust('/w/cr-1', home);

  assert.equal(mode(cfgPath(home)), 0o600, 'never leave the credential file group-readable');
  // The scratch file is a full copy of that credential file; it must be gone, and it must
  // never have been laxer than the real thing while it existed.
  assert.deepEqual(scratch(home), []);
});

test('an already-trusted cwd is a no-op, not a rewrite', async (t) => {
  // Every spawn calls preTrust. Rewriting a 180 KB config to change nothing only widens the
  // window where claude's own concurrent write loses somebody's edit.
  const home = freshHome(t, '{"projects":{"/w/cr-7":{"hasTrustDialogAccepted":true,"n":1}},"foo":"bar"}');
  const raw = rawCfg(home);
  const ino = statSync(cfgPath(home)).ino;
  const preTrust = await load('noop');

  preTrust('/w/cr-7', home);

  assert.equal(rawCfg(home), raw, 'the file must not even be reformatted');
  assert.equal(statSync(cfgPath(home)).ino, ino, 'no rename means no write happened at all');
  assert.deepEqual(scratch(home), []);
});

test('marks both the resolved and the literal path of a symlinked cwd', async (t) => {
  if (!POSIX) return t.skip('symlinks');
  const home = freshHome(t, { projects: {} });
  const real = join(home, 'real-worktree');
  const link = join(home, 'linked-worktree');
  mkdirSync(real);
  symlinkSync(real, link);
  const preTrust = await load('symlink');

  preTrust(link, home);

  // claude looks itself up under process.cwd(), and getcwd(3) resolves symlinks — so the
  // resolved path is the one that must be there, and macOS makes that concrete: a SOMA_HOME
  // under /tmp or /var/folders is reached through a symlink on every developer machine.
  // That premise is not verified against claude's source though, and being wrong about it
  // costs a silent hang on the dialog, so the literal path is marked too. Two small entries
  // beat guessing.
  const j = readCfg(home);
  assert.equal(j.projects[realpathSync(real)]?.hasTrustDialogAccepted, true, 'the resolved path must be trusted');
  assert.equal(j.projects[link]?.hasTrustDialogAccepted, true, 'the literal path must be trusted too');
  assert.notEqual(realpathSync(real), link, 'this test is pointless if the two paths are the same');
});

test('lands 0600 even under a umask that masks the mode open was given', async (t) => {
  if (!POSIX) return t.skip('POSIX modes');
  const home = freshHome(t, { projects: {} });
  // open()'s mode argument is masked by umask, and a umask that strips the owner write bit
  // turns our 0600 into a 0400 config — which claude then cannot write to either.
  const saved = process.umask(0o200);
  t.after(() => process.umask(saved));
  const preTrust = await load('umask');

  preTrust('/w/cr-1', home);

  // fchmod on the descriptor we hold is what puts that bit back — and it does it without
  // re-resolving the path, so it cannot narrow the wrong inode.
  assert.equal(mode(cfgPath(home)), 0o600);
  assert.equal(readCfg(home).projects['/w/cr-1'].hasTrustDialogAccepted, true);
});

test('never adopts a scratch file someone planted at the predictable name', async (t) => {
  if (!POSIX) return t.skip('symlinks');
  const home = freshHome(t, { projects: {} });
  const decoy = join(home, 'decoy');
  writeFileSync(decoy, 'untouched');
  symlinkSync(decoy, `${cfgPath(home)}.${process.pid}.tmp`);
  const preTrust = await load('planted-scratch');

  preTrust('/w/cr-1', home);

  // Opening that name with plain 'w' would follow the symlink and write a full copy of the
  // operator's OAuth tokens into the decoy — and a chmod-by-path would narrow the wrong
  // inode. unlink-then-O_EXCL, plus fchmod on the descriptor, makes both impossible.
  assert.equal(readFileSync(decoy, 'utf8'), 'untouched', 'the scratch write must not follow a planted symlink');
  assert.equal(readCfg(home).projects['/w/cr-1'].hasTrustDialogAccepted, true);
  assert.deepEqual(scratch(home), []);
});

test('refuses to overwrite a config it cannot parse', async (t) => {
  const home = freshHome(t, '{ "projects": { "/other": {} },,, oops');
  const raw = rawCfg(home);
  const preTrust = await load('corrupt');

  assert.throws(() => preTrust('/w/cr-1', home), /not valid JSON/);
  // Starting from {} here is what would destroy the operator's MCP servers, account and
  // history to make one spawn succeed. A torn read or a hand-edit is worth a loud crash.
  assert.equal(rawCfg(home), raw, 'a config we could not read must be left alone');
  assert.deepEqual(scratch(home), []);
});

test('refuses a config whose shape it would have to guess at', async (t) => {
  const preTrust = await load('drift');
  // The design's risk register names ~/.claude.json schema drift as this mitigation's risk.
  // Each of these would otherwise merge into nonsense (or silently vanish on stringify).
  for (const [seed, re] of [
    ['[1,2,3]', /array at its root/],
    ['"just a string"', /string at its root/],
    ['{"projects":[]}', /array "projects"/],
    ['{"projects":"yes"}', /string "projects"/],
    ['{"projects":{"/w/cr-1":"trusted"}}', /string entry for \/w\/cr-1/],
    ['{"projects":{"/w/cr-1":[]}}', /array entry for \/w\/cr-1/],
  ]) {
    const home = freshHome(t, seed);
    assert.throws(() => preTrust('/w/cr-1', home), re, `should refuse ${seed}`);
    assert.equal(rawCfg(home), seed, 'refusing means changing nothing');
    assert.deepEqual(scratch(home), []);
  }
});

test('treats a null projects map as absent rather than as drift', async (t) => {
  const home = freshHome(t, { projects: null, foo: 'bar' });
  const preTrust = await load('null-projects');

  preTrust('/w/cr-1', home);

  // null holds no operator data, so replacing it loses nothing — unlike an array or string,
  // which would mean the schema moved and a merge would be a guess.
  assert.deepEqual(readCfg(home), { projects: { '/w/cr-1': { hasTrustDialogAccepted: true } }, foo: 'bar' });
});

test('refuses a cwd that is not an absolute path', async (t) => {
  const home = freshHome(t);
  const preTrust = await load('cwd-guard');

  for (const bad of [undefined, null, '', 'worktrees/cr-1', './cr-1', 42, {}]) {
    assert.throws(() => preTrust(bad, home), TypeError, `should refuse ${JSON.stringify(bad) ?? String(bad)}`);
  }
  // A relative cwd (or an undefined one, keyed as "undefined") writes an entry claude never
  // looks up: preTrust would report success and the lead would still hang on the dialog.
  assert.deepEqual(readdirSync(home), [], 'a refused call must not create a config at all');
});

test('accumulates one entry per worktree across spawns', async (t) => {
  const home = freshHome(t, { projects: { '/other': { hasTrustDialogAccepted: true } } });
  const preTrust = await load('accumulate');

  preTrust('/w/cr-1', home);
  preTrust('/w/cr-2', home);
  preTrust('/w/cr-1', home); // a retried task re-uses its worktree; still idempotent

  const j = readCfg(home);
  assert.deepEqual(Object.keys(j.projects).sort(), ['/other', '/w/cr-1', '/w/cr-2']);
  for (const k of ['/other', '/w/cr-1', '/w/cr-2']) assert.equal(j.projects[k].hasTrustDialogAccepted, true);
  assert.deepEqual(scratch(home), []);
});

test('takes over the lock of a spawn that died holding it', async (t) => {
  const home = freshHome(t, { projects: {} });
  // `soma down` killing a tmux pane mid-spawn is the common way to lose a holder, and a lock
  // nobody will ever release must not turn into every future spawn refusing — the hang again
  // by another route. A pid that has certainly exited is the deterministic version of that.
  const dead = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(dead.status, 0);
  writeFileSync(`${cfgPath(home)}.lock`, `${dead.pid}\n`);
  const preTrust = await load('stale-lock');

  preTrust('/w/cr-1', home);

  assert.equal(readCfg(home).projects['/w/cr-1'].hasTrustDialogAccepted, true);
  assert.deepEqual(scratch(home), [], 'the lock must be released, not inherited');
});

test('marks the config CLAUDE_CONFIG_DIR names, not the one beside $HOME', async (t) => {
  // The bug this pins cost nothing at runtime and everything in production: `CLAUDE_CONFIG_DIR`
  // is set on the machine v1 ships to, so a `$HOME/.claude.json` hard-coding marks a file
  // claude never reads — no throw, no log, and every detached lead on the trust dialog.
  const home = freshHome(t, { projects: { '/other': { hasTrustDialogAccepted: true } } });
  const dir = join(home, 'work-config'); // does not exist yet: claude has never run under it
  const preTrust = await load('config-dir');

  const marked = preTrust('/w/cr-1', home, { CLAUDE_CONFIG_DIR: dir });

  assert.equal(marked, join(dir, '.claude.json'), 'preTrust must report the file it marked');
  assert.equal(readCfg(dir).projects['/w/cr-1'].hasTrustDialogAccepted, true);
  // The config beside $HOME must be left exactly as it was — marking both would be a guess.
  assert.deepEqual(Object.keys(readCfg(home).projects), ['/other']);
  // A root claude has not created yet is created here, as tight as the one claude makes itself.
  if (POSIX) assert.equal(mode(dir), 0o700, 'the config dir holds credentials; 0700 or nothing');
  // And the lock travelled with the config rather than staying behind in $HOME.
  assert.deepEqual(scratch(dir), [], 'the lock must be released inside the config dir');
  assert.deepEqual(scratch(home), []);
});

test('the lock travels with the config into the dir CLAUDE_CONFIG_DIR names', async (t) => {
  // The other half of the same bug: a write that moved to the live config while the lock stayed
  // behind in $HOME guards nothing — two spawners would publish over each other in the file the
  // lock was supposed to serialise. A live holder's lock *in the config dir* is the way to pin
  // it: a module still locking `<home>/.claude.json.lock` sails straight past this one.
  const home = freshHome(t, { projects: {} });
  const dir = join(home, 'work-config');
  mkdirSync(dir);
  const lp = join(dir, '.claude.json.lock');
  const holder = `${process.ppid}\n`;
  writeFileSync(lp, holder);

  const waiter = spawn(process.execPath, ['--input-type=module', '-e', `
    import { preTrust } from ${JSON.stringify(pretrustUrl)};
    preTrust('/w/cr-1', ${JSON.stringify(home)}, { CLAUDE_CONFIG_DIR: ${JSON.stringify(dir)} });
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  const gone = new Promise((r) => waiter.on('exit', r));
  try {
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(readFileSync(lp, 'utf8'), holder, 'the holder of the config dir lock must not be stolen from');
      assert.equal(existsSync(join(dir, '.claude.json')), false, 'nothing may be published while that lock is held');
    }
  } finally {
    waiter.kill('SIGKILL');
    await gone;
  }
});

test('an empty CLAUDE_CONFIG_DIR falls back to $HOME rather than the cwd', async (t) => {
  // `soma up` forwards env vars as `VAR: process.env.VAR || ''`, so "unset" arrives as an empty
  // string. With `??` in place of `||` that empty string survives and every trust mark lands in
  // `./.claude.json`, relative to whichever cwd the spawner happened to have.
  const home = freshHome(t, { projects: {} });
  const preTrust = await load('empty-env');

  const marked = preTrust('/w/cr-1', home, { CLAUDE_CONFIG_DIR: '' });

  assert.equal(marked, cfgPath(home));
  assert.equal(readCfg(home).projects['/w/cr-1'].hasTrustDialogAccepted, true);
});

test('reclaims a lock whose pid has since been recycled onto a live process', async (t) => {
  const home = freshHome(t, { projects: {} });
  const lp = `${cfgPath(home)}.lock`;
  // The wedge this closes: a holder is SIGKILLed, its lock survives in $HOME with nothing on
  // the machine cleaning it up, and its pid is later handed to an unrelated long-lived
  // process. Liveness alone then says "held" forever and every future spawn refuses. Our own
  // parent is the deterministic version of that — certainly alive, certainly not a spawn that
  // is holding this lock, and a real pid on every platform (unlike a hardcoded 1).
  writeFileSync(lp, `${process.ppid}\n`);
  const old = Date.now() / 1000 - 300;
  utimesSync(lp, old, old); // five minutes past the age-out
  const preTrust = await load('recycled-pid');

  preTrust('/w/cr-1', home);

  assert.equal(readCfg(home).projects['/w/cr-1'].hasTrustDialogAccepted, true);
  assert.deepEqual(scratch(home), [], 'the reclaimed lock must be released, not inherited');
});

test('waits out a fresh lock held by a live process instead of stealing it', async (t) => {
  const home = freshHome(t, { projects: {} });
  const lp = `${cfgPath(home)}.lock`;
  // The other half of the age-out: it must reclaim an abandoned lock without ever becoming a
  // licence to steal a working one. A lock naming a live pid, young enough to be a real
  // holder, is the one case where waiting is the only safe answer — taking it would put two
  // read-modify-writes in flight, which is the lost update the lock exists to prevent.
  const holder = `${process.ppid}\n`;
  writeFileSync(lp, holder);
  const waiter = spawn(process.execPath, ['--input-type=module', '-e', `
    import { preTrust } from ${JSON.stringify(pretrustUrl)};
    preTrust('/w/cr-1', ${JSON.stringify(home)});
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Reaped inside the test, not in an `after` hook: the hooks run in registration order, so
  // `freshHome`'s `rmSync` would go first and race a waiter still writing its scratch file in
  // that directory — an ENOTEMPTY flake with nothing to do with what is being tested.
  const gone = new Promise((r) => waiter.on('exit', r));
  try {
    // While the waiter hammers the lock, the holder's file must stay exactly as it is...
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(readFileSync(lp, 'utf8'), holder, 'a live holder must never have its lock stolen');
    }
    // ...and the waiter must not have got into the critical section by another route either.
    assert.equal(readCfg(home).projects['/w/cr-1'], undefined, 'the config must be untouched while the lock is held');
  } finally {
    waiter.kill('SIGKILL');
    await gone;
  }
});

test('concurrent preTrusts on one config all keep their entry', async (t) => {
  const RACERS = 5;
  // Big enough that the read-modify-write window is real rather than theoretical: with a
  // ~400 KB config, five processes released at the same millisecond all read the same base,
  // so four of them have their rename overwritten and must notice and redo it. Sequential
  // accumulation (the test above) cannot see any of that.
  const seed = {
    numStartups: 3,
    mcpServers: { kite: { command: 'kite-mcp' } },
    oauthAccount: { emailAddress: 'op@example.com' },
    projects: { '/other': { hasTrustDialogAccepted: true } },
  };
  for (let i = 0; i < 2000; i++) seed.projects[`/p/${i}`] = { hasTrustDialogAccepted: true, history: [{ display: `t${i}` }] };
  const home = freshHome(t, seed);

  const cwds = Array.from({ length: RACERS }, (_, i) => `/w/cr-${i + 1}`);
  const startAt = Date.now() + 500; // barrier: node startup is ~50 ms, so all five are waiting on it
  const results = await Promise.all(cwds.map((cwd) => racer(home, cwd, startAt)));

  // Exit 0 is half the assertion: preTrust must never report success without the entry, so a
  // racer that gave up has to fail loudly rather than leave a lead to hang on the dialog.
  for (const r of results) assert.equal(r.code, 0, `${r.cwd} exited ${r.code}: ${r.err}`);
  const j = readCfg(home);
  for (const cwd of cwds) assert.equal(j.projects[cwd]?.hasTrustDialogAccepted, true, `${cwd} lost its trust entry`);
  // And nothing else may be collateral: not a sibling project, not the top-level keys.
  assert.equal(j.projects['/other'].hasTrustDialogAccepted, true);
  assert.equal(Object.keys(j.projects).length, 2000 + 1 + RACERS, 'a lost update would show up as a missing key');
  assert.equal(j.numStartups, 3);
  assert.deepEqual(j.mcpServers, seed.mcpServers);
  assert.deepEqual(j.oauthAccount, seed.oauthAccount);
  assert.deepEqual(scratch(home), []);
});

test('a config volume without hard links says so, and names the RIGHT volume', async (t) => {
  // `link(2)` IS this lock, so a config dir on a volume without hard links cannot be locked at
  // all — and it used to escape as libuv's `ENOTSUP: operation not supported on socket,
  // link '…'`, about a file. Reproduced on a real FAT32 volume, on which the `wx` create this
  // idiom replaced worked fine. This module had NO diagnosis at all before the shared lock was
  // extracted; the other two did, and theirs says "move SOMA_HOME off this volume" — which is
  // the wrong instruction here, because this lock is the one that does NOT live under the state
  // root. It sits beside claude's own config, so the volume to name is the config dir's and the
  // knob to name is CLAUDE_CONFIG_DIR.
  const home = freshHome(t, { projects: {} });
  const dir = join(home, 'work-config');
  mkdirSync(dir);

  const at = async (code) => {
    const src = `
      import { createRequire } from 'node:module';
      const fs = createRequire(import.meta.url)('fs');
      fs.linkSync = () => { throw Object.assign(new Error(${JSON.stringify('stubbed link failure')}), { code: ${JSON.stringify(code)} }); };
      const { preTrust } = await import(${JSON.stringify(pretrustUrl)});
      try {
        preTrust('/w/cr-1', ${JSON.stringify(home)}, { CLAUDE_CONFIG_DIR: ${JSON.stringify(dir)} });
        process.stdout.write(JSON.stringify({ marked: true }));
      } catch (e) { process.stdout.write(JSON.stringify({ message: e.message, causeCode: e.cause?.code ?? null })); }
    `;
    return await new Promise((resolve) => {
      const cp = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      cp.stdout.on('data', (d) => { out += d; });
      cp.stderr.on('data', (d) => { err += d; });
      cp.on('exit', () => { try { resolve(JSON.parse(out)); } catch { resolve({ message: err.trim() }); } });
    });
  };

  // All three, because some filesystems report an unsupported link as EPERM rather than ENOTSUP.
  // An assertion per part, so a message that keeps one and drops the rest cannot pass.
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM']) {
    const r = await at(code);
    assert.equal(r.marked, undefined, `${code} must not be reported as a successful trust mark`);
    assert.match(r.message ?? '', /must be on a filesystem that supports hard links/, `${code} must name the cause: ${r.message}`);
    assert.match(r.message ?? '', new RegExp(`link\\(2\\) returned ${code}`), `${code} must be named: ${r.message}`);
    assert.ok((r.message ?? '').includes(dir), `${code} must name the config dir, which is where this lock lives: ${r.message}`);
    assert.match(r.message ?? '', /CLAUDE_CONFIG_DIR/, `${code} must name the knob that moves it: ${r.message}`);
    assert.doesNotMatch(r.message ?? '', /SOMA_HOME/, `${code} must NOT send an operator to move the state root: ${r.message}`);
    assert.equal(r.causeCode, code, 'and keep the original error as its cause');
  }
  // And nothing left behind: no lock, no scratch, and the config never created.
  assert.deepEqual(scratch(dir), [], 'a refused acquire leaves no scratch file and no lock');
  assert.equal(existsSync(join(dir, '.claude.json')), false, 'and publishes nothing');

  // And not one errno more: a cross-device link is a different fault with a different fix, and
  // burying it under "this volume has no hard links" sends someone reformatting a disk.
  const unrelated = await at('EXDEV');
  assert.match(unrelated.message ?? '', /stubbed link failure/, `an unrelated link failure must surface as itself: ${unrelated.message}`);
  assert.doesNotMatch(unrelated.message ?? '', /supports hard links/);
});

test('every link attempt in one contended acquire uses a name of its own', async (t) => {
  // This module minted ONE scratch name per process — `<lock>.<pid>.tmp` — and reused it across
  // the whole retry loop. A name that outlives one attempt is a name a second acquirer can find
  // on disk and link, after which the landed-link proof reads a second name on it as proof we
  // hold a lock we do not; and on a shared config dir over a network filesystem, host B's pid
  // 500 derives host A's pid 500's name exactly. Measured against the pre-extraction module:
  // 49 attempts, 1 distinct name. So the claim is per *attempt*, checked across the retry loop.
  const home = freshHome(t, { projects: {} });
  const lp = `${cfgPath(home)}.lock`;
  writeFileSync(lp, `${process.pid}\n`);       // we are alive, so the child has to keep trying

  const r = await new Promise((resolve) => {
    const cp = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      const fs = createRequire(import.meta.url)('fs');
      const real = fs.linkSync;
      const seen = [];
      fs.linkSync = (from, to) => { seen.push(String(from)); return real(from, to); };
      const { preTrust } = await import(${JSON.stringify(pretrustUrl)});
      try { preTrust('/w/cr-1', ${JSON.stringify(home)}); } catch {}
      process.stdout.write(JSON.stringify({ attempts: seen.length, distinct: new Set(seen).size }));
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('exit', () => { try { resolve(JSON.parse(out)); } catch { resolve({ attempts: 0, distinct: 0, err: err.trim() }); } });
  });

  assert.ok(r.attempts > 5, `the child never really contended (${r.attempts} attempts), so this proves nothing: ${r.err ?? ''}`);
  assert.equal(r.distinct, r.attempts, `${r.attempts} link attempts shared ${r.distinct} scratch name(s)`);
  assert.equal(readFileSync(lp, 'utf8'), `${process.pid}\n`, 'and the live holder kept its lock');
  rmSync(lp);
  // Every attempt drops its own scratch on the way out, so a name per attempt is not litter
  // per attempt — which matters more here than anywhere: this directory is not soma's.
  assert.deepEqual(scratch(home), []);
});
