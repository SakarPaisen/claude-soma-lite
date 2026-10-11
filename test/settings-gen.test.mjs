import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Every test in this file runs with `CLAUDE_CONFIG_DIR` unset, so the default-root
 * assertions are deterministic on a machine where the operator has it set — this one
 * does, pointing at `~/.claude-work`, and without this the union below would drag the
 * operator's real servers into the original tests' verbatim expectations. The tests that care
 * about the variable set it themselves through `withConfigDir` and restore it.
 *
 * This is now belt, not the mechanism: `enumerateUserMcpServers` takes `env` as a
 * parameter, so a test can hand it one instead of arranging the process's. The
 * "home and env are parameters" test below pins exactly that, and would fail if the
 * module went back to reading the global — which is what this line used to hide.
 */
delete process.env.CLAUDE_CONFIG_DIR;

/**
 * Claude Code's `Bash(...)` rule matching, re-derived from measurement so the whole
 * push matrix can be asserted without spawning a session per vector.
 *
 * Measured live against claude 2.1.220. Fix round 3 established the character
 * semantics: inside `Bash(...)`, `*` is "any run of characters" and everything else is
 * literal; brace alternation is NOT expanded and the command is NOT shell-unquoted.
 * Fix round 4 established that the unit of matching is **not** the whole command
 * string — round 3's docstring said it was, and that was measurably false:
 *
 *   SEGMENTS on `;` `&&` `||` `|` `&`, and matches each segment independently. With
 *   one deny rule `Bash(echo probe-alpha)` and no wildcard anywhere, all of
 *   `echo ok && echo probe-alpha`, `echo probe-alpha && echo ok`,
 *   `echo ok || echo probe-alpha`, `echo probe-alpha;`, `echo probe-alpha | cat` and
 *   `echo probe-alpha & wait` were DENIED. A whole-string matcher cannot deny any of
 *   them. Corroborated by the refusal text itself: for `echo probe-alpha | cat`
 *   Claude Code reported *"Permission to use Bash with command echo probe-alpha has
 *   been denied"* — naming the segment, not what was typed.
 *
 *   The RULE body segments too. `Bash(echo one && echo two)` denied
 *   `echo one && echo two`, which segment-vs-whole-command matching alone cannot do.
 *
 *   A wildcard does NOT span a segment boundary, which is what rules this out being
 *   plain whole-string matching with extra steps: `Bash(echo a*echo z)` let
 *   `echo a && echo z` RUN. Under whole-string semantics the `*` absorbs ` && ` and
 *   it would have been denied.
 *
 *   Whitespace collapsing is REAL but **CONDITIONAL ON THE RULE CONTAINING A
 *   WILDCARD**, which is the one thing neither of the two reports about it had. Both
 *   unconditional claims are wrong, and the discriminator is measured with the rule as
 *   the only variable and the command confirmed sent byte-for-byte:
 *
 *     rule                        command                        verdict
 *     Bash(echo alpha beta)       echo alpha  beta               RAN      (no wildcard)
 *     Bash(git status --short)    git status  --short            RAN      (no wildcard)
 *     Bash(echo zulu*alpha beta)  echo zulu mid alpha  beta      DENIED   (wildcard)
 *     Bash(echo alpha beta*)      echo alpha  beta gamma         DENIED   (wildcard)
 *     Bash(git push*origin main)  git push origin  main          DENIED   (wildcard)
 *
 *   So a rule with no `*` is compared to the raw segment and a doubled space defeats
 *   it; a rule with a `*` anywhere matches whitespace-insensitively. **Every
 *   `Bash(...)` rule this module ships contains a `*`, so the shipped guard file is
 *   whitespace-insensitive in practice** — `git push origin  main` is denied, which is
 *   the direction that helps and closes a bypass that would otherwise be one keystroke.
 *
 * Every verdict above is classified from the Bash `tool_result` string, never from
 * "the remote gained nothing": round 3's first pass produced 12 false DENIEDs from the
 * model's own safety reflex refusing legal commands, and a refusal leaves no ref
 * behind either. Whitespace vectors additionally require a third state,
 * **`RAN(cmd-not-verbatim)`** — a tool_use whose `input.command` is not the string you
 * meant, because the model tidied it. My first pass at the two-space vector hit exactly
 * that and drew the wrong conclusion from it; the probe now pins the model with an
 * `--append-system-prompt` forbidding normalisation AND asserts the issued command
 * equals the intended one before believing any verdict.
 *
 * Why the segmentation matters beyond fidelity: it is one-directional (reality denies
 * MORE than a whole-string model predicts), so it made the 21 deny-side assertions
 * safe and the 10 allow-side ones unsound — the same direction as this module's original
 * bug, where ordinary task branches dead-ended. And a segmenting model is what lets
 * this file reason about what teammates actually run:
 * `git add -A && git commit -m x && git push origin soma/task-x`.
 */
/*
 * TWO CORRECTIONS, both measured after round 4 and both carried into
 * `bin/lib/doctor.mjs`'s copy so the two cannot disagree:
 *
 *   1. A NEWLINE SEGMENTS TOO, and it was missing from the recorded set. Measured DENIED
 *      twice, once against a shipped rule — so a checker built from `;` `&&` `||` `|` `&`
 *      alone lets a protected push on LINE 2 of a heredoc-style command through. It is in
 *      the character class below.
 *   2. "ANY rule segment matches ANY command segment" OVER-PREDICTS DENY. `.every` is the
 *      correct quantifier over the rule's segments: `Bash(echo one && echo two)` was
 *      measured denying `echo one && echo two`, which needs BOTH its segments matched, and
 *      nothing was ever measured saying it also denies `echo one` alone. Inert today — no
 *      shipped rule body contains a separator, re-verified below — but the direction
 *      matters: over-predicting DENY makes a safety checker report a rule that is not
 *      there, which is a false OK.
 */
const SEGMENT_RE = /&&|\|\||[;|&\n]/;
const segments = (s) => s.split(SEGMENT_RE).map((seg) => seg.trim()).filter(Boolean);
const squeeze = (s) => s.replace(/\s+/g, ' ');

const segmentMatches = (ruleSeg, cmdSeg) => {
  // No wildcard: raw comparison, so a doubled space defeats the rule (measured).
  if (!ruleSeg.includes('*')) return ruleSeg === cmdSeg;
  // Wildcard anywhere: whitespace-insensitive (measured, three independent vectors).
  const rx = squeeze(ruleSeg).split('*').map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${rx}$`, 's').test(squeeze(cmdSeg));
};

const bashRuleMatches = (rule, cmd) => {
  const body = /^Bash\((.*)\)$/s.exec(rule)?.[1];
  if (body === undefined) return false;
  const ruleSegs = segments(body);
  const cmdSegs = segments(cmd);
  // `every`, not `some` — the second correction above. The length guard is what keeps a rule body
  // that is empty or all separators from vacuously denying every command on earth.
  return ruleSegs.length > 0 && ruleSegs.every((r) => cmdSegs.some((c) => segmentMatches(r, c)));
};

/** Would this guard file refuse `cmd`? */
const denied = (deny, cmd) => deny.some((rule) => bashRuleMatches(rule, cmd));

/** Point CLAUDE_CONFIG_DIR at `dir` for one test. */
const withConfigDir = (t, dir) => {
  t.after(() => { delete process.env.CLAUDE_CONFIG_DIR; });
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
};

/** A throwaway state root, cleaned up when the test ends. */
const somaHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  return home;
};

/** A fresh import of the module under test (paths read SOMA_HOME lazily, but be explicit). */
const load = (tag) => import(`../bin/lib/settings-gen.mjs?${tag}-${Date.now()}`);

/**
 * Point `os.homedir()` at a throwaway home seeded with `claudeJson`.
 *
 * `homedir()` returns `$HOME` on POSIX, which is what makes the *default* argument
 * of `enumerateUserMcpServers` — and so every default-path assertion below —
 * testable at all instead of depending on the operator's own machine.
 */
const fakeHome = (t, claudeJson) => {
  const saved = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  t.after(() => { process.env.HOME = saved; rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  if (claudeJson) writeFileSync(join(home, '.claude.json'), JSON.stringify(claudeJson));
  return home;
};

/** A worktree dir that exists (writeWorktreeGuardrails refuses to conjure one). */
const worktree = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Any non-empty personal list — for tests that assert on the fixed rules only. */
const SOME = { mcpDenies: ['kite'], teammateAllow: [] };

test('enumerateUserMcpServers reads ~/.claude.json mcpServers', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { kite: {}, notion: {} } }));
  const s = await import('../bin/lib/settings-gen.mjs?' + Date.now());
  assert.deepEqual(s.enumerateUserMcpServers(home).sort(), ['kite', 'notion']);
});

/**
 * `soma` is never in this list, and leaving it in broke the entire fleet.
 *
 * MEASURED on the first real fleet: every lead reported
 * `No such tool available: mcp__soma__soma_task`, so no lead could report, checkpoint or
 * re-orient. The bus was healthy — a direct `tools/list` under a lead's exact env returned all
 * three lead tools. The cause was this function. `soma init` registers the bus at user scope so
 * any session can be promoted; this list enumerates everything at user scope; so it emitted
 * `mcp__soma` and **soma denied its own bus**. The worktree guard file is loaded by the LEAD,
 * not only by its teammates.
 *
 * Neither half was wrong on its own, which is why no test caught it: `init` must register at
 * user scope or nothing can be promoted, and this list must read user scope or it misses the
 * servers it exists to deny. The defect lived in the join.
 *
 * The teammate exposure is still real and still handled — a teammate mounts the user-scope bus
 * as a CANDIDATE and gets `soma_adopt`, so it could take the orchestrator lease. It is denied in
 * `bin/hooks/lead-gate.mjs` arm (b2), which can tell a lead from a teammate by session id.
 * A static deny cannot: they share one cwd, therefore one settings file.
 */
test('enumerateUserMcpServers never returns soma — the bus must not be denied to its own lead', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { soma: {}, kite: {} },
    projects: { '/repo': { mcpServers: { soma: {}, mysql_write: {} } } },
  }));
  const s = await import('../bin/lib/settings-gen.mjs?' + Date.now());
  const got = s.enumerateUserMcpServers(home).sort();
  assert.deepEqual(got, ['kite', 'mysql_write'],
    'soma is excluded from BOTH scopes; everything else is still denied');
  assert.ok(!got.includes('soma'),
    'a generated `mcp__soma` deny rule takes soma_task/soma_report/soma_checkpoint off the lead');
});

test('enumerateUserMcpServers also finds LOCAL-scope servers under projects[*].mcpServers', async (t) => {
  // Measured on the operator's own machine: `~/.claude.json` top-level `mcpServers`
  // holds two innocuous servers, while `kite` (brokerage orders) and
  // `mcp_server_mysql` (database writes) — the two the design review named as the
  // reason this deny list exists — live under `projects[<dir>].mcpServers`. A
  // top-level-only read writes a deny list that misses exactly the servers it was
  // written for, so local scope is not an extra: it is the point.
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'figma-console': {}, posthog: {} },
    projects: {
      '/Users/op/work/a': { hasTrustDialogAccepted: true, mcpServers: { kite: {}, mcp_server_mysql: {} } },
      '/Users/op/work/b': { hasTrustDialogAccepted: true, mcpServers: { notion: {} } },
      '/Users/op/work/c': { hasTrustDialogAccepted: true },                       // no local servers at all
    },
  }));
  const s = await load('local');
  assert.deepEqual(s.enumerateUserMcpServers(home).sort(),
    ['figma-console', 'kite', 'mcp_server_mysql', 'notion', 'posthog']);
});

test('CLAUDE_CONFIG_DIR: the resolved root is read, and unioned with the default one', async (t) => {
  // Measured on this machine: CLAUDE_CONFIG_DIR=~/.claude-work is set, so the live
  // file is ~/.claude-work/.claude.json while ~/.claude.json still exists and still
  // parses. Reading only the latter builds a plausible deny list out of a file
  // Claude Code is not using. Note the two file *shapes*: the default sits BESIDE
  // the config dir ($HOME/.claude.json), the override sits INSIDE it.
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const work = mkdtempSync(join(tmpdir(), 'cfgroot-'));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { stale_only: {} } }));
  writeFileSync(join(work, '.claude.json'), JSON.stringify({
    mcpServers: { live_user: {} }, projects: { '/p': { mcpServers: { live_local: {} } } },
  }));
  const s = await load('cfgdir');

  // Without the variable, the override root is invisible — the defect, reproduced.
  assert.deepEqual(s.enumerateUserMcpServers(home).sort(), ['stale_only']);

  // With it, everything both roots know about is denied. Union, not replacement:
  // which root a teammate reads depends on the spawner's env allowlist,
  // and a deny for a server that is not currently configured costs nothing.
  withConfigDir(t, work);
  assert.deepEqual(s.enumerateUserMcpServers(home).sort(), ['live_local', 'live_user', 'stale_only']);

  // An empty value must fall back to the default root, not resolve against '' —
  // the `||` in claudeConfigRoot, matching paths.SOMA_HOME's reasoning.
  process.env.CLAUDE_CONFIG_DIR = '';
  assert.deepEqual(s.enumerateUserMcpServers(home).sort(), ['stale_only']);
});

test('CLAUDE_CONFIG_DIR: a malformed file in EITHER root still fails closed, and names it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const work = mkdtempSync(join(tmpdir(), 'cfgroot-'));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: {} } }));
  writeFileSync(join(work, '.claude.json'), '{"mcpServers": {');
  withConfigDir(t, work);
  const s = await load('cfgbroken');
  // The union must not turn one readable root into a licence to ignore a broken one:
  // that is the fail-open answer, and the error has to name the resolved path so the
  // operator (and doctor) know which root to fix.
  assert.throws(() => s.enumerateUserMcpServers(home), (e) => e instanceof SyntaxError && e.message.includes(join(work, '.claude.json')));

  // ...and symmetrically, with the override root fine and the default one broken.
  writeFileSync(join(work, '.claude.json'), JSON.stringify({ mcpServers: { b: {} } }));
  writeFileSync(join(home, '.claude.json'), '[]');
  assert.throws(() => s.enumerateUserMcpServers(home), (e) => e.message.includes(join(home, '.claude.json')) && /must contain a JSON object/.test(e.message));
});

test('enumerateUserMcpServers finds enabled PLUGIN servers under their mangled names', async (t) => {
  // A plugin's servers surface as `plugin:<plugin>:<server>`, i.e.
  // `mcp__plugin_vercel_vercel__*` in a tool name (measured against the real
  // vercel plugin). Neither file alone is enough: settings.json says which plugins
  // are on, installed_plugins.json says where they live — and the install path is
  // NOT derivable, since one plugin on this machine sits under ~/.claude-work/.
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const elsewhere = mkdtempSync(join(tmpdir(), 'plugcache-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { 'vercel@claude-plugins-official': true, 'warp@claude-code-warp': true, 'off@m': false },
  }));
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'vercel@claude-plugins-official': [{ scope: 'user', installPath: elsewhere }],
      'warp@claude-code-warp': [{ scope: 'user', installPath: join(home, 'nonexistent') }],
      'off@m': [{ scope: 'user', installPath: elsewhere }],
    },
  }));
  writeFileSync(join(elsewhere, '.mcp.json'), JSON.stringify({ mcpServers: { vercel: { type: 'http' } } }));
  const s = await load('plugins');
  const names = s.enumerateUserMcpServers(home);
  assert.ok(names.includes('plugin_vercel_vercel'), `expected the mangled plugin name, got ${names}`);
  assert.ok(!names.some((n) => n.startsWith('plugin_off')), 'a disabled plugin must not be enumerated');
  assert.ok(!names.some((n) => n.startsWith('plugin_warp')), 'a plugin with no .mcp.json declares no servers');

  // Plugins move with CLAUDE_CONFIG_DIR too — settings.json and plugins/ live inside
  // the config dir, so an override root has its own, independently enabled set. Both
  // roots are read (this machine's two roots hold *different* settings.json bytes).
  const work = mkdtempSync(join(tmpdir(), 'cfgroot-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, 'plugins'), { recursive: true });
  writeFileSync(join(work, 'settings.json'), JSON.stringify({ enabledPlugins: { 'other@m': true } }));
  writeFileSync(join(work, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'other@m': [{ scope: 'user', installPath: elsewhere }] },
  }));
  withConfigDir(t, work);
  const both = s.enumerateUserMcpServers(home);
  assert.ok(both.includes('plugin_other_vercel'), `override root's plugins missed: ${both}`);
  assert.ok(both.includes('plugin_vercel_vercel'), `default root's plugins dropped: ${both}`);

  // Best-effort: a plugin file that is missing or junk must not fail a spawn — the
  // `mcp__plugin_*` prefix deny is the fence, this enumeration is only the belt.
  delete process.env.CLAUDE_CONFIG_DIR;
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'not json');
  assert.deepEqual(s.enumerateUserMcpServers(home), []);
});

test('enumerateUserMcpServers dedupes across scopes, tolerates a missing file, refuses a broken one', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // No ~/.claude.json at all: a machine that has never run Claude Code has no
  // personal servers to deny, which is genuinely an empty list, not a failure.
  const s = await load('shapes');
  assert.deepEqual(s.enumerateUserMcpServers(home), []);

  // The same server registered in both scopes is one name, not two denies.
  const fp = join(home, '.claude.json');
  writeFileSync(fp, JSON.stringify({
    mcpServers: { kite: {} },
    projects: { '/x': { mcpServers: { kite: {}, notion: {} } }, '/y': null, '/z': { mcpServers: null } },
  }));
  assert.deepEqual(s.enumerateUserMcpServers(home).sort(), ['kite', 'notion']);

  // A malformed file must NOT read as "no personal MCP servers": that fails open
  // into precisely the hole this module exists to close. Fail closed, and name
  // the file (config.readOverlay sets the house precedent).
  writeFileSync(fp, '{"mcpServers": {');
  assert.throws(() => s.enumerateUserMcpServers(home), (e) => e instanceof SyntaxError && e.message.includes('.claude.json'));
  writeFileSync(fp, '[]');
  assert.throws(() => s.enumerateUserMcpServers(home), /must contain a JSON object/);
});

/** A throwaway directory, removed when the test ends. */
const tmp = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * A seat: a config dir with its `.claude.json` INSIDE it — the `CLAUDE_CONFIG_DIR` shape,
 * which is what `claude auth login` under `CLAUDE_CONFIG_DIR=<dir>` produces. `null` = a seat
 * listed in soma.json before anyone has logged in to it.
 */
const seat = (t, claudeJson) => {
  const dir = tmp(t, 'seat-');
  if (claudeJson !== null) writeFileSync(join(dir, '.claude.json'), typeof claudeJson === 'string' ? claudeJson : JSON.stringify(claudeJson));
  return dir;
};

// --- roots: the secrets boundary across every seat (account rotation, spec §3.4) --------
//
// A fleet that rotates leads across accounts has one config dir per seat, and a teammate
// launched under seat C mounts seat C's personal MCP servers. The fixed pair reads only the
// spawner's own two roots, so a server registered only in seat C's `.claude.json` would reach
// every worktree undenied. `{ roots }` is how the spawner hands every seat's dir in.

test('roots: a server registered ONLY in a third seat\'s .claude.json (user scope) is enumerated', async (t) => {
  const home = tmp(t, 'home-');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { fixed_pair_only: {} } }));
  const third = seat(t, { mcpServers: { seat_c_user: {} } });
  const s = await load('roots-user');
  const got = s.enumerateUserMcpServers(home, {}, { roots: [third] });
  assert.ok(got.includes('seat_c_user'),
    `a seat-only server is missing from ${JSON.stringify(got)} — a teammate under that seat mounts it undenied`);
});

test('roots: a server registered ONLY under a third seat\'s projects[*].mcpServers (local scope) is enumerated', async (t) => {
  const home = tmp(t, 'home-');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { fixed_pair_only: {} } }));
  const third = seat(t, { projects: { '/Users/op/work': { hasTrustDialogAccepted: true, mcpServers: { seat_c_local: {} } } } });
  const s = await load('roots-local');
  const got = s.enumerateUserMcpServers(home, {}, { roots: [third] });
  assert.ok(got.includes('seat_c_local'),
    `local scope is where \`claude mcp add\` puts a server by default; missing from ${JSON.stringify(got)}`);
});

test('roots are ADDED to the fixed pair, never substituted for it', async (t) => {
  const home = tmp(t, 'home-');
  const ambient = tmp(t, 'cfgroot-');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { home_user: {} } }));
  writeFileSync(join(ambient, '.claude.json'), JSON.stringify({ mcpServers: { ambient_user: {} } }));
  const third = seat(t, { mcpServers: { seat_c_user: {} } });
  const s = await load('roots-union');
  assert.deepEqual(s.enumerateUserMcpServers(home, { CLAUDE_CONFIG_DIR: ambient }, { roots: [third] }).sort(),
    ['ambient_user', 'home_user', 'seat_c_user'],
    'all three sources at once — the fixed pair is what the spawner\'s own environment reads, and a seat is one more root, not a replacement');
});

test('roots: `soma` registered in a seat (what `soma init --seat` does) is still excluded', async (t) => {
  const home = tmp(t, 'home-');
  const third = seat(t, { mcpServers: { soma: {}, seat_c_user: {} }, projects: { '/x': { mcpServers: { soma: {} } } } });
  const s = await load('roots-soma');
  assert.deepEqual(s.enumerateUserMcpServers(home, {}, { roots: [third] }).sort(), ['seat_c_user'],
    'every seat carries the bus at user scope; a root read AFTER the soma delete re-introduces the self-deny that broke the first fleet');
});

test('roots: a seat with no .claude.json yet (listed before `claude auth login`) contributes nothing and is not an error', async (t) => {
  const home = tmp(t, 'home-');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { home_user: {} } }));
  const bare = seat(t, null);
  const s = await load('roots-absent');
  assert.deepEqual(s.enumerateUserMcpServers(home, {}, { roots: [bare] }), ['home_user'],
    'a missing file is a seat with nothing to contribute, exactly like the unused root of the fixed pair');
});

test('roots: a malformed .claude.json in a seat fails CLOSED and names that seat\'s file', async (t) => {
  const home = tmp(t, 'home-');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { home_user: {} } }));
  const broken = seat(t, '{"mcpServers": {');
  const s = await load('roots-broken');
  assert.throws(() => s.enumerateUserMcpServers(home, {}, { roots: [broken] }),
    (e) => e instanceof SyntaxError && e.message.includes(join(broken, '.claude.json')),
    '"no servers in that seat" is the fail-open answer, into the hole this function exists to close — and the message must say WHICH seat to fix');
});

test('roots: a plugin enabled only in a seat is enumerated under its mangled name', async (t) => {
  const home = tmp(t, 'home-');
  const third = seat(t, null);
  const install = tmp(t, 'plugcache-');
  mkdirSync(join(third, 'plugins'), { recursive: true });
  writeFileSync(join(third, 'settings.json'), JSON.stringify({ enabledPlugins: { 'seatonly@m': true } }));
  writeFileSync(join(third, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'seatonly@m': [{ scope: 'user', installPath: install }] },
  }));
  writeFileSync(join(install, '.mcp.json'), JSON.stringify({ mcpServers: { srv: { type: 'http' } } }));
  const s = await load('roots-plugin');
  const got = s.enumerateUserMcpServers(home, {}, { roots: [third] });
  assert.ok(got.includes('plugin_seatonly_srv'),
    `a seat is a config dir, so its settings.json and plugins/ are read like the fixed pair's; got ${JSON.stringify(got)}`);
});

test('roots: a bad roots argument is refused by name, never read as "no seats"', async (t) => {
  const home = tmp(t, 'home-');
  const s = await load('roots-bad');
  assert.throws(() => s.enumerateUserMcpServers(home, {}, { roots: '/not/an/array' }),
    /enumerateUserMcpServers: roots must be an array/);
  assert.throws(() => s.enumerateUserMcpServers(home, {}, { roots: [''] }),
    /enumerateUserMcpServers: roots\[0\] must be a non-empty config dir path/,
    'an empty root would resolve() to the process cwd and answer about the wrong directory');
});

test('worktree guardrails deny personal MCPs + raw PR create, allow soma-pr', async (t) => {
  somaHome(t);
  const { ensureTree } = await import('../bin/lib/paths.mjs?' + Date.now());
  ensureTree();
  const s = await import('../bin/lib/settings-gen.mjs?' + Date.now());
  const dir = worktree(t);
  s.writeWorktreeGuardrails(dir, { mcpDenies: ['kite', 'mysql'], teammateAllow: [] });
  const j = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(j.permissions.deny.includes('mcp__kite'));
  assert.ok(j.permissions.deny.includes('mcp__mysql'));
  assert.ok(j.permissions.deny.some((d) => d.includes('gh pr create')));
  assert.ok(j.permissions.deny.some((d) => d.includes('gh pr merge')));
  assert.ok(j.permissions.deny.includes('mcp__atlassian__transitionJiraIssue'));
  assert.ok(j.permissions.allow.some((a) => a.includes('soma-pr')));
});

test('guardrails carry every standing-rule deny, and register the gate hook', async (t) => {
  somaHome(t);
  const s = await load('denies');
  const j = JSON.parse(readFileSync(s.writeWorktreeGuardrails(worktree(t), SOME), 'utf8'));
  for (const rule of [
    // draft-only, CLI and REST
    'Bash(gh pr merge*)', 'Bash(gh pr ready*)', 'Bash(gh pr create*)', 'Bash(gh pr edit*)',
    'Bash(gh api */merge*)', 'Bash(gh api */pulls*)',
    // ...and the two REST paths that write a ref or a file directly
    'Bash(gh api */git/refs*)', 'Bash(gh api */contents*)',
    // protected branches: anchored on the refspec position, closed at a word
    // boundary, for both names. See protectedBranchDenies for what each anchor is for.
    'Bash(git push*origin main)', 'Bash(git push*origin main *)',
    'Bash(git push*:main)', 'Bash(git push*:main *)',
    'Bash(git push*+main)', 'Bash(git push*+main *)',
    'Bash(git push*heads/main)', 'Bash(git push*heads/main *)',
    "Bash(git push*'main'*)", 'Bash(git push*"main"*)',
    'Bash(git push*origin develop)', 'Bash(git push*origin develop *)',
    'Bash(git push*:develop)', 'Bash(git push*:develop *)',
    'Bash(git push*+develop)', 'Bash(git push*+develop *)',
    'Bash(git push*heads/develop)', 'Bash(git push*heads/develop *)',
    "Bash(git push*'develop'*)", 'Bash(git push*"develop"*)',
    // …and the flags that reach a protected branch without naming it
    'Bash(git push*--all*)', 'Bash(git push*--mirror*)',
    'Bash(git push*--delete*)', 'Bash(git push*-d *)', 'Bash(git push*-d)',
    'Bash(git push*--force*)', 'Bash(git push*-f *)', 'Bash(git push*-f)',
    // the guard file protects itself — deleting it is invisible to git (`ensureWorktree`'s `*` ignore)
    'Bash(rm*.claude*)', 'Bash(mv*.claude*)', 'Edit(./.claude/**)',
    // named write surfaces that must outlive a teammate_mcp_allow
    'mcp__atlassian__transitionJiraIssue', 'mcp__atlassian__editJiraIssue',
    'mcp__github__merge_pull_request', 'mcp__github__update_pull_request',
    'mcp__github__update_pull_request_branch', 'mcp__github__create_pull_request',
    'mcp__github__create_pull_request_with_copilot', 'mcp__github__pull_request_review_write',
    'mcp__github__push_files', 'mcp__github__create_or_update_file', 'mcp__github__delete_file',
    // the two surfaces no enumeration can see
    'mcp__claude_ai_*', 'mcp__plugin_*',
  ]) assert.ok(j.permissions.deny.includes(rule), `missing deny ${rule}`);
  const hook = j.hooks.PreToolUse[0];
  assert.equal(hook.matcher, '*');
  // The command ends at the script. The old `--session-guard` switch (the retired
  // session-discriminated edit arm) is emitted nowhere any more.
  assert.match(hook.hooks[0].command, /lead-gate\.mjs'?$/);
  assert.ok(!hook.hooks[0].command.includes('--session-guard'));
});

test('both PreToolUse matchers are "*", because a hook that is not consulted denies nothing', async (t) => {
  // The one entry in each file does several jobs and `evaluateGate` decides all of
  // them; the matcher only decides which it is ever ASKED about. Measured live with
  // the matcher as the only variable, gate script and flag identical:
  //
  //   lead settings, matcher 'Bash'  + BUDGET_TRIPPED -> Bash refused, Read RAN.
  //     The breaker is an every-tool rule, so it stopped the cheapest tool and left
  //     Task — which spawns the teammates that spend the budget — wide open.
  //   worktree, matcher 'Edit|Write|NotebookEdit'      -> a bypassed teammate emptied
  //     its own guard file with `tee` and the md5 changed. That file is the whole
  //     secrets boundary and an emptied one fails OPEN to the personal MCP fleet.
  //
  // With '*': the tripped lead's Read is denied, the tripped teammate's Read is
  // denied, `tee` on the guard file is refused with the md5 unchanged, and an
  // untripped session's Edit and Read still work — for the lead too, now that its
  // edit surface matches a teammate's.
  //
  // 'Bash' is still NOT an acceptable narrowing: the breaker is an every-tool rule,
  // and a matcher that stops asking about `Task` leaves the tool that spends most of
  // a lead's budget outside it.
  somaHome(t);
  const s = await load('matchers');
  const lead = JSON.parse(readFileSync(s.writeLeadSettings('cr-1'), 'utf8'));
  const wt = JSON.parse(readFileSync(s.writeWorktreeGuardrails(worktree(t), SOME), 'utf8'));
  for (const [what, j] of [['lead settings', lead], ['worktree guardrails', wt]]) {
    assert.equal(j.hooks.PreToolUse.length, 1, `${what}: one gate entry, not several`);
    assert.equal(j.hooks.PreToolUse[0].matcher, '*', `${what}: the gate is not consulted for every tool`);
    assert.equal(j.hooks.PreToolUse[0].hooks.length, 1);
  }
  // The two commands are byte-identical now that the `--session-guard` flag is retired:
  // same script, no arguments — so claude collapses duplicate registrations into one run.
  assert.equal(lead.hooks.PreToolUse[0].hooks[0].command, wt.hooks.PreToolUse[0].hooks[0].command);
  assert.ok(!wt.hooks.PreToolUse[0].hooks[0].command.includes('--session-guard'));
});

test('the matcher this file reasons with reproduces every measured Claude Code verdict', async () => {
  // Pinning the model, not the module: if any of these drift, the push matrix below
  // is asserting against a fiction. Every line is one live run, classified from the
  // Bash tool_result string — NOT from "the remote gained nothing", which cannot tell
  // a permission deny from the model declining (round 3's first pass produced 12 false
  // DENIEDs exactly that way).

  // --- round 3: the character semantics, nine verdicts, all single-segment ---
  assert.ok(bashRuleMatches('Bash(git push*origin main)', 'git push origin main'));          // denied
  assert.ok(bashRuleMatches('Bash(git push*origin main)', 'git push -u origin main'));       // denied
  assert.ok(!bashRuleMatches('Bash(git push*origin main)', 'git push origin mainline'));     // RAN
  assert.ok(bashRuleMatches('Bash(git push*origin main *)', 'git push origin main --tags')); // denied
  assert.ok(bashRuleMatches('Bash(git push*-f)', 'git push origin soma/task-x -f'));         // denied
  assert.ok(bashRuleMatches('Bash(git push*heads/main)', 'git push origin refs/heads/main'));// denied
  assert.ok(bashRuleMatches('Bash(git push*+main)', 'git push origin +main'));               // denied
  // Braces are literal, not alternation: `Bash(git push*origin {main,develop}*)` let
  // BOTH `git push origin main` and `git push origin develop` through, refs and all.
  assert.ok(!bashRuleMatches('Bash(git push*origin {main,develop}*)', 'git push origin main'));
  // And the command is matched raw, not shell-unquoted: with only the bare anchors,
  // `git push origin 'main'` ran and put main on the remote.
  assert.ok(!bashRuleMatches('Bash(git push*origin main)', "git push origin 'main'"));
  assert.ok(bashRuleMatches("Bash(git push*'main'*)", "git push origin 'main'"));

  // --- round 4: the UNIT of matching, which round 3 got wrong ---
  // All nine verdicts above are single-segment and single-space, so a whole-string
  // model and a segmenting model agree on every one of them — the fidelity test
  // literally could not see the difference. These can. Probed with a custom guard
  // file holding ONE wildcard-free rule, `Bash(echo probe-alpha)`, and an innocuous
  // command, so the model's safety reflex cannot confound the verdict.
  const R = 'Bash(echo probe-alpha)';
  assert.ok(bashRuleMatches(R, 'echo probe-alpha'), 'exact: denied');
  assert.ok(bashRuleMatches(R, 'echo ok && echo probe-alpha'), '&& second segment: denied');
  assert.ok(bashRuleMatches(R, 'echo probe-alpha && echo ok'), '&& first segment: denied');
  assert.ok(bashRuleMatches(R, 'echo ok || echo probe-alpha'), '|| segment: denied');
  assert.ok(bashRuleMatches(R, 'echo probe-alpha;'), 'trailing ;: denied');
  assert.ok(bashRuleMatches(R, 'echo probe-alpha | cat'), 'pipe segment: denied');
  assert.ok(bashRuleMatches(R, 'echo probe-alpha & wait'), 'background &: denied');
  assert.ok(!bashRuleMatches(R, 'echo probe-alphax'), 'negative control: RAN');

  // Whitespace: collapsing is real but CONDITIONAL on the rule holding a wildcard, and
  // both unconditional claims about it are wrong. Each of these was measured with the
  // command confirmed sent byte-for-byte (the model will otherwise tidy it, which is
  // how the first pass at this got the wrong answer).
  //
  // No wildcard -> raw comparison, a doubled space defeats the rule:
  assert.ok(!bashRuleMatches(R, 'echo  probe-alpha'), 'no wildcard, 2 spaces: RAN');
  assert.ok(!bashRuleMatches('Bash(echo alpha beta)', 'echo alpha  beta'), 'no wildcard, 2 spaces: RAN');
  assert.ok(!bashRuleMatches('Bash(echo alpha beta)', 'echo alpha   beta'), 'no wildcard, 3 spaces: RAN');
  assert.ok(!bashRuleMatches('Bash(git status --short)', 'git status  --short'), 'no wildcard, git: RAN');
  // Wildcard anywhere -> whitespace-insensitive:
  assert.ok(bashRuleMatches('Bash(echo zulu*alpha beta)', 'echo zulu mid alpha  beta'), 'wildcard mid: DENIED');
  assert.ok(bashRuleMatches('Bash(echo alpha beta*)', 'echo alpha  beta gamma'), 'wildcard at end: DENIED');
  // ...which is the case that matters, because EVERY Bash rule this module ships has a
  // wildcard. `git push origin  main` on the real guard file is denied, measured.
  assert.ok(bashRuleMatches('Bash(git push*origin main)', 'git push origin  main'),
    'the shipped rules are whitespace-insensitive; a doubled space must not be a bypass');

  // A NEWLINE segments as well, and it was absent from round 4's recorded set. Measured
  // DENIED twice, the second time against a rule this module actually ships — so a
  // checker built from the recorded five would let a protected push on line 2 through.
  assert.ok(bashRuleMatches(R, 'echo ok\necho probe-alpha'), 'newline second line: denied');
  assert.ok(bashRuleMatches('Bash(git push*origin main)', 'cd /repo\ngit push origin main'),
    'a newline is a segment separator on the SHIPPED rules too');

  // The RULE body segments as well — segment-vs-whole-command cannot produce this.
  assert.ok(bashRuleMatches('Bash(echo one && echo two)', 'echo one && echo two'));

  // ...and the quantifier over those rule segments is `every`, not `some`. Nothing was
  // ever measured saying this rule also denies `echo one` alone, and over-predicting DENY
  // is the direction that makes a checker report a rule that is not there.
  assert.ok(!bashRuleMatches('Bash(echo one && echo two)', 'echo one'),
    'a multi-segment rule was satisfied by one of its segments');

  // ...and a wildcard does NOT span a segment boundary, which is what rules out
  // "whole-string matching with extra steps". Under whole-string semantics the `*`
  // absorbs ` && ` and this is a deny; measured, it RAN.
  assert.ok(!bashRuleMatches('Bash(echo a*echo z)', 'echo a && echo z'));

  // The same five vectors against the SHIPPED guard file's own rule, which is what
  // makes the correction consequential rather than academic. The old whole-string
  // helper predicted ALLOW for all four denies below.
  const G = 'Bash(git push*origin main)';
  assert.ok(bashRuleMatches(G, 'git push origin main && echo done'));   // denied
  assert.ok(bashRuleMatches(G, 'echo hello && git push origin main'));  // denied
  assert.ok(bashRuleMatches(G, 'git push origin main;'));               // denied
  assert.ok(bashRuleMatches(G, 'git push origin main | cat'));          // denied
  // ...while the chain a teammate actually runs still goes through. Measured RAN
  // (exit 128, "not a git repository" — i.e. the shell got it, not the deny).
  assert.ok(!bashRuleMatches(G, 'echo hello && git push origin soma/task-x'));
});

test('protected-branch denies anchor on the refspec, so ordinary branch names still push', async (t) => {
  somaHome(t);
  const s = await load('pushmatrix');
  const deny = JSON.parse(readFileSync(s.writeWorktreeGuardrails(worktree(t), SOME), 'utf8')).permissions.deny;

  // Every one of these reached a protected branch, or a force/delete, in a live run.
  for (const cmd of [
    'git push origin main', 'git push origin develop', 'git push -u origin main',
    'git push origin HEAD:main', 'git push origin +HEAD:develop', 'git push origin main:main',
    'git push origin soma/task-x:main', 'git push origin +main', 'git push origin refs/heads/main',
    'git push origin HEAD:refs/heads/develop', "git push origin 'main'", 'git push origin "develop"',
    'git push origin --delete main', 'git push -d origin main',
    // named nowhere in the command, yet both pushed main AND develop before this round
    'git push --all origin', 'git push --mirror origin',
    // force, both spellings, both positions — the trailing one went through before
    'git push --force origin soma/task-x', 'git push -f origin soma/task-x',
    'git push origin soma/task-x -f', 'git push --force-with-lease origin soma/task-x',
  ]) assert.ok(denied(deny, cmd), `a protected-branch push is not denied: ${cmd}`);

  // …and every one of THESE was refused before this round, which dead-ends the task:
  // no push means no `soma-pr`, no draft PR, and a refusal that reads like a
  // protected-branch hit rather than a rule bug.
  for (const cmd of [
    'git push origin soma/task-x', 'git push -u origin soma/task-x',
    'git push origin soma/fix-main-nav', 'git push origin soma/developer-docs',
    'git push origin soma/maintain-cache', 'git push origin soma/domain-model',
    'git push origin mainline', 'git push origin maintenance',
    'git push origin soma/remain', 'git push origin HEAD:soma/main-menu',
  ]) assert.ok(!denied(deny, cmd), `an ordinary task branch cannot be pushed: ${cmd}`);

  // The spec's own spelling is gone on purpose: its trailing wildcard IS the
  // over-reach, and the anchored pair subsumes everything else it caught.
  assert.ok(!deny.includes('Bash(git push origin main*)'), 'the over-broad spec spelling came back');
  assert.ok(!deny.some((d) => d === 'Bash(git push*main*)' || d === 'Bash(git push*develop*)'));
});

test('gh api cannot write a ref or a file, and ordinary gh api reads still work', async (t) => {
  // RED, measured against the shipped guard file BEFORE these two rules existed: all
  // three of these were permission-ALLOWED — the Bash tool ran them and they reached
  // GitHub, which answered 404 only because the probe aimed at a repo that does not
  // exist. Each response's documentation_url named the write endpoint it had reached
  // (update-a-reference, create-or-update-file-contents, create-a-reference), and the
  // gh token on this machine carries `repo` scope, so against a real remote every one
  // of them lands. One command, straight past the twenty protected-branch push rules.
  somaHome(t);
  const s = await load('ghapi');
  const deny = JSON.parse(readFileSync(s.writeWorktreeGuardrails(worktree(t), SOME), 'utf8')).permissions.deny;
  const R = '/repos/o/r';
  for (const cmd of [
    `gh api --method PATCH ${R}/git/refs/heads/main -f sha=abc`,        // force-moves main
    `gh api --method PUT ${R}/contents/x.txt -f branch=main -f content=eA==`,  // direct commit
    `gh api --method POST ${R}/git/refs -f ref=refs/heads/main -f sha=abc`,    // creates main
    `gh api -X PATCH ${R}/git/refs/heads/develop -f sha=abc`,           // the -X spelling
    `gh api ${R}/contents/README.md`,                                   // read: over-reach, accepted
    `gh api ${R}/git/refs/heads`,                                       // read: over-reach, accepted
  ]) assert.ok(denied(deny, cmd), `a ref/file write over REST is not denied: ${cmd}`);

  // The over-reach is affordable only because it deletes a REDUNDANT spelling, which
  // is this file's stated test for any widening. Everything else `gh api` can ask is
  // untouched — verified live for the first two against the real network.
  for (const cmd of [
    'gh api /repos/cli/cli --jq .name', 'gh api /user --jq .login',
    'gh api /repos/cli/cli/commits?per_page=1', 'gh api /repos/cli/cli/issues/1',
    'gh api /rate_limit', 'gh api /repos/cli/cli/branches',
    // and the alternatives that make the two denied reads redundant rather than lost
    'git ls-remote https://github.com/cli/cli refs/heads/main',
    'gh repo view cli/cli --json defaultBranchRef',
    'git show origin/main:README.md',
  ]) assert.ok(!denied(deny, cmd), `an ordinary read was collateral damage: ${cmd}`);
});

test('every Bash rule keeps a wildcard, which is what makes the guard file whitespace-insensitive', async (t) => {
  // Not stylistic. Measured with the rule as the only variable and the command
  // confirmed sent byte-for-byte: a rule holding a `*` matches whitespace-insensitively,
  // a rule with no `*` is compared to the raw segment. So `Bash(echo alpha beta)` lets
  // `echo alpha  beta` RUN while `Bash(echo alpha beta*)` refuses it. Every rule here
  // has a wildcard, so `git push origin  main` with a doubled space is denied — and a
  // wildcard-free rule added later would be whitespace-brittle in a way nothing else in
  // the file is, which is invisible in review and costs one keystroke to bypass.
  somaHome(t);
  const s = await load('wildcards');
  const j = JSON.parse(readFileSync(s.writeWorktreeGuardrails(worktree(t), SOME), 'utf8'));
  const bodyOf = (r) => /^Bash\((.*)\)$/s.exec(r)?.[1];
  for (const rule of [...j.permissions.deny, ...j.permissions.allow].filter((r) => r.startsWith('Bash('))) {
    assert.ok(bodyOf(rule)?.includes('*'), `wildcard-free Bash rule is whitespace-brittle: ${rule}`);
  }
  // ...and the consequence, on the real rules rather than a probe rule.
  const deny = j.permissions.deny;
  for (const cmd of ['git push origin  main', 'git push  origin main', 'git  push origin main',
    'git push origin   develop', 'git push  --all  origin']) {
    assert.ok(denied(deny, cmd), `a doubled space bypassed a protected-branch rule: ${cmd}`);
  }
});

test('the -f/-d end-anchors also refuse a branch NAME ending in -f or -d, deliberately', async (t) => {
  // The one over-reach of the boundary idiom, pinned rather than left as prose: both
  // of these are denied, measured. Kept because dropping the end-of-command rules let
  // `git push origin soma/task-x -f` through with the flag last. It is also the one
  // over-reach a caller can simply avoid, so the module states the rule a lead must
  // follow: never generate a task branch whose name ends in `-f` or `-d`.
  somaHome(t);
  const s = await load('suffix');
  const deny = JSON.parse(readFileSync(s.writeWorktreeGuardrails(worktree(t), SOME), 'utf8')).permissions.deny;
  assert.ok(denied(deny, 'git push origin soma/task-f'), 'the -f end-anchor stopped over-reaching');
  assert.ok(denied(deny, 'git push origin soma/task-d'), 'the -d end-anchor stopped over-reaching');
  // ...and it really is only the final two characters — the guidance is cheap to follow.
  for (const cmd of ['git push origin soma/task-fix', 'git push origin soma/task-docs',
    'git push origin soma/task-f-2', 'git push origin soma/fd']) {
    assert.ok(!denied(deny, cmd), `the suffix over-reach is wider than two characters: ${cmd}`);
  }
});

test('the push matrix still holds when the commands are CHAINED, which is how teammates run them', async (t) => {
  // Claude Code segments on `;` `&&` `||` `|` `&` and matches each segment, so every
  // rule in this file applies to every segment of every chain. That is the safe
  // direction, but it had never been enumerated: the matrix above only ever tested one
  // command per string, while the thing a teammate actually runs is
  // `git add -A && git commit -m x && git push origin soma/task-x`. Both directions
  // matter here — a chain must not smuggle a protected branch through, and prefixing a
  // legitimate push with a commit must not start refusing it (that failure mode is
  // this module's original bug, which dead-ended the task with a refusal that
  // misdescribed itself).
  somaHome(t);
  const s = await load('chained');
  const deny = JSON.parse(readFileSync(s.writeWorktreeGuardrails(worktree(t), SOME), 'utf8')).permissions.deny;
  const PRE = 'git add -A && git commit -m "wip" && ';

  for (const cmd of ['git push origin soma/task-x', 'git push -u origin soma/task-x',
    'git push origin soma/fix-main-nav', 'git push origin mainline', 'git push origin maintenance',
    'git push origin soma/remain', 'git push origin HEAD:soma/main-menu']) {
    for (const v of [PRE + cmd, `${cmd} && echo ok`, `echo start; ${cmd}`, `${cmd} | tee log`]) {
      assert.ok(!denied(deny, v), `chaining broke an ordinary task push: ${v}`);
    }
  }

  for (const cmd of ['git push origin main', 'git push origin develop', 'git push origin HEAD:main',
    'git push origin +main', 'git push origin refs/heads/main', "git push origin 'main'",
    'git push origin --delete main', 'git push --all origin', 'git push --mirror origin',
    'git push origin soma/task-x -f', 'git push --force origin soma/task-x']) {
    for (const v of [PRE + cmd, `${cmd} && echo ok`, `echo start; ${cmd}`, `${cmd} | cat`,
      `echo a || ${cmd}`]) {
      assert.ok(denied(deny, v), `a chain smuggled a protected-branch push through: ${v}`);
    }
  }
});

test('the credential-store family denies the agents, the token files and the cookie jars', async (t) => {
  // WHY THIS FAMILY EXISTS: a review agent on this build read the operator's LIVE Claude
  // OAuth token into its own transcript by accident, with one `security
  // find-generic-password` while looking for something else. Nothing here stopped it, and
  // the canary would have reported all eight invariants holding while it happened.
  //
  // Classified from the RULE, never from an execution: no keychain read is performed by
  // this test or by any part of this suite. Each vector is a synthetic command string put
  // through the same segment-aware matcher the push matrix uses.
  somaHome(t);
  const s = await load('creds');
  const deny = JSON.parse(readFileSync(s.writeWorktreeGuardrails(worktree(t), SOME), 'utf8')).permissions.deny;

  for (const cmd of [
    // the agents — bare, path-spelled, behind sudo, and inside a chain
    'security find-generic-password -s "Claude Code-credentials" -w',
    '/usr/bin/security find-generic-password -w -s x',
    'sudo security dump-keychain -d',
    'security find-internet-password -s github.com',
    'keyring get claude token', '/opt/homebrew/bin/keyring get a b',
    'secret-tool lookup service claude', '/usr/bin/secret-tool lookup a b',
    'pass show personal/aws', '/usr/local/bin/pass show x',
    'gpg --decrypt secrets.gpg', 'gpg -d secrets.gpg', 'gpg --output x -d f',
    'echo start && security find-generic-password -w -s x',
    // the files, through any reader at all — this is the half that names the SECRET
    'cat ~/.aws/credentials', 'head -5 /Users/o/.aws/credentials',
    'python3 -c "print(open(\'/Users/o/.aws/credentials\').read())"',
    'xxd ~/.ssh/id_ed25519 | head', 'cat ~/.ssh/id_rsa',
    'cat ~/.netrc', 'curl --netrc-file ~/.netrc https://x',
    'cat ~/.config/gh/hosts.yml', 'grep oauth_token ~/.config/gh/hosts.yml',
    'cat ~/.docker/config.json',
    'cat ~/.claude/.credentials.json', 'cat ~/.claude-work/.credentials.json',
    'cat ~/.aws/sso/cache/abc.json',
    // browser cookie and saved-password stores
    'sqlite3 ~/Library/Cookies/Cookies.binarycookies .dump',
    'cp "$HOME/Library/Application Support/Google/Chrome/Default/Cookies" /tmp/c',
    'sqlite3 ~/.mozilla/firefox/x.default/cookies.sqlite "select * from moz_cookies"',
    'strings "/Users/o/Library/Application Support/Google/Chrome/Default/Login Data"',
  ]) assert.ok(denied(deny, cmd), `a credential store is reachable: ${cmd}`);

  // Controls. Over-reach here dead-ends real tasks, which is the failure mode the
  // protected-branch rules already produced once, so the narrowness is asserted too.
  for (const cmd of [
    'securityscan --help', 'npm run pass', 'git push origin soma/task-x',
    'cat src/Cookies.tsx', 'cat app/cookies.ts', 'ls ~/.ssh',
    'cat package.json', 'gpg --list-keys', 'gh auth status',
    'cat .npmrc', 'cat ~/.kube/config', 'cat docs/aws/credentials-design.md',
  ]) assert.ok(!denied(deny, cmd), `an ordinary command was collateral damage: ${cmd}`);

  // The Read-tool half. No `Bash(...)` rule can see the Read tool — it produces no command
  // string — so this is not redundancy, it is the other surface. Asserted verbatim because
  // that is the only thing a text rule can be asserted as.
  //
  // ALL THIRTEEN. This list held the first SEVEN, and doctor's `CREDENTIAL_READ_RULES` held the
  // same seven, so the six browser cookie and saved-password rules below were pinned by nothing
  // on either surface — deleting `Read(~/.mozilla/**)` left the whole suite green. The browser
  // stores are the credential-at-rest class this family was added for, and through the Read
  // tool they are the half no `Bash(...)` rule can cover.
  for (const rule of ['Read(~/.aws/**)', 'Read(~/.ssh/**)', 'Read(~/.netrc)',
    'Read(~/.config/gh/**)', 'Read(~/.docker/config.json)',
    'Read(~/.claude/.credentials.json)', 'Read(~/.claude*/.credentials.json)',
    'Read(~/Library/Cookies/**)', 'Read(~/Library/Application Support/**/Cookies*)',
    'Read(~/Library/Application Support/**/Login Data*)', 'Read(~/.mozilla/**)',
    'Read(~/.config/google-chrome/**)', 'Read(~/.config/chromium/**)']) {
    assert.ok(deny.includes(rule), `the Read-tool surface is open: ${rule} is missing`);
  }
  // …and the count, so a rule ADDED here without an assertion is caught too. The list above is
  // an exact set, not a lower bound: `test/doctor.test.mjs` holds the other half of this fence
  // (doctor's asserted set must equal what this module ships), and both are needed — this one
  // catches a deletion, that one catches an addition with no coverage.
  assert.equal(deny.filter((d) => d.startsWith('Read(')).length, 13,
    'the Read(...) rule set changed: add the rule to this list AND to doctor.CREDENTIAL_READ_RULES, or it is pinned by nothing');
  // …and it must be spelled `Read(`, not `Write(`/`Edit(`: a read rule on a write tool
  // is the inert-rule defect in the mirror (see the test below).
  assert.ok(deny.some((d) => d.startsWith('Read(')), 'no Read(...) rule at all');
});

test('no Write(...) deny is emitted — Claude Code refuses to honour one and says so', async (t) => {
  // Every session in a guarded worktree printed: "Permission deny rule
  // (.claude/settings.local.json): Write(./.claude/**) is not matched by file
  // permission checks — only Edit(path) rules are. Use Edit(./.claude/**) instead
  // (Edit rules cover all file-editing tools)." So the rule was inert, it looked
  // like coverage, and it warned every teammate. The Edit rule is what actually
  // refuses the Write tool — verified live, before and after removing this.
  somaHome(t);
  const s = await load('nowrite');
  const deny = JSON.parse(readFileSync(s.writeWorktreeGuardrails(worktree(t), SOME), 'utf8')).permissions.deny;
  assert.ok(!deny.some((d) => d.startsWith('Write(')), `an inert Write() rule is back: ${deny}`);
  assert.ok(deny.includes('Edit(./.claude/**)'), 'the rule that actually covers Edit/Write/NotebookEdit is missing');
});

test('home and env are parameters — a sandbox home is never answered from the real environment', async (t) => {
  // The bug: `claudeConfigRoot` read the GLOBAL process.env while `home` was a
  // parameter, so enumerateUserMcpServers('/tmp/fake-home') still resolved the
  // operator's real CLAUDE_CONFIG_DIR and returned the operator's real servers.
  // Any caller that passes a sandbox home would have been lied to.
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'cfgroot-'));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { sandbox_user: {} } }));
  writeFileSync(join(elsewhere, '.claude.json'), JSON.stringify({ mcpServers: { ambient_only: {} } }));
  const s = await load('envparam');

  withConfigDir(t, elsewhere);                       // the ambient environment points away
  assert.deepEqual(s.enumerateUserMcpServers(home, {}).sort(), ['sandbox_user'],
    'an explicit env was ignored in favour of the process environment');
  // …and the default is still the process environment, so production is unchanged.
  assert.deepEqual(s.enumerateUserMcpServers(home).sort(), ['ambient_only', 'sandbox_user']);
  // An empty value still falls back to the default root — `||`, not `??`.
  assert.deepEqual(s.enumerateUserMcpServers(home, { CLAUDE_CONFIG_DIR: '' }).sort(), ['sandbox_user']);
});

test('the empty-mcpDenies refusal describes the caller\'s home, not this machine', async (t) => {
  // The guard called the enumerator with no argument at all, so its "this machine
  // has N discoverable MCP servers" sentence was about the operator's real machine
  // even when the whole call had been pointed at a throwaway home.
  somaHome(t);
  fakeHome(t, { mcpServers: { real_a: {}, real_b: {}, real_c: {} } });   // "this machine"
  const sandbox = mkdtempSync(join(tmpdir(), 'home-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  writeFileSync(join(sandbox, '.claude.json'), JSON.stringify({ mcpServers: { only_one: {} } }));
  const s = await load('guardhome');
  assert.throws(() => s.writeWorktreeGuardrails(worktree(t), { mcpDenies: [], teammateAllow: [], home: sandbox, env: {} }),
    /has 1 discoverable MCP servers \(only_one/);

  // …and a sandbox home with nothing in it must not be refused just because the
  // machine running the test has servers.
  const empty = mkdtempSync(join(tmpdir(), 'home-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const fp = s.writeWorktreeGuardrails(worktree(t), { mcpDenies: [], teammateAllow: [], home: empty, env: {} });
  assert.ok(!JSON.parse(readFileSync(fp, 'utf8')).permissions.deny.some((d) => d.startsWith('mcp__real_')));

  // The default enumeration honours `home` too, not just the refusal.
  const deny = JSON.parse(readFileSync(
    s.writeWorktreeGuardrails(worktree(t), { teammateAllow: [], home: sandbox, env: {} }), 'utf8')).permissions.deny;
  assert.ok(deny.includes('mcp__only_one'));
  assert.ok(!deny.includes('mcp__real_a'), 'the real machine leaked into a sandbox call');
});

test('`home` ALONE isolates — an ambient CLAUDE_CONFIG_DIR must not leak into a sandbox answer', async (t) => {
  // The half-applied half of the fix above, and the reason it went unnoticed: every
  // test passed `home` AND `env` together, so the one-argument call was never
  // exercised. With `env` merely forwarded verbatim it arrived `undefined` and fell
  // through to enumerateUserMcpServers's own `env = process.env` default, so on a
  // machine with CLAUDE_CONFIG_DIR set — this one — `{ home: sandbox }` still unioned
  // the operator's REAL config root and the refusal message named the wrong machine.
  somaHome(t);
  const sandbox = mkdtempSync(join(tmpdir(), 'home-'));
  const ambient = mkdtempSync(join(tmpdir(), 'cfgroot-'));
  t.after(() => { rmSync(sandbox, { recursive: true, force: true }); rmSync(ambient, { recursive: true, force: true }); });
  writeFileSync(join(sandbox, '.claude.json'), JSON.stringify({ mcpServers: { only_one: {} } }));
  writeFileSync(join(ambient, '.claude.json'), JSON.stringify({ mcpServers: { ambient_leak: {} } }));
  withConfigDir(t, ambient);                        // exactly the machine this ships on
  const s = await load('homealone');

  // No `env` key at all — the call site the tests never made.
  const deny = JSON.parse(readFileSync(
    s.writeWorktreeGuardrails(worktree(t), { teammateAllow: [], home: sandbox }), 'utf8')).permissions.deny;
  assert.ok(deny.includes('mcp__only_one'), 'the sandbox home was not read');
  assert.ok(!deny.includes('mcp__ambient_leak'),
    'the ambient CLAUDE_CONFIG_DIR root leaked into an answer about a sandbox home');

  // ...and the refusal names the caller's machine, not the operator's.
  assert.throws(() => s.writeWorktreeGuardrails(worktree(t), { mcpDenies: [], teammateAllow: [], home: sandbox }),
    /has 1 discoverable MCP servers \(only_one/);

  // An explicit `env` still wins over the isolation default, both ways.
  const withAmbient = JSON.parse(readFileSync(s.writeWorktreeGuardrails(
    worktree(t), { teammateAllow: [], home: sandbox, env: { CLAUDE_CONFIG_DIR: ambient } }), 'utf8')).permissions.deny;
  assert.ok(withAmbient.includes('mcp__ambient_leak'), 'an explicit env was ignored');

  // ...and with NEITHER argument, production behaviour is untouched: the real
  // process environment, so the ambient root is read exactly as it is today.
  fakeHome(t, { mcpServers: { prod_home: {} } });
  const prod = JSON.parse(readFileSync(
    s.writeWorktreeGuardrails(worktree(t), { teammateAllow: [] }), 'utf8')).permissions.deny;
  assert.ok(prod.includes('mcp__prod_home') && prod.includes('mcp__ambient_leak'),
    'omitting both options must still union the real roots — that is the production path');
});

test('claude.ai connectors and plugin servers are denied by PREFIX, since they are not on disk', async (t) => {
  // Measured: `claude mcp list` shows 16 `claude.ai <Name>` connectors — Slack,
  // Microsoft 365 and Google Drive already AUTHENTICATED — plus
  // `plugin:vercel:vercel`, while `~/.claude.json` contains not one trace of any of
  // them (only the boolean `claudeAiMcpEverConnected`). Enumeration therefore cannot
  // reach them at all, and a guard file without these two rules leaves an
  // unattended teammate able to send mail and post to Slack as the operator.
  somaHome(t);
  fakeHome(t, { mcpServers: { kite: {} } });
  const s = await load('prefix');
  const deny = JSON.parse(readFileSync(s.writeWorktreeGuardrails(worktree(t)), 'utf8')).permissions.deny;
  assert.ok(deny.includes('mcp__claude_ai_*'), 'account connectors are un-denied');
  assert.ok(deny.includes('mcp__plugin_*'), 'plugin servers are un-denied');
  // The prefixes are the fence, not a substitute for enumeration: both must be there.
  assert.ok(deny.includes('mcp__kite'));
});

test('a teammate_mcp_allow on github still cannot make a non-draft PR or touch main', async (t) => {
  // The plausible allowlist entry — teammates do PR work and mcp__github is denied
  // wholesale — must not become a way around draft-only and the protected branches.
  somaHome(t);
  const s = await load('ghallow');
  const deny = JSON.parse(readFileSync(
    s.writeWorktreeGuardrails(worktree(t), { mcpDenies: ['github'], teammateAllow: ['github'] }), 'utf8')).permissions.deny;
  assert.ok(!deny.includes('mcp__github'), 'the allowlist did not lift the wholesale deny');
  for (const tool of ['create_pull_request', 'create_pull_request_with_copilot', 'merge_pull_request',
    'update_pull_request', 'update_pull_request_branch', 'pull_request_review_write',
    'push_files', 'create_or_update_file', 'delete_file']) {
    assert.ok(deny.includes(`mcp__github__${tool}`), `mcp__github__${tool} is reachable once github is allowlisted`);
  }
});

test('teammate_mcp_allow lifts the bare server deny but never the named tool denies', async (t) => {
  somaHome(t);
  const dir = worktree(t);
  const s = await load('allowlist');
  const fp = s.writeWorktreeGuardrails(dir, { mcpDenies: ['atlassian', 'kite'], teammateAllow: ['atlassian'] });
  const j = JSON.parse(readFileSync(fp, 'utf8'));
  assert.ok(!j.permissions.deny.includes('mcp__atlassian'), 'an allowlisted server must not be denied wholesale');
  assert.ok(j.permissions.deny.includes('mcp__kite'));
  // The two layers are the point: allowlisting atlassian restores Jira *comments*
  // while transitions and edits stay denied (the operator's standing rule).
  assert.ok(j.permissions.deny.includes('mcp__atlassian__transitionJiraIssue'));
  assert.ok(j.permissions.deny.includes('mcp__atlassian__editJiraIssue'));
});

test('guardrails default to the machine\'s real MCP servers and to soma.json\'s allowlist', async (t) => {
  // Deterministic rather than vacuous: HOME is a seeded throwaway, so "whatever
  // this machine has" is exactly two known servers — one per scope — and an
  // enumeration that silently returned [] would fail this test instead of passing it.
  somaHome(t);
  fakeHome(t, { mcpServers: { seeded_user: {} }, projects: { '/x': { mcpServers: { seeded_local: {} } } } });
  const dir = worktree(t);
  const s = await load('defaults');
  const j = JSON.parse(readFileSync(s.writeWorktreeGuardrails(dir), 'utf8'));      // no options at all
  assert.ok(j.permissions.deny.includes('mcp__seeded_user'));
  assert.ok(j.permissions.deny.includes('mcp__seeded_local'));
  assert.ok(j.permissions.deny.includes('Bash(gh pr create*)'));

  // ...and `teammate_mcp_allow` from soma.json is honored by that same default.
  const { writeConfig } = await import('../bin/lib/config.mjs?' + Date.now());
  writeConfig({ teammate_mcp_allow: ['seeded_local'] });
  const k = JSON.parse(readFileSync(s.writeWorktreeGuardrails(dir), 'utf8')).permissions.deny;
  assert.ok(!k.includes('mcp__seeded_local'), 'soma.json teammate_mcp_allow was ignored');
  assert.ok(k.includes('mcp__seeded_user'), 'the allowlist lifted more than it was asked to');
});

test('writeWorktreeGuardrails refuses to write a guard file that guards nothing', async (t) => {
  somaHome(t);
  const s = await load('refusals');

  // An explicit `[]` is indistinguishable from "I enumerated and found nothing",
  // and it publishes a file that reads as guarded while denying no personal server.
  fakeHome(t, { mcpServers: { kite: {} } });
  assert.throws(() => s.writeWorktreeGuardrails(worktree(t), { mcpDenies: [], teammateAllow: [] }),
    /mcpDenies is empty but this machine has 1 discoverable MCP server/);

  // A missing worktree is `ensureWorktree`'s job to create; conjuring it would leave a
  // `.claude/` orphan outside any checkout while the caller believes it guarded one.
  assert.throws(() => s.writeWorktreeGuardrails(join(tmpdir(), 'soma-no-such-worktree-' + process.pid), SOME),
    /does not exist — ensureWorktree must create the worktree first/);
});

test('an empty mcpDenies is fine on a machine that genuinely has no MCP servers', async (t) => {
  somaHome(t);
  fakeHome(t, null);                                   // HOME with no .claude.json at all
  const s = await load('emptyok');
  const dir = worktree(t);
  const deny = JSON.parse(readFileSync(s.writeWorktreeGuardrails(dir, { mcpDenies: [], teammateAllow: [] }), 'utf8')).permissions.deny;
  // Exactly the machine-independent rules and nothing else. The baseline is the
  // same call with its one personal name allowlisted away, so this stays true as
  // STANDING_DENIES grows instead of hard-coding a list that drifts.
  const baseline = JSON.parse(readFileSync(s.writeWorktreeGuardrails(dir, { mcpDenies: ['x'], teammateAllow: ['x'] }), 'utf8')).permissions.deny;
  assert.deepEqual(deny, baseline);
  assert.ok(deny.includes('Bash(gh pr create*)'));
});

test('the deny-rule count the residual docs quote is the count the generator produces', async (t) => {
  // WHY THIS EXISTS. Three documents told an operator how many deny rules an erased guard file
  // would take with it, and all three were wrong: `spawn.mjs` said 58, `lead-gate.mjs` said 59,
  // RUNBOOK §11.3 said "~58" and explained away the disagreement as an off-by-one. None of the
  // three was ever a count of a fixed set — each was a snapshot taken before the credential-store
  // family landed, and the family added 43. So the sentence an operator reads to size the blast
  // radius **understated it by 37 rules**, erring toward under-alarm, which is the wrong direction
  // for a residual. The final review's note on it is the reason this test is here: *nothing pins
  // either number, so nothing reddens.*
  //
  // The pin is therefore on the RELATION, never on a literal repeated in a fourth place. `EXPECTED`
  // is derived from the generator on every run, so adding a deny rule cannot make this test stale —
  // it makes it RED, at the site that has to be re-worded, which is the whole point.
  somaHome(t);
  fakeHome(t, null);
  const s = await load('denycount');
  const dir = worktree(t);
  // One personal server, allow-listed away, is how the rest of this file isolates the
  // machine-independent set — reused rather than re-derived.
  const deny = JSON.parse(readFileSync(s.writeWorktreeGuardrails(dir, { mcpDenies: ['x'], teammateAllow: ['x'] }), 'utf8')).permissions.deny;
  const EXPECTED = deny.length;

  assert.equal(new Set(deny).size, EXPECTED, 'the guard file carries a duplicate deny rule');
  // The composition, asserted so a future reader can check the arithmetic in the prose against
  // something rather than against another sentence.
  const by = (re) => deny.filter((d) => re.test(d)).length;
  assert.equal(by(/^Bash\(/) + by(/^Read\(/) + by(/^mcp__/) + by(/^Edit\(/), EXPECTED, 'a deny rule in a shape the docs do not describe');

  // The prose sites, each read from its own file, each scoped to the LINES around its claim rather
  // than to the file: a whole-file `/95/` is satisfied by a line number, a byte count or a version
  // string. `window` is used instead of a paragraph split because two of the three sites live in a
  // JSDoc block, where every line starts with ` *` and there is no blank line to split on — a
  // paragraph splitter silently returns most of the file, which is a pin with no scope at all.
  const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const window = (txt, re, span = 2) => {
    const lines = txt.split('\n');
    const i = lines.findIndex((l) => re.test(l));
    return i === -1 ? '' : lines.slice(Math.max(0, i - span), i + span + 1).join('\n');
  };
  // The anchor is the NOUN PHRASE, never the verb. Anchoring on "remains the only home of" made a
  // legitimate reword to "is still the only home of" a RED — measured — and a pin that reddens on
  // an honest reword is a pin the next author weakens rather than satisfies.
  const CLAIM = /machine-independent deny rules/;
  const SAYS = new RegExp(`\\b${EXPECTED} machine-independent deny rules\\b`);

  assert.match(window(src('bin/lib/spawn.mjs'), CLAIM), SAYS,
    `spawn.mjs's blast-radius sentence does not say ${EXPECTED} — re-count it from the generator, never from another comment`);

  assert.match(window(src('RUNBOOK.md'), CLAIM), SAYS,
    `RUNBOOK §11.3 does not say ${EXPECTED} — this is the sentence an operator sizes the damage with`);

  // The worked derivation beside that sentence — the thing a re-counter would copy. Pinned so the
  // recipe cannot drift from what the generator emits either.
  const worked = window(src('bin/lib/spawn.mjs'), /permissions\.deny\.length/, 3);
  assert.match(worked, new RegExp(`permissions\\.deny\\.length === ${EXPECTED + 1}`),
    'the worked example counts a guard file with one fake personal server, so it is EXPECTED + 1');
  assert.match(worked, new RegExp(`${EXPECTED} machine-independent = ${by(/^Bash\(/)} \`Bash\\(…\\)\` \\+ ${by(/^Read\(/)} \`Read\\(…\\)\` \\+ ${by(/^mcp__/)} \`mcp__…\``),
    'the worked breakdown no longer matches the shapes the generator emits');
});

test('guardrails allow BOTH soma-pr spellings — node <path> and the bare 100755 form', async (t) => {
  somaHome(t);
  const s = await load('somapr');
  const allow = JSON.parse(readFileSync(s.writeWorktreeGuardrails(worktree(t), SOME), 'utf8')).permissions.allow;
  // soma-pr.mjs is committed 100755 with a shebang, so `<path>/bin/soma-pr.mjs`
  // runs bare and would not match a `Bash(node …)` rule.
  assert.ok(allow.some((a) => /^Bash\(node \/.*\/bin\/soma-pr\.mjs\*\)$/.test(a)), `no absolute node rule in ${allow}`);
  assert.ok(allow.some((a) => /^Bash\(\/.*\/bin\/soma-pr\.mjs\*\)$/.test(a)), `no absolute bare rule in ${allow}`);
  // …the tilde/quoted spelling of this same install…
  assert.ok(allow.includes('Bash(node */bin/soma-pr.mjs*)'));
  // …but NOT a bare glob, which would allow any file anywhere named bin/soma-pr.mjs.
  assert.ok(!allow.includes('Bash(*/bin/soma-pr.mjs*)'), 'the bare glob is too wide to allow');
  assert.ok(allow.every((a) => !a.includes('\\')), 'permission rules must use forward slashes');
});

test('guardrails never clobber .claude/.gitignore, and create it when absent', async (t) => {
  somaHome(t);
  const s = await load('gitignore');

  // `ensureWorktree` writes it first in the real flow. Ours must leave those bytes alone.
  const kept = worktree(t);
  mkdirSync(join(kept, '.claude'), { recursive: true });
  writeFileSync(join(kept, '.claude', '.gitignore'), '**\n*\n');
  s.writeWorktreeGuardrails(kept, SOME);
  assert.equal(readFileSync(join(kept, '.claude', '.gitignore'), 'utf8'), '**\n*\n');
  assert.ok(existsSync(join(kept, '.claude', 'settings.local.json')));

  // And when nobody wrote one (a bare dir, a worktree from an older soma), the
  // guard file must still not show up in the PR: create the ignore ourselves.
  const bare = worktree(t);
  s.writeWorktreeGuardrails(bare, SOME);
  assert.equal(readFileSync(join(bare, '.claude', '.gitignore'), 'utf8'), '*\n');
});

/**
 * THE INVERSE OF WHAT THIS TEST ASSERTED FOR MOST OF THE BUILD, and the inversion is the fix.
 *
 * It used to require `permissions.deny === ['Edit','NotebookEdit','Write']` here. This file is
 * the base of `settings.launch.json`, which is the value of `--settings`, and `--settings` is
 * inherited by every split-pane teammate (measured, claude 2.1.220, from a real teammate's own
 * argv) — so those three bare names took all three write tools off every teammate in the
 * fleet, and a soma fleet produced no code. The lead's ban rides `--disallowedTools` on argv,
 * which teammates do NOT inherit; `test/spawn.test.mjs` pins that carrier.
 *
 * Asserted as `'permissions' in j` rather than `j.permissions?.deny`, so re-adding an EMPTY
 * permissions block, or one denying something else, is also a finding: this file binds the
 * whole fleet, so any permission rule written here is a fleet-wide rule wearing a lead's name.
 */
test('lead settings carry NO permissions block at all, and pin model opus', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { ensureTree, leadDir } = await import('../bin/lib/paths.mjs?' + Date.now());
  ensureTree(); mkdirSync(leadDir('cr-1'), { recursive: true });
  const s = await import('../bin/lib/settings-gen.mjs?' + Date.now());
  const fp = s.writeLeadSettings('cr-1');
  const j = JSON.parse(readFileSync(fp, 'utf8'));
  assert.equal(j.model, 'opus');
  assert.equal('permissions' in j, false,
    `writeLeadSettings wrote ${JSON.stringify(j.permissions)} — this file reaches every teammate through --settings, so a deny here disarms the fleet`);
});

test('lead settings carry autoContinueAtUsageLimit: true, the floor under account rotation', async (t) => {
  somaHome(t);
  const s = await load('autocontinue');
  const j = JSON.parse(readFileSync(s.writeLeadSettings('cr-1'), 'utf8'));
  // Measured (account-rotation spec §1.3, one real event): with this boolean true and
  // `resetsAt − now ≤ 24 h`, Claude Code shows `Usage limit reached · continuing automatically at …`
  // and resumes 85 s after the reset with a synthetic user prompt. Without it a rate-limited lead
  // sits silent — 5 d 21 h, measured — while the fleet reports it healthy. The strict boolean, not
  // truthiness: a string 'true' is a setting claude may ignore. This file reaches every teammate
  // through `--settings`, and here that is wanted: a teammate on the same seat hits the same window.
  assert.equal(j.autoContinueAtUsageLimit, true);
});

test('lead settings carry the heartbeat, Stop and Bash-gate hooks', async (t) => {
  const home = somaHome(t);
  const s = await load('hooks');
  const j = JSON.parse(readFileSync(s.writeLeadSettings('cr-1'), 'utf8'));
  assert.equal(j.hooks.PostToolUse[0].matcher, '*');
  assert.ok(j.hooks.PostToolUse[0].hooks[0].command.includes(join(home, 'heartbeats', 'cr-1')));
  assert.match(j.hooks.Stop[0].hooks[0].command, /^node .*\/bin\/hooks\/lead-stop\.mjs'?$/);
  assert.equal(j.hooks.PreToolUse[0].matcher, '*');       // every tool — the breaker is an every-tool rule
  assert.match(j.hooks.PreToolUse[0].hooks[0].command, /^node .*\/bin\/hooks\/lead-gate\.mjs'?$/);
  // An `assert.equal(j.permissions.deny.length, 3)` used to close this test. The deny is gone
  // — it reached every teammate through `--settings` — and its replacement lives in
  // "lead settings carry NO permissions block at all" above rather than here: this test's
  // subject is the three hooks, and a second assertion about `permissions` would only mean
  // that a mutation to it reddens two tests instead of one.
});

test('the heartbeat hook command survives a SOMA_HOME with a space and a quote', async (t) => {
  // The command is a shell string, not an argv, and it is written once and run on
  // every tool call for hours. An unquoted path under `/Users/o'brien/my soma`
  // silently touches the wrong file and the watchdog reads the lead as stalled.
  const home = mkdtempSync(join(tmpdir(), "soma- q'x-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const s = await load('quoting');
  const cmd = JSON.parse(readFileSync(s.writeLeadSettings('cr-1'), 'utf8')).hooks.PostToolUse[0].hooks[0].command;
  execFileSync('sh', ['-c', cmd]);                                   // exactly what the hook runner does
  assert.ok(existsSync(join(home, 'heartbeats', 'cr-1')), `hook did not create the heartbeat: ${cmd}`);
});

test('writeLeadMcpConfig emits a node-run soma server, absolute and forward-slashed, plus only the reasoning server', async (t) => {
  const home = somaHome(t);
  const s = await load('mcp');
  const fp = s.writeLeadMcpConfig('cr-1');
  assert.equal(fp, join(home, 'leads', 'cr-1', 'mcp.json'));
  const raw = readFileSync(fp, 'utf8');
  const j = JSON.parse(raw);
  // The recursion guard is that no server here reaches an ORCHESTRATOR bus: a lead that
  // could would be able to spawn leads. It was once spelled "exactly one server", which
  // conflated the guard with the count. `sequential-thinking` was added 2026-09-01 and is
  // safe under the real guard because it is stateless, credential-free and cannot reach the
  // fleet at all. Anything added here must clear that bar, so the assertion is an exact
  // set: a third name has to be justified deliberately, not slip in.
  assert.deepEqual(Object.keys(j.mcpServers).sort(), ['sequential-thinking', 'soma']);
  assert.equal(j.mcpServers.soma.command, 'node');
  // The reasoning server is the ONE sanctioned npx entry, and it carries no env at all —
  // a `env` key here would be the first place a credential could reach a lead's MCP surface.
  assert.deepEqual(j.mcpServers['sequential-thinking'], {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  });
  assert.ok(!('env' in j.mcpServers['sequential-thinking']), 'the reasoning server must carry no env');
  assert.equal((raw.match(/npx/g) ?? []).length, 1, 'exactly one npx entry — the bus is a file on this disk, never npx');
  const [busArg, ...rest] = j.mcpServers.soma.args;
  assert.deepEqual(rest, []);
  assert.ok(isAbsolute(busArg) || /^[A-Za-z]:\//.test(busArg), `not absolute: ${busArg}`);
  assert.ok(!busArg.includes('\\'), `not forward-slashed: ${busArg}`);
  assert.ok(busArg.endsWith('/bin/soma-bus.mjs'), busArg);
  // SOMA_TMUX_SOCKET rides beside SOMA_HOME for the same reason (issue #1): the lead starts under
  // `env -i`, and a lead's bus that does not know its fleet's socket falls back to `soma`, where
  // the orchestrator's pane id can be another fleet's pane. `tmux.socketName()` is the server this
  // process's own tmux calls, `newSession` among them, use: the same instance settings-gen reads.
  const { socketName } = await import('../bin/lib/tmux.mjs');
  assert.deepEqual(j.mcpServers.soma.env, { SOMA_ROLE: 'lead', SOMA_LEAD_NAME: 'cr-1', SOMA_HOME: home, SOMA_TMUX_SOCKET: socketName() });
});

test('writeLeadMcpConfig absolutizes a relative busPath', async (t) => {
  somaHome(t);
  const s = await load('relbus');
  const j = JSON.parse(readFileSync(s.writeLeadMcpConfig('cr-1', 'bin/soma-bus.mjs'), 'utf8'));
  const arg = j.mcpServers.soma.args[0];
  assert.ok(isAbsolute(arg) || /^[A-Za-z]:\//.test(arg), `a cwd-relative path would follow the reader home: ${arg}`);
  assert.ok(arg.endsWith('/bin/soma-bus.mjs'), arg);
});

test('every generated file is published atomically and rewrites byte-identically', async (t) => {
  const home = somaHome(t);
  const dir = worktree(t);
  const s = await load('atomic');
  const reads = [];
  for (const write of [() => s.writeLeadMcpConfig('cr-1'), () => s.writeLeadSettings('cr-1'),
    () => s.writeWorktreeGuardrails(dir, { mcpDenies: ['b', 'a', 'b'], teammateAllow: [] })]) {
    const first = readFileSync(write(), 'utf8');
    const second = readFileSync(write(), 'utf8');
    // Deterministic output: `soma doctor`'s drift check and every respawn diff the
    // file, and a set-ordering wobble would read as a guardrail change.
    assert.equal(first, second);
    assert.equal(first.at(-1), '\n');
    reads.push(first);
  }
  assert.ok(JSON.parse(reads[2]).permissions.deny.filter((d) => d === 'mcp__b').length === 1, 'duplicate deny');
  // tmp+rename, and nothing left behind by it — publish() names its scratch file
  // `<target>.<pid>.tmp` beside the target, so this is where a crashed write shows.
  for (const d of [join(home, 'leads', 'cr-1'), join(dir, '.claude')]) {
    assert.deepEqual(readdirSync(d).filter((f) => f.endsWith('.tmp')), []);
  }
  // …and the publish is a rename, not a truncate-then-write: with the target held
  // open, a truncating writer would leave the reader's own handle empty.
  const fp = join(dir, '.claude', 'settings.local.json');
  const fd = openSync(fp, 'r');
  t.after(() => closeSync(fd));
  s.writeWorktreeGuardrails(dir, { mcpDenies: ['c'], teammateAllow: [] });
  const held = Buffer.alloc(statSync(fp).size + 64);
  const n = readSync(fd, held, 0, held.length, 0);
  const beforeBytes = JSON.parse(held.subarray(0, n).toString());
  assert.ok(beforeBytes.permissions.deny.includes('mcp__b'), 'an open reader must still see the whole old file');
  assert.ok(JSON.parse(readFileSync(fp, 'utf8')).permissions.deny.includes('mcp__c'), 'the new file did not land');
});

// --- the options ARGUMENT itself, and roots at the writer -----------------

test('the third argument is refused by name, and an array of roots handed positionally cannot read as "no seats"', async (t) => {
  const home = tmp(t, 'home-');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { home_user: {} } }));
  const third = seat(t, { mcpServers: { seat_c_user: {} } });
  const s = await load('opts-shape');
  // `{ roots = [] } = {}` defaults only `undefined`, so `null` used to die with the raw
  // `Cannot read properties of null (reading 'roots')` — a refusal with no argument name on it,
  // in a module where `{ roots: null }` IS refused by name.
  assert.throws(() => s.enumerateUserMcpServers(home, {}, null),
    /enumerateUserMcpServers: the third argument must be an options object/,
    'null is the one value a destructuring default cannot catch');
  // The FAIL-OPEN one, and why this is not cosmetic: an array destructures to
  // `roots === undefined`, defaults to `[]`, and answers about no seats at all while the
  // caller believes it just handed every seat in. `enumerateUserMcpServers(home, env, roots)`
  // is exactly the call a reader of `writeWorktreeGuardrails(dir, {...})` would write.
  assert.throws(() => s.enumerateUserMcpServers(home, {}, [third]),
    /enumerateUserMcpServers: the third argument must be an options object/,
    'a bare roots array read as options enumerates NO seat and looks healthy doing it');
  assert.throws(() => s.enumerateUserMcpServers(home, {}, 'roots'),
    /enumerateUserMcpServers: the third argument must be an options object/);
  // Omitted is still the fixed pair, unchanged — the third state, and the one every caller uses.
  assert.deepEqual(s.enumerateUserMcpServers(home, {}), ['home_user'],
    'no options at all must stay exactly today\'s answer, or every existing caller changed meaning');
});

test('writeWorktreeGuardrails takes the same `roots`, so its own fallback enumeration is not stuck on the fixed pair', async (t) => {
  // The last path that could write a guard file from the fixed pair alone: `mcpDenies ??
  // enumerateUserMcpServers(home, enumEnv)`. Both production callers pass explicit denies
  // today, so this is a boundary that holds by the discipline of two call sites; giving the
  // writer the same `roots` word means a caller that does NOT pre-compute can still be right.
  const home = tmp(t, 'home-');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { home_user: {} } }));
  const third = seat(t, { mcpServers: { seat_c_user: {} } });
  const s = await load('guard-roots');
  const deny = JSON.parse(readFileSync(
    s.writeWorktreeGuardrails(worktree(t), { teammateAllow: [], home, env: {}, roots: [third] }), 'utf8')).permissions.deny;
  assert.ok(deny.includes('mcp__seat_c_user'),
    `a guard file written without pre-computed denies still has to deny every seat; got ${JSON.stringify(deny.filter((d) => d.startsWith('mcp__') && !d.includes('*')))}`);
  assert.ok(deny.includes('mcp__home_user'), 'roots are ADDED to the fixed pair here too, never substituted for it');
});

test('the empty-mcpDenies refusal counts the seats, so a bare fixed pair cannot satisfy it', async (t) => {
  // `mcpDenies: []` on a machine that has servers is the "I enumerated nothing" bug this
  // refusal exists to catch. Counting only the fixed pair answers about the wrong machine:
  // every server could live in a seat and the empty list would sail through.
  const home = tmp(t, 'home-');                          // no .claude.json: the fixed pair is bare
  const third = seat(t, { mcpServers: { seat_c_user: {} } });
  const s = await load('guard-roots-empty');
  assert.throws(() => s.writeWorktreeGuardrails(worktree(t), { mcpDenies: [], teammateAllow: [], home, env: {}, roots: [third] }),
    /mcpDenies is empty but this machine has 1 discoverable MCP servers \(seat_c_user/,
    'an empty deny list beside a seat holding a server is the fail-open write this refusal is for');
});
