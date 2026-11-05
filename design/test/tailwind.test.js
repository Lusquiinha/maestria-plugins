'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const project = require('../lib/project');
const tailwind = require('../lib/tailwind');

// A node_modules with tailwindcss 3 (the SAC bench checkout has none of its own).
const NM = process.env.DESIGN_TEST_NODE_MODULES
  || path.join(os.homedir(), 'Desktop/Work/Ninepay/customer-service/node_modules');
const have = fs.existsSync(path.join(NM, '.bin', 'tailwindcss'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-tw-'));
const started = [];

test.after(async () => {
  for (const t of started) await t.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let fx = null;
function fixture() {
  if (fx) return fx;
  const repo = path.join(tmp, 'repo');
  const data = path.join(tmp, 'data');
  const content = path.join(tmp, 'content');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(content, { recursive: true });
  fs.symlinkSync(NM, path.join(repo, 'node_modules'));
  fs.writeFileSync(path.join(repo, 'tailwind.config.js'),
    "module.exports = { darkMode: 'class', theme: { extend: { colors: { n: { slate: { 12: 'rgb(var(--slate-12) / <alpha-value>)' } } } } } };\n");
  fs.writeFileSync(path.join(repo, 'vars.scss'), '// c\n@layer base {\n  :root {\n    --slate-12: 28 32 36;\n  }\n  .a .b { color: red; }\n}\n');
  fx = { repo, data, content };
  return fx;
}

test('without tailwind in node_modules detect falls back to the bundled v4', () => {
  const empty = fs.mkdtempSync(path.join(tmp, 'empty-'));
  assert.deepStrictEqual(project.detect(empty), {
    tailwind: { version: 4, bin: null, bundled: true, config: null, input: null }, sass: null,
  });
});

test('usesTailwind: installed, declared, configured or imported counts; nothing else does', () => {
  const mk = (files) => {
    const d = fs.mkdtempSync(path.join(tmp, 'uses-'));
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), body);
    }
    return d;
  };
  assert.strictEqual(project.usesTailwind(mk({})), false);
  assert.strictEqual(project.usesTailwind(mk({ 'package.json': '{"dependencies":{"react":"18"}}', 'src/index.css': 'body{}' })), false);
  assert.strictEqual(project.usesTailwind(mk({ 'node_modules/.bin/tailwindcss': '' })), true);
  assert.strictEqual(project.usesTailwind(mk({ 'package.json': '{"devDependencies":{"tailwindcss":"^4"}}' })), true);
  assert.strictEqual(project.usesTailwind(mk({ 'tailwind.config.js': 'module.exports={}' })), true);
  assert.strictEqual(project.usesTailwind(mk({ 'src/app.css': '@import "tailwindcss";' })), true);
});

test('styling: explicit in design.json, older canvases without it stay on tailwind', () => {
  assert.strictEqual(project.styling({ styling: 'css' }), 'css');
  assert.strictEqual(project.styling({ styling: 'tailwind' }), 'tailwind');
  assert.strictEqual(project.styling({}), 'tailwind');
});

test('the bundled tailwind gets a class-based dark variant and the plain tailwindcss import', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'cache-'));
  const a = { name: 'fake', sha256: 'x', url: 'http://unused' };
  const bin = require('../lib/standalone').binPath(root, a);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\necho "/*css*/" > "$2"\necho "Done in 1ms" >&2\nsleep 30\n', { mode: 0o755 });
  const out = path.join(fs.mkdtempSync(path.join(tmp, 'out-')), 'tw.css');
  const repoDir = fs.mkdtempSync(path.join(tmp, 'plain-'));
  const tw = await tailwind.start({ repoDir, contentGlob: '/x/**/*.html', outCss: out, standalone: { root, a } });
  try {
    const input = fs.readFileSync(path.join(path.dirname(out), 'input.css'), 'utf8');
    assert.match(input, /^@import "tailwindcss" source\(none\);/);
    assert.match(input, /@custom-variant dark \(&:where\(\.dark, \.dark \*\)\);/);
    assert.strictEqual(tw.detected.tailwind.bin, bin);
  } finally {
    await tw.stop();
  }
});

test('detect finds bin, version, config and no sass', { skip: !have && 'no node_modules' }, () => {
  const { repo } = fixture();
  const d = project.detect(repo);
  assert.strictEqual(d.tailwind.version, 3);
  assert.ok(d.tailwind.bin.endsWith(path.join('.bin', 'tailwindcss')));
  assert.strictEqual(d.tailwind.config, path.join(repo, 'tailwind.config.js'));
  assert.strictEqual(d.sass, null);
});

test('extractCustomProps keeps only variable blocks, through at-rules', () => {
  const css = tailwind.extractCustomProps('// x\n@layer base {\n :root { --a: 1 2 3; }\n .d { --b: 4; }\n .x { color: red; }\n .y { .z { --c: 1; } }\n}\n');
  assert.match(css, /:root\s*\{\s*--a: 1 2 3;\s*\}/);
  assert.match(css, /\.d\s*\{\s*--b: 4;\s*\}/);
  assert.doesNotMatch(css, /color|--c/);
});

let tw;
test('start builds and whenBuilt resolves within 2s of a content change', { skip: !have && 'no node_modules' }, async () => {
  const { repo, data, content } = fixture();
  const d = project.detect(repo);
  const outCss = path.join(data, 'out.css');
  tw = await tailwind.start({
    repoDir: repo, config: d.tailwind.config, input: null,
    extraCss: ['vars.scss'], contentGlob: path.join(content, '**/*.html'), outCss, log: () => {},
  });
  started.push(tw);
  const since = Date.now();
  fs.writeFileSync(path.join(content, 'a.html'), '<div class="text-n-slate-12"></div>');
  await Promise.race([
    tw.whenBuilt(since),
    new Promise((_, rej) => setTimeout(() => rej(new Error('slower than 2s')), 2000)),
  ]);
  const css = fs.readFileSync(outCss, 'utf8');
  assert.match(css, /--slate-12/);
  assert.match(css, /\.text-n-slate-12/);
});

test('restarts once when the CLI is killed', { skip: !have && 'no node_modules' }, async () => {
  const content = path.join(tmp, 'content');
  process.kill(tw.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  const since = Date.now();
  fs.writeFileSync(path.join(content, 'b.html'), '<div class="underline"></div>');
  await tw.whenBuilt(since);
  assert.match(fs.readFileSync(path.join(tmp, 'data', 'out.css'), 'utf8'), /\.underline/);
});

test('rejects fast with a clear error once the restart also dies', { skip: !have && 'no node_modules' }, async () => {
  process.kill(tw.pid, 'SIGKILL'); // second kill: the single restart is spent
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  await assert.rejects(tw.whenBuilt(Date.now()), /^Error: o tailwind do projeto não subiu: /);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('the first build gets 15 s, incremental builds 5 s', async () => {
  assert.strictEqual(tailwind.FIRST_BUILD_TIMEOUT_MS, 15000);
  assert.strictEqual(tailwind.BUILD_TIMEOUT_MS, 5000);
  const t = new tailwind.Tailwind({ outCss: path.join(tmp, 'never.css') }, {});
  t._writeInputs = () => {};
  t._spawn = () => {};
  const seen = [];
  t.whenBuilt = async (since, ms) => { seen.push(ms); };
  await t.init();
  assert.deepStrictEqual(seen, [15000]);
});

test('whenBuilt reports the limit it used', async () => {
  const t = new tailwind.Tailwind({ outCss: path.join(tmp, 'never.css') }, {});
  await assert.rejects(t.whenBuilt(Date.now(), 50), /sem css em 0\.05 s/);
});

test('v4 input imports the project entry css with source(none) and sources only the expanded pages', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'v4-'));
  const entry = path.join(dir, 'src', 'app.css');
  const outCss = path.join(dir, 'data', 'out.css');
  const glob = path.join(dir, 'data', 'expanded', '**/*.html');
  const t = new tailwind.Tailwind({ repoDir: dir, extraCss: [], contentGlob: glob, outCss },
    { tailwind: { version: 4, bin: 'x', config: null, input: entry }, sass: null });
  t._writeInputs();
  const css = fs.readFileSync(path.join(dir, 'data', 'input.css'), 'utf8');
  const lines = css.split('\n');
  assert.strictEqual(lines[0], `@import ${JSON.stringify(entry)} source(none);`);
  assert.strictEqual(lines[1], `@source ${JSON.stringify(glob)};`);
  assert.doesNotMatch(css, /@import "tailwindcss"/);
  // without an entry css: plain tailwind
  const t2 = new tailwind.Tailwind({ repoDir: dir, extraCss: [], contentGlob: glob, outCss },
    { tailwind: { version: 4, bin: 'x', config: null, input: null }, sass: null });
  t2._writeInputs();
  assert.match(fs.readFileSync(path.join(dir, 'data', 'input.css'), 'utf8'), /^@import "tailwindcss" source\(none\);\n@source /);
});

test('a tailwind binary that cannot spawn fails at once with a readable error', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'enoent-'));
  const t = new tailwind.Tailwind({ repoDir: dir, outCss: path.join(dir, 'out.css'), log: () => {} },
    { tailwind: { version: 3, bin: path.join(dir, 'nope', 'tailwindcss') }, sass: null });
  t._writeInputs = function writeInputs() { this.args = []; };
  const t0 = Date.now();
  await assert.rejects(t.init(), /^Error: o tailwind do projeto não subiu: .*ENOENT/);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  await t.stop();
});
