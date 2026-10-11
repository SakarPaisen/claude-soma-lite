import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

test('SOMA_HOME honors env override and p() joins under it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { SOMA_HOME, p, ensureTree, leadDir } = await import('../bin/lib/paths.mjs?' + Date.now());
  assert.equal(SOMA_HOME(), home);
  assert.equal(p('events', 'x.ndjson'), join(home, 'events', 'x.ndjson'));
  ensureTree();
  const { existsSync } = await import('node:fs');
  for (const d of ['state', 'events', 'heartbeats', 'leads', 'logs', 'worktrees', 'digests']) {
    assert.ok(existsSync(join(home, d)), `missing ${d}`);
  }
  assert.equal(leadDir('cr-1'), join(home, 'leads', 'cr-1'));
});

test('worktreeDir() and logPath() land under SOMA_HOME', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { worktreeDir, logPath } = await import('../bin/lib/paths.mjs?helpers-' + Date.now());
  assert.equal(worktreeDir('app-a', 'task-1'), join(home, 'worktrees', 'app-a', 'task-1'));
  assert.equal(logPath('cr-1'), join(home, 'logs', 'cr-1.log'));
});

test('ensureTree() creates exactly the fixed subdir set and is safe to re-run', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { ensureTree } = await import('../bin/lib/paths.mjs?tree-' + Date.now());
  ensureTree();
  ensureTree(); // `soma up` and `soma init` call it on every invocation — must not throw
  const created = readdirSync(home).filter((name) => !name.startsWith('.')).sort();
  assert.deepEqual(created, ['digests', 'events', 'heartbeats', 'leads', 'logs', 'state', 'worktrees']);
});

test('SOMA_HOME() falls back to $HOME/.soma when the env var is unset or empty', async (t) => {
  const saved = process.env.SOMA_HOME;
  t.after(() => {
    if (saved === undefined) delete process.env.SOMA_HOME;
    else process.env.SOMA_HOME = saved;
  });
  const { SOMA_HOME, p } = await import('../bin/lib/paths.mjs?fallback-' + Date.now());
  const fallback = join(homedir(), '.soma');

  delete process.env.SOMA_HOME;
  assert.equal(SOMA_HOME(), fallback);

  process.env.SOMA_HOME = ''; // `soma up` passes SOMA_HOME: '' through to the watchdog
  assert.equal(SOMA_HOME(), fallback);
  assert.equal(p('state', 'fleet.json'), join(fallback, 'state', 'fleet.json'));
  // Deliberately no fs calls here: a unit test must never create the operator's real ~/.soma.
});

/**
 * This replaces a test that asserted the opposite — that a relative `$SOMA_HOME`
 * *resolves* (`SOMA_HOME() === resolve(cwd, 'relative-soma-root')`). That pin was wrong.
 * It pinned an answer that is absolute and cwd-dependent, which is to say a different
 * answer in every process, which is to say a forked state root: heartbeats no watchdog
 * reads, a BUDGET_TRIPPED flag no gate finds, a fleet.lock that excludes nobody and two
 * holders of a single-holder lease. Resolving hid all of that behind a well-formed path.
 * The property worth keeping from it — that deciding where a path *would* go must never
 * bring it into existence — is pinned harder below, against the whole cwd.
 */
test('a relative SOMA_HOME is refused at every helper, not resolved against the cwd', async (t) => {
  const saved = process.env.SOMA_HOME;
  const cwd = process.cwd();
  // Run from an empty scratch cwd: if any of this ever resolves instead of refusing, the
  // droppings land here and the emptiness assertion below catches them — rather than in
  // whatever directory the suite happened to start in, which is how `rel/ative/` got
  // committed-adjacent to a shared worktree in the first place.
  const scratch = mkdtempSync(join(tmpdir(), 'soma-relative-'));
  process.chdir(scratch);
  t.after(() => {
    process.chdir(cwd);
    rmSync(scratch, { recursive: true, force: true });
    if (saved === undefined) delete process.env.SOMA_HOME;
    else process.env.SOMA_HOME = saved;
  });
  const paths = await import('../bin/lib/paths.mjs?relative-' + Date.now());
  const { SOMA_HOME, p, ensureTree, leadDir, worktreeDir, logPath } = paths;

  // Everything a real operator or a test might plausibly export. `~/soma` and `~` are in
  // here deliberately: a leading tilde is expanded by the shell only when *unquoted*, so
  // `SOMA_HOME="~/soma"` reaches the process as three literal characters and a slash —
  // not absolute, never expanded by `resolve()`, and previously resolved into a directory
  // literally named `~` under the cwd. `rel/ative/` is the value that produced the
  // measured nine-way split.
  const relatives = ['relative-soma-root', '.', './x', '../x', 'x/y', 'rel/ative/', '~/soma', '~', 'x/'];
  const builders = [
    ['SOMA_HOME()', () => SOMA_HOME()],
    ['p()', () => p('state', 'fleet.json')],
    ['leadDir()', () => leadDir('cr-1')],
    ['worktreeDir()', () => worktreeDir('app-a', 'task-1')],
    ['logPath()', () => logPath('cr-1')],
    ['ensureTree()', () => ensureTree()],
  ];
  for (const raw of relatives) {
    process.env.SOMA_HOME = raw;
    for (const [label, build] of builders) {
      assert.throws(build, /SOMA_HOME must be an absolute path/, `${label} accepted ${JSON.stringify(raw)}`);
    }
    // The message is the operator's only teacher when this fires deep in a tick, so two
    // things about it are contract, not prose: it echoes the offending value back so they
    // can recognise their own typo, and it names the empty/unset fallback so the fix is
    // not a guess.
    assert.throws(() => SOMA_HOME(), ({ message }) => {
      assert.ok(message.includes(JSON.stringify(raw)), `message hides the offending value: ${message}`);
      assert.ok(message.includes(join(homedir(), '.soma')), `message hides the default root: ${message}`);
      return true;
    });
  }

  // The old test's property, still true and now pinned against the whole directory rather
  // than one path: refusing to build a path must not create anything, and neither must
  // building one. Nine spellings, six helpers, `ensureTree()` among them — and the cwd a
  // relative root would have resolved against is still empty.
  assert.deepEqual(readdirSync(scratch), [], 'a refused root created something on disk');
});

test('an absolute SOMA_HOME is untouched, normalised, and the same from any cwd', async (t) => {
  const saved = process.env.SOMA_HOME;
  const cwd = process.cwd();
  const a = mkdtempSync(join(tmpdir(), 'soma-cwd-a-'));
  const b = mkdtempSync(join(tmpdir(), 'soma-cwd-b-'));
  t.after(() => {
    process.chdir(cwd);
    for (const d of [a, b]) rmSync(d, { recursive: true, force: true });
    if (saved === undefined) delete process.env.SOMA_HOME;
    else process.env.SOMA_HOME = saved;
  });
  const { SOMA_HOME, p } = await import('../bin/lib/paths.mjs?abs-' + Date.now());

  // An absolute root is passed through unchanged — the guard costs the shipped path
  // nothing.
  const root = join(tmpdir(), 'soma-abs-root');
  process.env.SOMA_HOME = root;
  assert.equal(SOMA_HOME(), root);
  assert.ok(isAbsolute(p('state', 'fleet.json')));

  // The invariant the nine-way split violated, pinned directly: same env, two different
  // working directories, one answer. This is what `resolve()` could never give.
  process.chdir(a);
  const fromA = [SOMA_HOME(), p('state', 'fleet.json'), p('heartbeats', 'cr-1')];
  process.chdir(b);
  const fromB = [SOMA_HOME(), p('state', 'fleet.json'), p('heartbeats', 'cr-1')];
  assert.deepEqual(fromB, fromA, 'the state root moved with the cwd');
  process.chdir(cwd);

  // `resolve()`'s remaining job. Two spellings of one directory must not become two
  // roots — a trailing slash from a shell completion is the common way that happens.
  for (const spelling of [`${root}/`, `${root}//`, `${root}/./`, `${root}/x/..`]) {
    process.env.SOMA_HOME = spelling;
    assert.equal(SOMA_HOME(), root, `${spelling} is not the same root as ${root}`);
  }

  // WSL2 is the only Windows this runs on, so POSIX absoluteness is the whole rule: a
  // bare drive-letter path is relative here and is refused like any other fragment.
  process.env.SOMA_HOME = 'C:\\soma';
  assert.throws(() => SOMA_HOME(), /SOMA_HOME must be an absolute path/);
});

test('claudeConfigRoot() honors $CLAUDE_CONFIG_DIR and falls back to $HOME/.claude', async () => {
  const { claudeConfigRoot } = await import('../bin/lib/paths.mjs?cfgroot-' + Date.now());
  const fallback = join(homedir(), '.claude');

  // Set — the case that is live on the operator's machine.
  assert.equal(claudeConfigRoot({ CLAUDE_CONFIG_DIR: '/Users/x/.claude-work' }), '/Users/x/.claude-work');
  // Unset.
  assert.equal(claudeConfigRoot({}), fallback);
  // Empty string — `||`, not `??`, exactly as SOMA_HOME() does it: an env var passed
  // through as '' must fall back to the default root, not resolve against the cwd.
  assert.equal(claudeConfigRoot({ CLAUDE_CONFIG_DIR: '' }), fallback);
  // Relative — resolved, not refused. Same reason as SOMA_HOME(): the watchdog's cwd
  // is not the lead's, and this function must never throw on a watchdog tick.
  assert.equal(claudeConfigRoot({ CLAUDE_CONFIG_DIR: 'rel-cfg' }), resolve(process.cwd(), 'rel-cfg'));
  assert.ok(isAbsolute(claudeConfigRoot({ CLAUDE_CONFIG_DIR: 'rel-cfg' })));
  // Also no fs calls anywhere above: a unit test must never create the operator's ~/.claude.
});

test('claudeConfigRoot() reads process.env when no env is injected', async (t) => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });
  const { claudeConfigRoot } = await import('../bin/lib/paths.mjs?cfgroot-env-' + Date.now());

  process.env.CLAUDE_CONFIG_DIR = '/tmp/soma-cfg-probe';
  assert.equal(claudeConfigRoot(), '/tmp/soma-cfg-probe');

  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(claudeConfigRoot(), join(homedir(), '.claude'));

  process.env.CLAUDE_CONFIG_DIR = '';
  assert.equal(claudeConfigRoot(), join(homedir(), '.claude'));
});
