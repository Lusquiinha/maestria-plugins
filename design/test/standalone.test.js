'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const standalone = require('../lib/standalone');

const body = Buffer.from('fake tailwind binary');
const good = { name: 'tailwindcss-test', sha256: crypto.createHash('sha256').update(body).digest('hex'), url: 'https://x/tw' };
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'design-tw-'));

function fakeFetch(bytes = body, status = 200) {
  const f = async () => { f.calls++; return { ok: status === 200, status, arrayBuffer: async () => bytes }; };
  f.calls = 0;
  return f;
}

test('every supported platform has an official asset with a pinned digest', () => {
  for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64']]) {
    const a = standalone.asset(platform, arch);
    assert.match(a.url, new RegExp(`/releases/download/${standalone.VERSION}/tailwindcss-`));
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
  }
  assert.throws(() => standalone.asset('win32', 'x64'), /instale o tailwindcss no projeto/);
});

test('ensure downloads once, checks the digest and leaves an executable', async () => {
  const dir = root();
  const fetchImpl = fakeFetch();
  const bin = await standalone.ensure({ root: dir, a: good, fetchImpl });
  assert.strictEqual(fs.readFileSync(bin, 'utf8'), 'fake tailwind binary');
  assert.ok(fs.statSync(bin).mode & 0o111, 'executable');
  await standalone.ensure({ root: dir, a: good, fetchImpl });
  assert.strictEqual(fetchImpl.calls, 1);
});

test('concurrent canvases share one download', async () => {
  const dir = root();
  const fetchImpl = fakeFetch();
  await Promise.all([1, 2, 3].map(() => standalone.ensure({ root: dir, a: good, fetchImpl })));
  assert.strictEqual(fetchImpl.calls, 1);
});

test('a download that does not match the digest is refused and not kept', async () => {
  const dir = root();
  await assert.rejects(standalone.ensure({ root: dir, a: good, fetchImpl: fakeFetch(Buffer.from('tampered')) }),
    /não consegui baixar o Tailwind: o arquivo baixado não confere/);
  assert.ok(!fs.existsSync(standalone.binPath(dir, good)));
});

test('an http failure says so', async () => {
  await assert.rejects(standalone.ensure({ root: root(), a: good, fetchImpl: fakeFetch(body, 503) }), /HTTP 503/);
});
