import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/groundfact.mjs', import.meta.url));

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function assertExit(result, expected = 0) {
  assert.equal(
    result.status,
    expected,
    `exit ${result.status}, expected ${expected}\n${result.error?.message || ''}\n${result.stdout || ''}\n${result.stderr || ''}`,
  );
}

function makeFixture(t, { stableProbes = true } = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'groundfact-test-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(home);
  const run = (args, options = {}) => {
    const { env: extraEnv = {}, ...rest } = options;
    return spawnSync(process.execPath, [CLI, ...args], {
      ...rest,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, ...extraEnv },
    });
  };
  assertExit(run(['init']));
  const root = path.join(home, '.groundfact');
  if (stableProbes) {
    for (const name of fs.readdirSync(path.join(root, 'probes.d'))) {
      write(path.join(root, 'probes.d', name), `#!/bin/sh\necho '## ${name}'\necho '- stable fact'\nexit 0\n`);
    }
  }
  const configFile = path.join(root, 'groundfact.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.targets = { alpha: '~/context/AGENTS.md' };
  write(configFile, JSON.stringify(config, null, 2));
  return { sandbox, home, root, run };
}

function adoptedBodies(root) {
  const directory = path.join(root, 'blocks/adopted');
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const text = fs.readFileSync(path.join(directory, name), 'utf8');
      const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
      assert.ok(frontmatter, `${name} has frontmatter`);
      return { name, weight: Number(text.match(/^weight: (\d+)$/m)[1]), body: text.slice(frontmatter[0].length) };
    })
    .sort((a, b) => a.weight - b.weight);
}

test('build and check recover from hand edits and stale sources', (t) => {
  const fixture = makeFixture(t);
  const target = path.join(fixture.home, 'context/AGENTS.md');
  assertExit(fixture.run(['probe', '--verify']));
  assertExit(fixture.run(['build']));
  assertExit(fixture.run(['check']));

  fs.appendFileSync(target, '\nmanual edit\n');
  assert.match(fixture.run(['check']).stdout, /hand-edit drift/);
  assertExit(fixture.run(['build']));
  assertExit(fixture.run(['check']));

  fs.appendFileSync(path.join(fixture.root, 'blocks/user/docs-ssot.md'), '\nSource update.\n');
  const stale = fixture.run(['check']);
  assertExit(stale, 1);
  assert.match(stale.stdout, /stale generation/);
  assertExit(fixture.run(['build']));
  assertExit(fixture.run(['check']));
});

test('failed probes preserve the profile and previous snapshot', (t) => {
  const fixture = makeFixture(t);
  assertExit(fixture.run(['probe']));
  assertExit(fixture.run(['probe']));
  const factsFile = path.join(fixture.root, 'facts/machine.md');
  const previousFile = path.join(fixture.root, 'facts/machine.prev.md');
  const facts = fs.readFileSync(factsFile);
  const previous = fs.readFileSync(previousFile);
  write(path.join(fixture.root, 'probes.d/ports.sh'), '#!/bin/sh\necho "partial output"\nexit 42\n');

  for (const args of [['probe'], ['probe', '--verify']]) {
    const result = fixture.run(args);
    assertExit(result, 1);
    assert.match(result.stdout, /probes failed: ports\.sh/);
    assert.match(result.stdout, /machine profile not updated/);
    assert.doesNotMatch(result.stdout, /all probes deterministic/);
    assert.deepEqual(fs.readFileSync(factsFile), facts);
    assert.deepEqual(fs.readFileSync(previousFile), previous);
  }
});

test('verify rejects a probe that fails on its second run', (t) => {
  const fixture = makeFixture(t);
  assertExit(fixture.run(['probe']));
  const factsFile = path.join(fixture.root, 'facts/machine.md');
  const facts = fs.readFileSync(factsFile);
  write(path.join(fixture.root, 'probes.d/ports.sh'), `#!/bin/sh
counter="$HOME/.groundfact/verify-count"
count=0
[ ! -f "$counter" ] || count=$(cat "$counter")
count=$((count+1))
echo "$count" > "$counter"
[ "$count" -eq 1 ] || exit 9
echo '## ports.sh'
echo '- stable fact'
exit 0
`);
  const result = fixture.run(['probe', '--verify']);
  assertExit(result, 1);
  assert.match(result.stdout, /probes failed: ports\.sh/);
  assert.doesNotMatch(result.stdout, /all probes deterministic/);
  assert.deepEqual(fs.readFileSync(factsFile), facts);
});

test('verify rejects volatile output without writing the profile', (t) => {
  const fixture = makeFixture(t);
  assertExit(fixture.run(['probe']));
  const factsFile = path.join(fixture.root, 'facts/machine.md');
  const facts = fs.readFileSync(factsFile);
  write(path.join(fixture.root, 'probes.d/ports.sh'), `#!/bin/sh
counter="$HOME/.groundfact/volatile-count"
count=0
[ ! -f "$counter" ] || count=$(cat "$counter")
count=$((count+1))
echo "$count" > "$counter"
echo "run $count"
exit 0
`);
  const result = fixture.run(['probe', '--verify']);
  assertExit(result, 1);
  assert.match(result.stdout, /volatile probe: ports\.sh/);
  assert.doesNotMatch(result.stdout, /all probes deterministic/);
  assert.deepEqual(fs.readFileSync(factsFile), facts);
});

test('migrate chooses a heredoc delimiter absent from the adopted body', (t) => {
  const fixture = makeFixture(t);
  const marker = path.join(fixture.sandbox, 'unexpected-command-executed');
  const source = path.join(fixture.sandbox, 'legacy.md');
  write(source, `## Section\nGROUNDFACT_ORACLE\ntouch ${marker}\n`);
  assertExit(fixture.run(['adopt', source]));
  assertExit(fixture.run(['migrate', 'adopt-section']));
  const probe = fs.readFileSync(path.join(fixture.root, 'probes.d/adopt-section.sh'), 'utf8');
  assert.match(probe, /cat <<'GROUNDFACT_ORACLE_'/);
  assertExit(fixture.run(['probe']));
  assert.equal(fs.existsSync(marker), false);
  assert.match(fs.readFileSync(path.join(fixture.root, 'facts/machine.md'), 'utf8'), /touch .*unexpected-command-executed/);
});

test('rulesync protects hand-written rules and skills and force creates backups', (t) => {
  const fixture = makeFixture(t);
  assertExit(fixture.run(['probe']));
  const output = path.join(fixture.sandbox, 'rulesync');
  const rule = path.join(output, 'rules/machine.md');
  const skill = path.join(output, 'skills/groundfact/SKILL.md');
  write(rule, 'HAND WRITTEN RULE\n');
  write(skill, 'HAND WRITTEN SKILL\n');

  assertExit(fixture.run(['build', '--rulesync', output]));
  assert.equal(fs.readFileSync(rule, 'utf8'), 'HAND WRITTEN RULE\n');
  assert.equal(fs.readFileSync(skill, 'utf8'), 'HAND WRITTEN SKILL\n');
  assert.equal(fs.existsSync(`${rule}.groundfact-orig`), false);
  assert.equal(fs.existsSync(`${skill}.groundfact-orig`), false);

  assertExit(fixture.run(['build', '--rulesync', output, '--force']));
  assert.match(fs.readFileSync(rule, 'utf8'), /groundfact:generated/);
  assert.match(fs.readFileSync(skill, 'utf8'), /groundfact:generated/);
  assert.equal(fs.readFileSync(`${rule}.groundfact-orig`, 'utf8'), 'HAND WRITTEN RULE\n');
  assert.equal(fs.readFileSync(`${skill}.groundfact-orig`, 'utf8'), 'HAND WRITTEN SKILL\n');
});

test('rulesync prunes only generated rules whose sources were removed', (t) => {
  const fixture = makeFixture(t);
  assertExit(fixture.run(['probe']));
  const output = path.join(fixture.sandbox, 'rulesync');
  assertExit(fixture.run(['build', '--rulesync', output]));
  const stale = path.join(output, 'rules/docs-ssot.md');
  const handWritten = path.join(output, 'rules/keep.md');
  assert.equal(fs.existsSync(stale), true);
  write(handWritten, 'KEEP ME\n');
  fs.unlinkSync(path.join(fixture.root, 'blocks/user/docs-ssot.md'));
  const result = fixture.run(['build', '--rulesync', output]);
  assertExit(result);
  assert.match(result.stdout, /pruned stale rulesync rule/);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.readFileSync(handWritten, 'utf8'), 'KEEP ME\n');
});

test('project builds prune generated files when no conditions match', (t) => {
  const fixture = makeFixture(t);
  assertExit(fixture.run(['probe']));
  assertExit(fixture.run(['build']));
  const project = path.join(fixture.sandbox, 'project');
  const trait = path.join(project, 'pyproject.toml');
  const generated = path.join(project, 'AGENTS.md');
  write(trait, '[project]\nname="fixture"\n');
  assertExit(fixture.run(['build', '--project', project]));
  assert.equal(fs.existsSync(generated), true);
  const key = `project:${project}`;

  fs.unlinkSync(trait);
  const pruned = fixture.run(['build', '--project', project]);
  assertExit(pruned);
  assert.match(pruned.stdout, /pruned project/);
  assert.equal(fs.existsSync(generated), false);
  assert.equal(fs.existsSync(path.join(fixture.root, 'last', `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.md`)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.root, 'facts/state.json'), 'utf8')).targets[key], undefined);
  assertExit(fixture.run(['check']));

  write(trait, '');
  assertExit(fixture.run(['build', '--project', project]));
  fs.unlinkSync(generated);
  fs.unlinkSync(trait);
  assertExit(fixture.run(['build', '--project', project]));
  assertExit(fixture.run(['check']));

  write(trait, '');
  assertExit(fixture.run(['build', '--project', project]));
  fs.unlinkSync(trait);
  write(generated, 'HAND WRITTEN\n');
  assertExit(fixture.run(['build', '--project', project]));
  assert.equal(fs.readFileSync(generated, 'utf8'), 'HAND WRITTEN\n');
});

test('proxy probes redact URL userinfo before writing facts', (t) => {
  const fixture = makeFixture(t, { stableProbes: false });
  write(path.join(fixture.home, 'proxy'), 'export HTTPS_PROXY="http://alice:s3cr3t@proxy.example.com:8080"\n');
  write(path.join(fixture.home, 'proxy-us'), "export HTTP_PROXY='http://bob:hunter2@us-proxy.example.com:8080/path'\n");
  const result = spawnSync('/bin/sh', [path.join(fixture.root, 'probes.d/proxy.sh')], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fixture.home },
  });
  assertExit(result);
  assert.doesNotMatch(result.stdout, /alice|s3cr3t|bob|hunter2/);
  assert.match(result.stdout, /<redacted>@proxy\.example\.com:8080/);
  assert.match(result.stdout, /<redacted>@us-proxy\.example\.com:8080\/path/);
  assertExit(fixture.run(['probe']));
  const facts = fs.readFileSync(path.join(fixture.root, 'facts/machine.md'), 'utf8');
  assert.doesNotMatch(facts, /alice|s3cr3t|bob|hunter2/);
});

test('adopt ignores fenced headings and preserves every source byte', (t) => {
  const fixture = makeFixture(t);
  const sourceText = '  preamble  \r\n\r\n'
    + '## First\r\n'
    + 'alpha  \r\n'
    + '```sh\r\n'
    + '## inside backticks\r\n'
    + '```\r\n'
    + '~~~~markdown\r\n'
    + '## inside tildes\r\n'
    + '~~~~\r\n'
    + '## Second\n'
    + 'last line with hard break  ';
  const source = path.join(fixture.sandbox, 'legacy.md');
  write(source, sourceText);
  assertExit(fixture.run(['adopt', source]));
  const sections = adoptedBodies(fixture.root);
  assert.deepEqual(sections.map((section) => section.name), [
    'adopt-sec-01.md',
    'adopt-first.md',
    'adopt-second.md',
  ]);
  const reconstructed = Buffer.from(sections.map((section) => section.body).join(''), 'utf8');
  assert.deepEqual(reconstructed, fs.readFileSync(source));
});
