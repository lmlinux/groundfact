#!/usr/bin/env node
/**
 * groundfact — an upstream facts compiler for agent context
 *
 * Layers:
 *   probes.d/*.sh  probes (idempotent shell snippets) → facts/machine.md
 *                  (the machine profile, a generated artifact)
 *   blocks/user    hand-written blocks: principles that never change across
 *                  projects (scope=user)
 *   blocks/project hand-written blocks: assembled per project traits
 *                  (scope=project, frontmatter when)
 *
 * Commands:
 *   groundfact init              initialize ~/.groundfact (with sample probes and blocks)
 *   groundfact probe             run probes → facts/machine.md; diff the previous
 *                              run and report machine changes
 *   groundfact build             global assembly: machine profile + user blocks →
 *                              each agent's global file
 *   groundfact build --project D project assembly (when conditions) → D/AGENTS.md
 *   groundfact build --rulesync D same content rewritten as rulesync sources
 *                              (D/rules/*.md) to fan out to 30+ targets
 *   groundfact list              preview: which blocks land in each target
 *   groundfact check             drift detection: generated vs on-disk (tells
 *                              hand edits apart from stale sources)
 *
 * Safety contract: only files this tool generated are managed (recognized by
 * the groundfact:generated header marker). An existing file without the marker
 * is skipped with a warning; --force adopts it (after a backup).
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = createRequire(import.meta.url)('../package.json').version; // single source: package.json
const HOME = os.homedir();
const ROOT = path.join(HOME, '.groundfact');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_MARK = '<!-- groundfact:generated';
const DAY_MS = 24 * 60 * 60 * 1000;

const log = (...a) => console.log(...a);
let IN_MCP = false; // MCP mode: errors become tool results instead of exits
const die = (msg, code = 1) => {
  if (IN_MCP) throw new Error(String(msg));
  console.error(`error: ${msg}`);
  process.exit(code);
};

// ---------------------------------------------------------------- helpers

const readIf = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const exists = (f) => fs.existsSync(f);
const isManagedContent = (text) => {
  if (text.startsWith(GENERATED_MARK)) return true;
  const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return frontmatter != null && text.slice(frontmatter[0].length).startsWith(GENERATED_MARK);
};
const expandTilde = (p) => (p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const mkdirp = (d) => fs.mkdirSync(d, { recursive: true });

function stripComments(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*)/.test(l) && !/^\s*\*\//.test(l))
    .join('\n');
}

function loadConfig() {
  const raw = readIf(path.join(ROOT, 'groundfact.json'));
  if (raw == null) die(`${ROOT} does not exist; run groundfact init first`);
  try {
    return JSON.parse(stripComments(raw));
  } catch (e) {
    die(`failed to parse groundfact.json: ${e.message}`);
  }
}

/** frontmatter: parses just enough key/values (string/number/bool/JSON array) */
function parseFrontmatter(text, fallbackId, preserveBody = false) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: { id: fallbackId, scope: 'user', targets: ['*'], weight: 50 }, body: preserveBody ? text : text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[')) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.replace(/[[\]"']/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      }
    } else if (/^(true|false)$/.test(v)) v = v === 'true';
    else if (/^-?\d+$/.test(v)) v = parseInt(v, 10);
    else v = v.replace(/^["']|["']$/g, '');
    meta[kv[1]] = v;
  }
  meta.id ||= fallbackId;
  meta.scope ||= 'user';
  if (meta.targets == null) meta.targets = ['*'];
  if (!Array.isArray(meta.targets)) meta.targets = [meta.targets];
  meta.weight = typeof meta.weight === 'number' ? meta.weight : 50;
  return { meta, body: preserveBody ? text.slice(m[0].length) : text.slice(m[0].length).trim() };
}

/** minimal glob (* ** ?), used for when-conditions */
function globToRegExp(pat) {
  let re = '';
  let i = 0;
  while (i < pat.length) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pat[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

/** does the project dir contain a file matching a pattern?
 *  (shallow walk, skipping .git/node_modules) */
function projectMatches(dir, patterns) {
  const pats = Array.isArray(patterns) ? patterns : [patterns];
  const regexes = pats.map(globToRegExp);
  const skip = new Set(['.git', 'node_modules', '.venv', 'venv', 'target', 'dist']);
  const walk = (d, depth) => {
    if (depth > 5) return false;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const rel = path.relative(dir, path.join(d, e.name));
      if (regexes.some((r) => r.test(rel) || r.test(e.name))) return true;
      if (e.isDirectory() && walk(path.join(d, e.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(dir, 0);
}

/** line-level diff (LCS, fine for document-sized files) */
function diffLines(oldText, newText) {
  const A = oldText.split('\n');
  const B = newText.split('\n');
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: '-', line: A[i++] });
    } else {
      out.push({ op: '+', line: B[j++] });
    }
  }
  while (i < n) out.push({ op: '-', line: A[i++] });
  while (j < m) out.push({ op: '+', line: B[j++] });
  return out;
}

function showDiff(diffs, max = 30) {
  let shown = 0;
  for (const d of diffs) {
    if (d.line.trim() === '') continue;
    console.log(`  ${d.op} ${d.line}`);
    if (++shown >= max) {
      console.log('  …(truncated)');
      break;
    }
  }
  if (shown === 0) console.log('  (whitespace-only changes)');
}

// ---------------------------------------------------------------- init

const PROBE_PROXY = `#!/bin/sh
# probe: proxy egress
echo '## Network & proxies'
for f in "$HOME/proxy" "$HOME/proxy-us"; do
  if [ -f "$f" ]; then
    server=$(grep -m1 -oE 'https?://[^ "'"'"']+' "$f" | head -1)
    server=$(printf '%s\n' "$server" | sed -E 's#(https?://)[^/@]+@#\\1<redacted>@#')
    echo "- source $f -> $server"
  else
    echo "- $f not found"
  fi
done
[ -n "$no_proxy" ] && echo "- no_proxy is set (matching domains go direct)"
exit 0
`;

const PROBE_TOOLCHAIN = `#!/bin/sh
# probe: toolchain versions and flavors (always check, never assume)
echo '## Toolchain'
for t in node npm bun python3 uv git; do
  p=$(command -v $t 2>/dev/null) || { echo "- $t: not installed"; continue; }
  v=$($t --version 2>/dev/null | head -1)
  echo "- $t: $v ($p)"
done
if command -v yq >/dev/null 2>&1; then
  yq --version 2>/dev/null | grep -qi mikefarah && echo "- yq: mikefarah flavor (yq -i keeps comments)" || echo "- yq: kislyuk flavor (jq wrapper, yq -y)"
fi
exit 0
`;

const PROBE_PORTS = `#!/bin/sh
# probe: who listens on the ports we care about
echo '## Ports in use'
for port in 8000 8001 8787 8788 9889; do
  line=$(ss -tlnp 2>/dev/null | grep -E "[:.]$port " | head -1)
  [ -n "$line" ] && echo "- $port: $(echo "$line" | sed 's/.*users:(("//' | cut -d'"' -f1 | head -1) ($(echo $line | awk '{print $4}'))"
done
[ -z "$(command -v ss)" ] && echo "- ss unavailable, skipped"
exit 0
`;

const BLOCK_GIT = `---
id: git-discipline
scope: user
targets: ["*"]
weight: 20
---
## Git discipline

- Commit only the files this session touched; never \`git add -A\` — the working
  tree often mixes changes from several sessions
- Local commits by default; never push unless explicitly asked
- Glance at \`git status\` before committing; in repos shared across sessions,
  make sure your changes were not already committed by another session
`;

const BLOCK_DOCS = `---
id: docs-ssot
scope: user
targets: ["*"]
weight: 10
---
## Single source of truth

- The usual docs (sites / ops manuals / runbooks) are the single source of
  truth: read the relevant doc before acting; never rely on memory
- Any agent can take any job at any time: context is assembled and distributed
  uniformly, not tied to one particular agent
- When docs and reality disagree, reality wins — then fix the doc
`;

const BLOCK_PY = `---
id: python-conventions
scope: project
targets: ["*"]
when: ["pyproject.toml", "setup.py", "requirements*.txt"]
weight: 30
---
## Python project conventions

- Prefer the project virtual environment; installs go through uv pip / pip -e
- Edit YAML configs with ruamel.yaml round-trip to keep comments; never
  overwrite with PyYAML dump
- Run ruff check and the project's own tests before committing
`;

const BLOCK_PROTOCOL = `---
id: context-protocol
scope: user
targets: ["*"]
weight: 5
---
## Context protocol (this file is generated by groundfact)

- This file is generated: edit ~/.groundfact/blocks/ and probes.d/, not this
  file; \`groundfact check\` reports any drift
- The machine-profile section is probed: after installing tools or changing
  the network, run \`groundfact probe && groundfact build\`
- Before starting work on this machine, run \`groundfact check\` and resolve
  what it reports
`;

function cmdInit() {
  if (exists(ROOT)) die(`${ROOT} already exists; back it up and remove it to re-init`);
  for (const d of ['probes.d', 'facts', 'blocks/user', 'blocks/adopted', 'blocks/project', 'last']) {
    mkdirp(path.join(ROOT, d));
  }
  const probes = { 'proxy.sh': PROBE_PROXY, 'toolchain.sh': PROBE_TOOLCHAIN, 'ports.sh': PROBE_PORTS };
  for (const [name, body] of Object.entries(probes)) {
    const f = path.join(ROOT, 'probes.d', name);
    fs.writeFileSync(f, body);
    fs.chmodSync(f, 0o755);
  }
  fs.writeFileSync(path.join(ROOT, 'blocks/user/git-discipline.md'), BLOCK_GIT);
  fs.writeFileSync(path.join(ROOT, 'blocks/user/docs-ssot.md'), BLOCK_DOCS);
  fs.writeFileSync(path.join(ROOT, 'blocks/user/context-protocol.md'), BLOCK_PROTOCOL);
  fs.writeFileSync(path.join(ROOT, 'blocks/project/python-conventions.md'), BLOCK_PY);
  fs.writeFileSync(
    path.join(ROOT, 'groundfact.json'),
    JSON.stringify(
      {
        targets: {
          claudecode: '~/.claude/CLAUDE.md',
          codexcli: '~/.codex/AGENTS.md',
          gemini: '~/.gemini/GEMINI.md',
          pi: '~/.pi/agent/AGENTS.md',
        },
        projectIncludes: ['project'],
        projectFileName: 'AGENTS.md',
      },
      null,
      2,
    ) + '\n',
  );
  log(`initialized ${ROOT}`);
  log('next: groundfact probe && groundfact build');
}

// ---------------------------------------------------------------- probe

/** runs every probe once; returns per-probe results */
function runProbes() {
  const dir = path.join(ROOT, 'probes.d');
  if (!exists(dir)) die('probes.d missing; run groundfact init first');
  const probes = fs.readdirSync(dir).filter((f) => f.endsWith('.sh')).sort();
  if (!probes.length) die('no probes in probes.d');
  const results = [];
  const failed = [];
  for (const p of probes) {
    const r = spawnSync('/bin/sh', [path.join(dir, p)], { encoding: 'utf8', timeout: 30_000 });
    if (r.error || r.status !== 0) {
      failed.push(`${p} (exit ${r.status ?? r.error})`);
      continue;
    }
    results.push({ name: p, out: (r.stdout || '').trim() });
  }
  return { results, failed };
}

function cmdProbe(opts = {}) {
  const a = runProbes();
  let b = null;
  let volatile = false;
  if (opts.verify && !a.failed.length) {
    // determinism check: a probe whose output differs between two runs with
    // no machine change would cry wolf on every probe — a probe bug, not drift
    b = runProbes();
    for (const r of a.results) {
      const again = b.results.find((x) => x.name === r.name);
      if (again && again.out !== r.out) {
        log(`✗ volatile probe: ${r.name} — output differs between back-to-back runs; emit stable facts only (no timestamps, no unordered listings)`);
        volatile = true;
      }
    }
  }
  const failed = [...new Set([...a.failed, ...(b?.failed || [])])];
  if (failed.length) {
    log(`probes failed: ${failed.join(', ')}`);
    log('machine profile not updated');
    process.exitCode = 1;
    return;
  }
  if (opts.verify && volatile) {
    process.exitCode = 1;
    return;
  }
  if (opts.verify) log('all probes deterministic (two consecutive runs identical)');
  const sections = a.results
    .filter((r) => r.out)
    .map((r) => `<!-- groundfact:probe id=${r.name.replace(/\.sh$/, '')} -->\n${r.out}`);
  const now = new Date().toISOString();
  const content =
    [
      `${GENERATED_MARK} version=${VERSION} at=${now} type=probe -->`,
      '',
      '# Machine profile (probe-generated; do not edit — re-run probe when the machine changes)',
      '',
      ...sections.join('\n\n').split('\n'),
      '',
    ].join('\n') + '\n';

  const factFile = path.join(ROOT, 'facts/machine.md');
  const prevFile = path.join(ROOT, 'facts/machine.prev.md');
  const prev = readIf(factFile);
  if (prev != null) fs.writeFileSync(prevFile, prev);
  fs.writeFileSync(factFile, content);

  if (prev == null) {
    log(`initial profile generated (${a.results.length} probes): facts/machine.md`);
  } else {
    const diffs = diffLines(prev, content).filter((d) => d.line.trim() && !/groundfact:generated/.test(d.line));
    if (!diffs.length) {
      log('no machine changes');
    } else {
      log(`⚠ machine facts changed (${diffs.length} lines):`);
      showDiff(diffs);
      log('(the change is in the machine itself; re-run groundfact build to distribute)');
    }
  }
}

// ---------------------------------------------------------------- collect blocks

function collectBlocks() {
  const blocks = [];
  // blocks/adopted holds mechanically adopted sections; they behave as user scope
  for (const [dirName, scope] of [['user', 'user'], ['adopted', 'user'], ['project', 'project']]) {
    const dir = path.join(ROOT, 'blocks', dirName);
    if (!exists(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      const text = readIf(path.join(dir, f));
      if (text == null) continue;
      const { meta, body } = parseFrontmatter(text, f.replace(/\.md$/, ''), dirName === 'adopted');
      if (meta.scope !== scope) meta.scope = scope; // the directory decides scope; guard against typos
      blocks.push({ ...meta, body, file: path.join(dir, f) });
    }
  }
  // the machine profile is the first pseudo-block
  const facts = readIf(path.join(ROOT, 'facts/machine.md'));
  if (facts != null) {
    const body = facts.replace(/^<!-- groundfact:generated[^\n]*-->\n?/, '').trim();
    blocks.push({ id: 'machine', scope: 'machine', targets: ['*'], weight: -100, body });
  }
  return blocks;
}

const targetHit = (meta, name) => meta.targets.includes('*') || meta.targets.includes(name);

/** target config value: "path" or {path, machine} — machine:false keeps a target
 *  adopted-content-only during migration, so probe facts and adopted sections
 *  do not land twice in the same file */
const targetSpec = (v) =>
  typeof v === 'string' ? { path: v, machine: true } : { path: v.path, machine: v.machine !== false };

/** render one target file's content */
function render(blocks, targetName) {
  const parts = [
    `${GENERATED_MARK} version=${VERSION} target=${targetName} -->`,
    '<!-- generated by groundfact: edit blocks/ and probes.d/, then re-run build; hand edits will be flagged as drift by check -->',
    '',
  ];
  for (const b of blocks) {
    parts.push(`<!-- groundfact:begin id=${b.id} sha=${sha(b.body)} -->`);
    parts.push(b.body);
    parts.push(`<!-- groundfact:end id=${b.id} -->`);
    parts.push('');
  }
  return parts.join('\n') + '\n';
}

function selectedFor(blocks, { projectDir = null, includes }) {
  return blocks
    .filter((b) => includes.includes(b.scope))
    .filter((b) => !projectDir || b.scope !== 'project' || !b.when || projectMatches(projectDir, b.when))
    .sort((a, b) => a.weight - b.weight || String(a.id).localeCompare(String(b.id)));
}

// ---------------------------------------------------------------- build

function writeManaged(filePath, content, label, opts) {
  const prev = readIf(filePath);
  if (prev != null && !isManagedContent(prev)) {
    if (!opts.force) {
      log(`skip ${label}: ${filePath} exists and was not generated by groundfact (adopt with --force; a .groundfact-orig backup is made first)`);
      return false;
    }
    fs.writeFileSync(filePath + '.groundfact-orig', prev);
    log(`backed up original → ${filePath}.groundfact-orig`);
  }
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
  return true;
}

function cmdBuild(opts) {
  const cfg = loadConfig();
  const blocks = collectBlocks();
  if (!blocks.some((b) => b.id === 'machine')) log('(note: no machine profile yet; run groundfact probe)');
  const state = loadState();
  let wrote = 0;
  let pruned = 0;

  if (opts.project) {
    const projectDir = path.resolve(opts.project);
    if (!exists(projectDir)) die(`project directory does not exist: ${projectDir}`);
    const includes = cfg.projectIncludes || ['project'];
    const sel = selectedFor(blocks, { projectDir, includes });
    const fileName = cfg.projectFileName || 'AGENTS.md';
    const out = path.join(projectDir, fileName);
    const key = `project:${projectDir}`;
    if (!sel.length) {
      const candidates = new Set([out, state.targets[key]?.path].filter(Boolean));
      const stale = [...candidates].filter((filePath) => {
        const previous = readIf(filePath);
        return previous != null && isManagedContent(previous);
      });
      if (stale.length) {
        for (const filePath of stale) {
          fs.unlinkSync(filePath);
          pruned++;
          log(`pruned project ${projectDir}: no matching blocks → ${filePath}`);
        }
      } else {
        log(`skip project ${projectDir}: no matching blocks (no when-condition hit)`);
      }
      delete state.targets[key];
      const snapshot = snapFile(key);
      if (exists(snapshot)) fs.unlinkSync(snapshot);
    } else if (writeManaged(out, render(sel, key), `project ${projectDir}`, opts)) {
      state.targets[key] = { path: out, builtAt: new Date().toISOString(), sha256: sha(sel.map((b) => b.id).join()) };
      saveSnapshot(key, render(sel, key));
      wrote++;
      log(`project assembly → ${out} (${sel.length} block(s))`);
      for (const b of sel) log(`  - ${b.id}${b.when ? ' (when matched)' : ''}`);
    }
  } else if (opts.rulesync) {
    const rsDir = path.resolve(opts.rulesync);
    mkdirp(path.join(rsDir, 'rules'));
    const sel = selectedFor(blocks, { includes: ['machine', 'user'] });
    const desiredRules = new Set(sel.map((b) => `${b.id}.md`));
    for (const b of sel) {
      const fm = [
        '---',
        'root: true',
        `description: ${b.id} (groundfact)`,
        b.targets.includes('*') ? 'targets: ["*"]' : `targets: ${JSON.stringify(b.targets)}`,
        '---',
      ].join('\n');
      const content = `${fm}\n${GENERATED_MARK} version=${VERSION} target=rulesync:${b.id} -->\n\n${b.body}\n`;
      if (writeManaged(path.join(rsDir, 'rules', `${b.id}.md`), content, `rulesync ${b.id}`, opts)) wrote++;
    }
    for (const fileName of fs.readdirSync(path.join(rsDir, 'rules')).filter((name) => name.endsWith('.md'))) {
      if (desiredRules.has(fileName)) continue;
      const filePath = path.join(rsDir, 'rules', fileName);
      const previous = readIf(filePath);
      if (previous == null || !isManagedContent(previous)) continue;
      fs.unlinkSync(filePath);
      pruned++;
      log(`pruned stale rulesync rule → ${filePath}`);
    }
    // also ship the agent recipe as a rulesync skill, so rulesync can fan it
    // out to every agent's skill directory alongside the rules
    const skillSrc = readIf(path.join(__dirname, '..', 'SKILL.md'));
    if (skillSrc) {
      const skillDir = path.join(rsDir, 'skills', 'groundfact');
      mkdirp(skillDir);
      const skillFile = path.join(skillDir, 'SKILL.md');
      const content = `---\nname: groundfact\ndescription: Turn hand-written machine facts into probes; drift governance for agent context files\n---\n${GENERATED_MARK} version=${VERSION} target=rulesync:skill -->\n\n${skillSrc}`;
      if (writeManaged(skillFile, content, 'rulesync skill', opts)) {
        wrote++;
        log('skill emitted → skills/groundfact/SKILL.md (rulesync fans it out with the rules)');
      }
    }
    log(`rulesync sources processed in ${rsDir}/rules/ (${sel.length} block(s)) → run rulesync generate there to fan out`);
  } else {
    const entries = Object.entries(cfg.targets || {});
    if (!entries.length) die('no targets configured in groundfact.json');
    for (const [name, rel] of entries) {
      const spec = targetSpec(rel);
      const out = expandTilde(spec.path);
      const sel = selectedFor(blocks, { includes: ['machine', 'user'] })
        .filter((b) => (spec.machine ? true : b.scope !== 'machine'))
        .filter((b) => targetHit(b, name));
      if (!sel.length) {
        log(`skip ${name}: no matching blocks`);
        continue;
      }
      const content = render(sel, name);
      if (writeManaged(out, content, name, opts)) {
        state.targets[name] = { path: out, builtAt: new Date().toISOString(), sha256: sha(content) };
        saveSnapshot(name, content);
        wrote++;
        log(`${name} → ${out} (${sel.length} block(s): ${sel.map((b) => b.id).join(', ')})${spec.machine ? '' : ' [machine facts off]'}`);
      }
    }
  }
  state.builtAt = new Date().toISOString();
  saveState(state);
  log(wrote || pruned ? `done, ${wrote} file(s) written, ${pruned} stale file(s) pruned. drift governance: groundfact check` : 'no files written.');
}

// ---------------------------------------------------------------- adopt

function splitAdoptedSections(text) {
  const lines = [];
  const linePattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match;
  while ((match = linePattern.exec(text)) && match[0]) {
    lines.push({ text: match[1], start: match.index });
  }
  const sections = [];
  let start = 0;
  let title = null;
  let fence = null;
  const push = (end) => {
    if (end > start) sections.push({ title, text: text.slice(start, end) });
  };
  for (const line of lines) {
    if (fence) {
      const closing = line.text.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = line.text.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = { char: opening[1][0], length: opening[1].length };
      continue;
    }
    if (/^##[ \t]+/.test(line.text)) {
      push(line.start);
      start = line.start;
      title = line.text.replace(/^##[ \t]+/, '').trim();
    }
  }
  push(text.length);
  return sections;
}

/** mechanically adopt an existing hand-written file: split at ## headings,
 *  content kept verbatim, no semantics — LLM-free by design. The
 *  fact/principle classification is deliberately deferred: everything starts
 *  as a user block, and sections can be turned into probes one by one. */
function cmdAdopt(fileArg, opts) {
  if (!fileArg) die('usage: groundfact adopt <file>');
  const src = path.resolve(fileArg);
  const text = readIf(src);
  if (text == null) die(`cannot read ${src}`);
  if (isManagedContent(text)) die(`${src} is already groundfact-generated; nothing to adopt`);
  const cfg = loadConfig();
  const outDir = path.join(ROOT, 'blocks/adopted');
  mkdirp(outDir);

  const sections = splitAdoptedSections(text);
  if (!sections.some((section) => section.text.trim())) die('no non-empty sections found');

  const existing = new Set(fs.readdirSync(outDir).map((f) => f.replace(/\.md$/, '')));
  let wrote = 0;
  sections.forEach((sec, i) => {
    const slug = String(sec.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    let id = `adopt-${slug || `sec-${String(i + 1).padStart(2, '0')}`}`;
    while (existing.has(id)) id += '-2';
    existing.add(id);
    const file = path.join(outDir, `${id}.md`);
    if (exists(file) && !opts.force) {
      log(`skip ${id}: ${file} exists (--force to overwrite)`);
      return;
    }
    const fm = [
      '---',
      `id: ${id}`,
      'scope: user',
      'targets: ["*"]',
      `weight: ${100 + i}`,
      `title: ${JSON.stringify(sec.title ?? '(preamble)')}`,
      `adopted-from: ${JSON.stringify(src)}`,
      '---',
    ].join('\n');
    fs.writeFileSync(file, `${fm}\n${sec.text}`);
    wrote++;
    log(`  ${id} ← ${JSON.stringify(sec.title ?? '(preamble)')}`);
  });

  // if the source is itself a configured target, say what build --force will do
  const hit = Object.entries(cfg.targets || {}).find(([, v]) => {
    const p = expandTilde(typeof v === 'string' ? v : v.path);
    return p === src;
  });
  if (hit) {
    log(`note: ${src} is the "${hit[0]}" target — build --force takes it over (backup: .groundfact-orig)`);
    log('  the machine profile lands in every target by default; to keep this target');
    log('  adopted-content-only during migration, set {"path": "...", "machine": false} in groundfact.json');
  }
  log(`adopted ${wrote} section(s) into blocks/adopted/ (verbatim, scope=user)`);
  log('next: groundfact build --force, then migrate sections into probes one by one (groundfact migrate <id>)');
}

// ---------------------------------------------------------------- migrate

/** turn an adopted block into a frozen probe: the probe echoes the block's
 *  text verbatim, so the hand-written fact becomes the test oracle. An agent
 *  (or human) then replaces the echo with real detection and iterates until
 *  `probe` shows no diff — the LLM does the one-time semantic translation,
 *  the shell keeps the forever job. See SKILL.md. */
function cmdMigrate(idArg, opts) {
  if (!idArg) die('usage: groundfact migrate <block-id>');
  const id = idArg.replace(/\.md$/, '');
  const blockFile = path.join(ROOT, 'blocks/adopted', `${id}.md`);
  const text = readIf(blockFile);
  if (text == null) die(`no adopted block ${blockFile} (migrate applies to blocks/adopted/ only)`);
  const { body } = parseFrontmatter(text, id, true);
  const probeFile = path.join(ROOT, 'probes.d', `${id}.sh`);
  if (exists(probeFile) && !opts.force) die(`${probeFile} exists (--force to overwrite)`);
  let delimiter = 'GROUNDFACT_ORACLE';
  const bodyLines = new Set(body.split(/\r?\n/));
  while (bodyLines.has(delimiter)) delimiter += '_';
  const probe = [
    '#!/bin/sh',
    `# frozen probe — generated by groundfact migrate from blocks/adopted/${id}.md`,
    '# It echoes the adopted text verbatim: that text is the ORACLE, the ground',
    '# truth as the human wrote it. Replace the heredoc with real detection;',
    '# the output must stay byte-stable unless reality changed. See SKILL.md.',
    `cat <<'${delimiter}'`,
    body,
    delimiter,
    'exit 0',
    '',
  ].join('\n');
  mkdirp(path.join(ROOT, 'probes.d'));
  fs.writeFileSync(probeFile, probe);
  fs.chmodSync(probeFile, 0o755);
  log(`frozen probe created: probes.d/${id}.sh (echoes the adopted text — your oracle)`);
  log('migration loop, for an agent or a human:');
  log('  1. edit the probe: real detection instead of the heredoc');
  log('     (probeable → detect it; policy → keep the words; history → drop it)');
  log('  2. groundfact probe          — the diff vs the oracle must be empty or explained');
  log('  3. groundfact probe --verify — determinism must pass');
  log(`  4. rm blocks/adopted/${id}.md && groundfact build && groundfact check`);
  log('note: a migrated section reaches targets through the machine profile;');
  log('targets set to machine:false will no longer receive it once the block is gone');
}

// ---------------------------------------------------------------- state / snapshot

const stateFile = () => path.join(ROOT, 'facts/state.json');
function loadState() {
  return JSON.parse(readIf(stateFile()) || '{"targets":{}}');
}
function saveState(st) {
  mkdirp(path.dirname(stateFile()));
  fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2) + '\n');
}
function snapFile(key) {
  return path.join(ROOT, 'last', key.replace(/[^A-Za-z0-9._-]/g, '_') + '.md');
}
function saveSnapshot(key, content) {
  mkdirp(path.join(ROOT, 'last'));
  fs.writeFileSync(snapFile(key), content);
}

// ---------------------------------------------------------------- list

function cmdList(opts) {
  const cfg = loadConfig();
  const blocks = collectBlocks();
  const projectDir = opts.project ? path.resolve(opts.project) : null;
  const includes = projectDir ? cfg.projectIncludes || ['project'] : ['machine', 'user'];
  const sel = selectedFor(blocks, { projectDir, includes });
  if (projectDir) {
    log(`assembly preview for project ${projectDir}:`);
    for (const b of sel) log(`  - ${b.id} [${b.scope}] w=${b.weight}${b.when ? ` when=${JSON.stringify(b.when)}` : ''}`);
    return;
  }
  for (const [name, rel] of Object.entries(cfg.targets || {})) {
    const spec = targetSpec(rel);
    const mine = sel
      .filter((b) => (spec.machine ? true : b.scope !== 'machine'))
      .filter((b) => targetHit(b, name));
    log(`${name}: ${mine.map((b) => b.id).join(', ') || '(empty)'}`);
  }
}

// ---------------------------------------------------------------- check

function cmdCheck() {
  const cfg = loadConfig();
  const blocks = collectBlocks();
  const state = loadState();
  let drift = 0;

  // machine profile freshness
  const stat = (() => {
    try {
      return fs.statSync(path.join(ROOT, 'facts/machine.md'));
    } catch {
      return null;
    }
  })();
  if (!stat) log('⚠ no machine profile yet (groundfact probe)');
  else if (Date.now() - stat.mtimeMs > 7 * DAY_MS) log(`⚠ machine profile is ${Math.round((Date.now() - stat.mtimeMs) / DAY_MS)} days old; re-run probe`);

  const entries = new Map(Object.entries(state.targets || {}));
  for (const [name] of Object.entries(cfg.targets || {})) if (!entries.has(name)) entries.set(name, null);

  for (const [key, rec] of entries) {
    if (rec == null && cfg.targets[key] == null) continue; // stale state entry with no config
    const spec = cfg.targets[key] != null ? targetSpec(cfg.targets[key]) : null;
    const filePath = rec ? rec.path : spec ? expandTilde(spec.path) : null;
    const disk = readIf(filePath);
    if (disk == null) {
      log(`✗ ${key}: target file missing (${filePath})`);
      drift++;
      continue;
    }
    if (!disk.startsWith(GENERATED_MARK)) {
      log(`? ${key}: file was not generated by groundfact (hand-written, not managed)`);
      continue;
    }
    // expected content, recomputed from current sources
    let expected;
    if (key.startsWith('project:')) {
      const projectDir = key.slice('project:'.length);
      const includes = cfg.projectIncludes || ['project'];
      expected = render(selectedFor(blocks, { projectDir, includes }), key);
    } else {
      const sel = selectedFor(blocks, { includes: ['machine', 'user'] })
        .filter((b) => (spec && spec.machine ? true : b.scope !== 'machine'))
        .filter((b) => targetHit(b, key));
      expected = render(sel, key);
    }
    const snap = readIf(snapFile(key));
    if (disk === expected) {
      log(`✓ ${key}: no drift`);
      continue;
    }
    drift++;
    if (snap != null && disk === snap) {
      log(`△ ${key}: sources updated but not rebuilt (stale generation)`);
      showDiff(diffLines(disk, expected));
      log('  → groundfact build');
    } else {
      log(`△ ${key}: hand-edit drift (disk ≠ last generation)`);
      showDiff(diffLines(snap ?? disk, disk));
      if (snap != null && expected !== snap) log('  (sources changed too; build will pick both up)');
      log('  → keep the edits: move them into blocks/ then build; discard them: just build');
    }
  }
  process.exitCode = drift ? 1 : 0;
  log(drift ? `${drift} drift(s) found` : 'all in sync');
}

// ---------------------------------------------------------------- MCP server

const TOOLS = [
  {
    name: 'groundfact_check',
    description: 'Drift report for every managed agent context file: hand edits vs stale sources, machine-profile freshness.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'groundfact_probe',
    description: 'Run probes and refresh the machine profile; reports environment changes since the last run. verify=true double-runs for determinism.',
    inputSchema: {
      type: 'object',
      properties: { verify: { type: 'boolean', description: 'fail on non-deterministic probes' } },
      additionalProperties: false,
    },
  },
  {
    name: 'groundfact_build',
    description: 'Assemble blocks and the machine profile into the configured targets. Omit project/rulesync for the global build.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, rulesync: { type: 'string' }, force: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'groundfact_list',
    description: 'Preview which blocks land in each target (or in one project).',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'groundfact_adopt',
    description: 'Mechanically adopt a hand-written context file: split at ## headings into blocks/adopted/, verbatim.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' }, force: { type: 'boolean' } },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: 'groundfact_migrate',
    description: 'Turn an adopted block into a frozen probe (the hand-written text becomes the test oracle). Follow SKILL.md for the migration loop.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, force: { type: 'boolean' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

/** run one CLI command with its console output captured as the tool result */
function runTool(name, args) {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.map(String).join(' '));
  const prevCode = process.exitCode;
  process.exitCode = 0;
  try {
    if (name === 'groundfact_probe') cmdProbe({ verify: !!args.verify });
    else if (name === 'groundfact_check') cmdCheck();
    else if (name === 'groundfact_build') cmdBuild({ project: args.project ?? null, rulesync: args.rulesync ?? null, force: !!args.force });
    else if (name === 'groundfact_list') cmdList({ project: args.project ?? null });
    else if (name === 'groundfact_adopt') cmdAdopt(args.file, { force: !!args.force });
    else if (name === 'groundfact_migrate') cmdMigrate(args.id, { force: !!args.force });
    else throw new Error(`unknown tool: ${name}`);
    if (process.exitCode) lines.push(`(exit code ${process.exitCode})`);
  } catch (e) {
    lines.push(`error: ${e.message}`);
  } finally {
    console.log = origLog;
    process.exitCode = prevCode ?? 0;
  }
  return lines.join('\n') || '(no output)';
}

/** MCP server over stdio (newline-delimited JSON-RPC): the same CLI behind a
 *  typed-tools facade for MCP-capable clients:
 *    claude mcp add groundfact -- node /path/to/bin/groundfact.mjs mcp */
function cmdMcp() {
  IN_MCP = true;
  const rl = readline.createInterface({ input: process.stdin });
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id == null) return; // notifications (initialized, cancelled, …)
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'groundfact', version: VERSION },
        } });
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      } else if (method === 'tools/call') {
        const out = runTool(params?.name, params?.arguments || {});
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }], isError: out.startsWith('error:') } });
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e.message || e) } });
    }
  });
}

// ---------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
const opts = { force: rest.includes('--force') };
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : null;
};
if (opts.force) {
  const i = rest.indexOf('--force');
  rest.splice(i, 1);
}
opts.project = flag('--project');
opts.rulesync = flag('--rulesync');
opts.verify = rest.includes('--verify');

switch (cmd) {
  case 'init':
    cmdInit();
    break;
  case 'probe':
    cmdProbe(opts);
    break;
  case 'adopt':
    cmdAdopt(rest.find((a) => !a.startsWith('--')), opts);
    break;
  case 'migrate':
    cmdMigrate(rest.find((a) => !a.startsWith('--')), opts);
    break;
  case 'build':
    cmdBuild(opts);
    break;
  case 'list':
    cmdList(opts);
    break;
  case 'check':
    cmdCheck();
    break;
  case 'version':
    log(`groundfact ${VERSION}`);
    break;
  case 'mcp':
    cmdMcp();
    break;
  default:
    log(`groundfact ${VERSION} — an upstream facts compiler for agent context

usage:
  groundfact init                initialize ~/.groundfact
  groundfact probe               probes → machine profile; diff reports changes
  groundfact probe --verify      run probes twice; flag non-deterministic output
  groundfact adopt <file>        mechanically adopt a hand-written file: split at
                               ## headings into blocks/adopted/ (verbatim, no LLM)
  groundfact migrate <id>        turn an adopted block into a frozen probe: the
                               hand-written text becomes the test oracle (SKILL.md)
  groundfact build               global assembly → each agent's global file
  groundfact build --project D   project assembly (when conditions) → D/AGENTS.md
  groundfact build --rulesync D  emit rulesync sources (D/rules/*.md)
  groundfact list [--project D]  preview which blocks land in each target
  groundfact check               drift detection (hand edits vs stale sources);
                               exit code 1 on drift
  groundfact mcp                 run as an MCP server over stdio (typed tools
                               for MCP-capable agents; see README)
options: --force adopts an existing hand-written file (backs up .groundfact-orig first)`);
}
