'use strict';

// As ferramentas MCP (vm_*, bucket_*): ctx falso, api de objetos simples.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ApiError } = require('../lib/http');
const tools = require('../lib/tools');

const NAMES = [
  'vm_list', 'vm_get', 'vm_catalog', 'vm_create', 'vm_wait', 'vm_start', 'vm_stop', 'vm_destroy',
  'bucket_list', 'bucket_create', 'bucket_credentials',
];
const LOGIN_HINT = 'Entre no VM Manager pelo comando "vm-manager: entrar" e tente de novo.';

const VM = (over = {}) => ({
  vmid: 177, type: 'qemu', name: 'jibri-1', node: 'pve1', status: 'running', isTemplate: false,
  cores: 2, memoryMiB: 4096, diskGiB: 40, ipConfigured: '192.168.100.80/24', ipDetected: null, tags: ['prod'],
  ...over,
});

function makeCtx(over = {}) {
  const calls = [];
  const logs = [];
  const banners = [];
  const ctx = {
    api: {},
    loggedIn: () => true,
    setting: (id, fallback) => (over.settings && over.settings[id] !== undefined ? over.settings[id] : fallback),
    pick: async () => null,
    banner: async (t) => banners.push(t),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    budgetMs: 2000,
    pollMs: 5,
    home: os.tmpdir(),
    readPubKey: async () => 'ssh-ed25519 AAAAPUB arthur@pc',
    log: (...a) => logs.push(a.join(' ')),
    ...over,
  };
  // Conta toda chamada à api.
  const api = {};
  for (const [k, fn] of Object.entries(ctx.api)) {
    api[k] = async (...a) => {
      calls.push({ k, a });
      return fn(...a);
    };
  }
  ctx.api = api;
  return { ctx, calls, logs, banners };
}

const text = (r) => r.content.map((c) => c.text || '').join('\n');
const json = (r) => JSON.parse(r.content[0].text);

// --- esquemas e manifesto ---------------------------------------------------------

test('schemas: 11 names, object inputSchema, english descriptions', () => {
  assert.deepEqual(tools.SCHEMAS.map((s) => s.name), NAMES);
  for (const s of tools.SCHEMAS) {
    assert.equal(s.inputSchema.type, 'object', s.name);
    assert.equal(s.inputSchema.additionalProperties, false, s.name);
    assert.match(s.description, /^[A-Z][a-z]/, s.name);
    assert.doesNotMatch(s.description, /[ãçõé]/, `${s.name} em inglês`);
  }
});

test('manifest tools equal tools.SCHEMAS and every tool activates the plugin', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'maestria-plugin.json'), 'utf8'));
  assert.deepEqual(m.contributes.tools, tools.SCHEMAS);
  for (const n of NAMES) assert.ok(m.activationEvents.includes(`onTool:${n}`), n);
  const ssh = m.contributes.settings.find((s) => s.id === 'sshUser');
  assert.equal(ssh.default, 'ubuntu');
  assert.equal(m.version, '1.1.0');
});

// --- sessão e erros -----------------------------------------------------------------

test('no session → login hint and no api call, for every tool', async () => {
  const { ctx, calls } = makeCtx({ loggedIn: () => false, api: { vms: async () => [] } });
  for (const n of NAMES) {
    const r = await tools.handle(n, { vm: 1, name: 'a', owner: 'o' }, ctx);
    assert.equal(r.isError, true, n);
    assert.equal(text(r), LOGIN_HINT, n);
  }
  assert.equal(calls.length, 0);
});

test('401 becomes the login hint', async () => {
  const { ctx } = makeCtx({ api: { vms: async () => { throw new ApiError('Unauthorized', 401); } } });
  const r = await tools.handle('vm_list', {}, ctx);
  assert.equal(r.isError, true);
  assert.equal(text(r), LOGIN_HINT);
});

test('403 becomes the role message', async () => {
  const { ctx } = makeCtx({ api: { vms: async () => { throw new ApiError('Forbidden resource', 403, { nest: true }); } } });
  const r = await tools.handle('vm_list', {}, ctx);
  assert.equal(r.isError, true);
  assert.match(text(r), /^Seu papel no console não permite isso\./);
  assert.match(text(r), /Forbidden resource/);
});

test('no result text ever contains the bearer token', async () => {
  const { ctx, logs } = makeCtx({ api: { vms: async () => { throw new ApiError('falhou com Authorization: Bearer tok123', 502); } } });
  const r = await tools.handle('vm_list', {}, ctx);
  assert.equal(r.isError, true);
  assert.doesNotMatch(text(r), /tok123/);
  assert.doesNotMatch(logs.join('\n'), /tok123/);
});

test('unknown tool is an error', async () => {
  const { ctx } = makeCtx();
  const r = await tools.handle('vm_explode', {}, ctx);
  assert.equal(r.isError, true);
});

// --- leitura ---------------------------------------------------------------------------

test('vm_list hides templates and returns ip without CIDR', async () => {
  const { ctx } = makeCtx({
    api: { vms: async () => [VM(), VM({ vmid: 9000, name: 'ubuntu-tpl', isTemplate: true }), VM({ vmid: 178, name: 'db', ipConfigured: null, ipDetected: '10.0.0.9' })] },
  });
  const r = await tools.handle('vm_list', {}, ctx);
  const out = json(r);
  assert.deepEqual(out.vms.map((v) => v.vmid), [177, 178]);
  assert.equal(out.vms[0].ip, '192.168.100.80');
  assert.equal(out.vms[1].ip, '10.0.0.9');
  assert.deepEqual(Object.keys(out.vms[0]).sort(), ['cores', 'diskGiB', 'ip', 'memoryMiB', 'name', 'node', 'status', 'tags', 'type', 'vmid']);
});

test('vm_get by vmid returns the detail', async () => {
  const { ctx } = makeCtx({
    api: { vm: async (id) => ({ vm: VM({ vmid: id }), proxmox: { osType: 'l26', agentEnabled: true, disks: [{ slot: 'scsi0', storage: 'ceph', sizeGiB: 40 }] }, netbox: null }) },
  });
  const out = json(await tools.handle('vm_get', { vm: 177 }, ctx));
  assert.equal(out.vm.vmid, 177);
  assert.equal(out.vm.ip, '192.168.100.80');
  assert.deepEqual(out.disks, [{ slot: 'scsi0', storage: 'ceph', sizeGiB: 40 }]);
});

test('vm_get by name: unique ok, ambiguous lists vmids, missing errors', async () => {
  const list = [VM(), VM({ vmid: 200, name: 'dup' }), VM({ vmid: 201, name: 'dup' })];
  const { ctx, calls } = makeCtx({
    api: { vms: async () => list, vm: async (id) => ({ vm: list.find((v) => v.vmid === id), proxmox: {}, netbox: null }) },
  });
  assert.equal(json(await tools.handle('vm_get', { vm: 'jibri-1' }, ctx)).vm.vmid, 177);
  const amb = await tools.handle('vm_get', { vm: 'dup' }, ctx);
  assert.equal(amb.isError, true);
  assert.match(text(amb), /200/);
  assert.match(text(amb), /201/);
  const none = await tools.handle('vm_get', { vm: 'nada' }, ctx);
  assert.equal(none.isError, true);
  assert.match(text(none), /nada/);
  assert.equal(calls.filter((c) => c.k === 'vm').length, 1);
});

test('vm_catalog includes sshUser setting, default ubuntu', async () => {
  const api = {
    catalogNodes: async () => [{ name: 'pve1', status: 'online' }],
    catalogStorages: async () => [{ name: 'ceph' }],
    catalogTemplates: async () => [{ vmid: 9000, name: 'ubuntu' }],
    catalogDefaults: async () => ({ cores: 2, memory: 4096, diskGiB: 40 }),
  };
  const a = json(await tools.handle('vm_catalog', {}, makeCtx({ api }).ctx));
  assert.equal(a.sshUser, 'ubuntu');
  assert.deepEqual(a.nodes, [{ name: 'pve1', status: 'online' }]);
  assert.equal(a.defaults.memory, 4096);
  const b = json(await tools.handle('vm_catalog', {}, makeCtx({ api, settings: { sshUser: 'debian' } }).ctx));
  assert.equal(b.sshUser, 'debian');
});

test('bucket_list returns buckets and owners, never a secret', async () => {
  const { ctx } = makeCtx({
    api: {
      buckets: async () => [{ name: 'b1', owner: 'uplii', objects: 3, usedBytes: 10, quotaBytes: null, tenant: null, createdAt: null }],
      bucketOwners: async () => [{ uid: 'uplii', displayName: 'Uplii' }],
    },
  });
  const out = json(await tools.handle('bucket_list', {}, ctx));
  assert.deepEqual(out.buckets, [{ name: 'b1', owner: 'uplii', objects: 3, usedBytes: 10, quotaBytes: null }]);
  assert.deepEqual(out.owners, [{ uid: 'uplii', displayName: 'Uplii' }]);
});


// --- criar e esperar ---------------------------------------------------------------

const CREATED = (over = {}) => ({ vm: VM({ vmid: 300, name: 'ch-1', ipConfigured: '10.0.0.5/24', ...over }), netbox: null, backupSlot: null, ha: true, warnings: [] });

test('vm_create posts once and returns ssh user@ip', async () => {
  const { ctx, calls } = makeCtx({ api: { createVm: async () => CREATED() } });
  const r = await tools.handle('vm_create', { name: 'ch-1', cores: 4, memoryMiB: 8192, diskGiB: 100 }, ctx);
  assert.equal(r.isError, undefined, text(r));
  const out = json(r);
  assert.equal(out.status, 'pronta');
  assert.equal(out.vm.vmid, 300);
  assert.equal(out.ssh, 'ubuntu@10.0.0.5');
  const posts = calls.filter((c) => c.k === 'createVm');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].a[0], { name: 'ch-1', cores: 4, memory: 8192, diskGiB: 100, sshKeys: 'ssh-ed25519 AAAAPUB arthur@pc' });
});

test('vm_create uses the sshUser setting', async () => {
  const { ctx } = makeCtx({ settings: { sshUser: 'debian' }, api: { createVm: async () => CREATED() } });
  assert.equal(json(await tools.handle('vm_create', { name: 'ch-1' }, ctx)).ssh, 'debian@10.0.0.5');
});

test('vm_create without a public key still creates and warns', async () => {
  const { ctx, calls } = makeCtx({ readPubKey: async () => null, api: { createVm: async () => CREATED() } });
  const out = json(await tools.handle('vm_create', { name: 'ch-1' }, ctx));
  assert.equal(out.status, 'pronta');
  assert.equal(calls[0].a[0].sshKeys, undefined);
  assert.ok(out.warnings.some((w) => /chave SSH/.test(w)), out.warnings.join());
});

test('vm_create rejects an invalid hostname before posting', async () => {
  const { ctx, calls } = makeCtx({ api: { createVm: async () => CREATED() } });
  const r = await tools.handle('vm_create', { name: 'Ch_1' }, ctx);
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
});

test('vm_create past the budget returns em andamento and never re-posts', async () => {
  const { ctx, calls } = makeCtx({ budgetMs: 50, api: { createVm: () => new Promise(() => {}) } });
  const r = await tools.handle('vm_create', { name: 'ch-1' }, ctx);
  assert.equal(r.isError, undefined);
  const out = json(r);
  assert.equal(out.status, 'em andamento');
  assert.equal(out.name, 'ch-1');
  assert.match(out.next, /vm_wait/);
  assert.equal(calls.filter((c) => c.k === 'createVm').length, 1);
});

test('vm_wait follows and returns pronta; never posts', async () => {
  let n = 0;
  const { ctx, calls } = makeCtx({
    api: {
      createVm: async () => CREATED(),
      vmCreation: async () => (++n < 3 ? { status: 'running' } : { status: 'succeeded', result: CREATED() }),
    },
  });
  const out = json(await tools.handle('vm_wait', { name: 'ch-1' }, ctx));
  assert.equal(out.status, 'pronta');
  assert.equal(out.ssh, 'ubuntu@10.0.0.5');
  assert.equal(calls.filter((c) => c.k === 'createVm').length, 0);
});

test('vm_wait past the budget says em andamento again', async () => {
  const { ctx } = makeCtx({ budgetMs: 40, api: { vmCreation: async () => ({ status: 'running' }) } });
  assert.equal(json(await tools.handle('vm_wait', { name: 'ch-1' }, ctx)).status, 'em andamento');
});

test('session expires mid-creation → login hint, single POST', async () => {
  let logged = true;
  const expire = () => {
    logged = false;
    throw new ApiError('Unauthorized', 401);
  };
  const { ctx, calls } = makeCtx({ loggedIn: () => logged, api: { createVm: async () => expire(), vmCreation: async () => expire() } });
  const r = await tools.handle('vm_create', { name: 'ch-1' }, ctx);
  assert.equal(r.isError, true);
  assert.equal(text(r), LOGIN_HINT);
  assert.equal(calls.filter((c) => c.k === 'createVm').length, 1);
});

test('created without IP → pronta with ssh null and the warning', async () => {
  const { ctx } = makeCtx({ api: { createVm: async () => CREATED({ ipConfigured: null, ipDetected: null, status: 'stopped' }) } });
  const out = json(await tools.handle('vm_create', { name: 'ch-1', startAfterCreate: false }, ctx));
  assert.equal(out.status, 'pronta');
  assert.equal(out.ssh, null);
  assert.ok(out.warnings.includes('A VM ainda não tem IP; use vm_get em instantes.'));
});

test('rejected (400) surfaces the backend message as error', async () => {
  const { ctx } = makeCtx({ api: { createVm: async () => { throw new ApiError('Já existe uma VM chamada "ch-1".', 400, { nest: true }); } } });
  const r = await tools.handle('vm_create', { name: 'ch-1' }, ctx);
  assert.equal(r.isError, true);
  assert.match(text(r), /^Falhou: Já existe uma VM chamada/);
});

test('creation failed while tracking surfaces the reason', async () => {
  const { ctx } = makeCtx({
    api: { createVm: async () => { throw new ApiError('Bad Gateway', 502); }, vmCreation: async () => ({ status: 'failed', error: 'clone falhou' }) },
  });
  const r = await tools.handle('vm_create', { name: 'ch-1' }, ctx);
  assert.equal(r.isError, true);
  assert.equal(text(r), 'Falhou: clone falhou');
});

// --- ligar, desligar e destruir ------------------------------------------------------

const LIST = [VM(), VM({ vmid: 200, name: 'dup' }), VM({ vmid: 201, name: 'dup' }), VM({ vmid: 400, name: 'ct', type: 'lxc' }), VM({ vmid: 9000, name: 'tpl', isTemplate: true })];
const lifecycleApi = (over = {}) => ({
  vms: async () => LIST,
  startVm: async (id) => ({ vmid: id }),
  stopVm: async (id) => ({ vmid: id }),
  destroyVm: async (id) => ({ vmid: id }),
  ...over,
});
const count = (calls, k) => calls.filter((c) => c.k === k).length;

test('start/stop call the api once', async () => {
  const { ctx, calls } = makeCtx({ api: lifecycleApi() });
  const a = await tools.handle('vm_start', { vm: 'jibri-1' }, ctx);
  assert.equal(a.isError, undefined, text(a));
  assert.match(text(a), /177/);
  await tools.handle('vm_stop', { vm: 177 }, ctx);
  assert.equal(count(calls, 'startVm'), 1);
  assert.equal(count(calls, 'stopVm'), 1);
  assert.deepEqual(calls.find((c) => c.k === 'stopVm').a, [177]);
});

test('destroy confirmed deletes', async () => {
  const picks = [];
  const { ctx, calls } = makeCtx({ api: lifecycleApi(), pick: async (p) => (picks.push(p), 'destroy') });
  const r = await tools.handle('vm_destroy', { vm: 'jibri-1' }, ctx);
  assert.equal(r.isError, undefined, text(r));
  assert.deepEqual(calls.find((c) => c.k === 'destroyVm').a, [177]);
  assert.equal(picks[0].title, 'Destruir a vm 177 (jibri-1)? Isso não tem volta.');
  assert.deepEqual(picks[0].items.map((i) => i.value), ['destroy', 'cancel']);
});

test('destroy cancelled or closed does not delete', async () => {
  for (const answer of ['cancel', null]) {
    const { ctx, calls } = makeCtx({ api: lifecycleApi(), pick: async () => answer });
    const r = await tools.handle('vm_destroy', { vm: 177 }, ctx);
    assert.equal(r.isError, undefined);
    assert.equal(text(r), 'Cancelado pelo usuário; nada foi destruído.');
    assert.equal(count(calls, 'destroyVm'), 0);
  }
});

test('destroy with late answer does not delete and shows banner', async () => {
  const { ctx, calls, banners } = makeCtx({
    budgetMs: 30,
    api: lifecycleApi(),
    pick: () => new Promise((r) => setTimeout(() => r('destroy'), 80)),
  });
  const r = await tools.handle('vm_destroy', { vm: 177 }, ctx);
  assert.equal(text(r), 'Tempo esgotado; nada foi destruído.');
  await new Promise((r2) => setTimeout(r2, 150));
  assert.equal(count(calls, 'destroyVm'), 0);
  assert.deepEqual(banners, ['Tempo esgotado: a vm 177 não foi destruída.']);
});

test('destroy refuses lxc and templates without asking', async () => {
  let asked = 0;
  const { ctx, calls } = makeCtx({ api: lifecycleApi(), pick: async () => (asked++, 'destroy') });
  for (const vm of ['ct', 9000]) {
    const r = await tools.handle('vm_destroy', { vm }, ctx);
    assert.equal(r.isError, true, String(vm));
    assert.equal(text(r), 'Só VMs podem ser destruídas por aqui.');
  }
  assert.equal(asked, 0);
  assert.equal(count(calls, 'destroyVm'), 0);
});

test('destroy ambiguous name does not open the dialog', async () => {
  let asked = 0;
  const { ctx, calls } = makeCtx({ api: lifecycleApi(), pick: async () => (asked++, 'destroy') });
  const r = await tools.handle('vm_destroy', { vm: 'dup' }, ctx);
  assert.equal(r.isError, true);
  assert.match(text(r), /200, 201/);
  assert.equal(asked, 0);
  assert.equal(count(calls, 'destroyVm'), 0);
});

test('destroy schema has no way to skip the confirmation', () => {
  const s = tools.SCHEMAS.find((x) => x.name === 'vm_destroy');
  assert.deepEqual(Object.keys(s.inputSchema.properties), ['vm']);
});

// --- buckets: criar e credenciais ----------------------------------------------------------

const SECRET = 'SEKRET-xyz';
const bucketApi = (over = {}) => ({
  createBucket: async (b) => ({ name: b.name, owner: b.owner, objects: 0, usedBytes: 0, quotaBytes: null, secretKey: SECRET }),
  credentials: async (owner) => ({ owner, endpoint: 'https://s3.cefis.cloud', region: 'us-east-1', accessKey: 'AK123' }),
  secret: async () => ({ secretKey: SECRET }),
  ...over,
});
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-tools-home-'));

test('bucket_credentials writes 0600 file in 0700 dir with the four variables', async () => {
  const home = tmpHome();
  try {
    const { ctx } = makeCtx({ home, api: bucketApi() });
    const r = await tools.handle('bucket_credentials', { owner: 'uplii' }, ctx);
    assert.equal(r.isError, undefined, text(r));
    const out = json(r);
    const file = path.join(home, '.config', 'maestria-vm-manager', 'credentials', 'uplii.env');
    assert.equal(out.file, file);
    assert.equal(out.accessKey, 'AK123');
    assert.equal(out.endpoint, 'https://s3.cefis.cloud');
    assert.deepEqual(out.variables, ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_ENDPOINT', 'S3_REGION']);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      'AWS_ACCESS_KEY_ID=AK123\nAWS_SECRET_ACCESS_KEY=SEKRET-xyz\nS3_ENDPOINT=https://s3.cefis.cloud\nS3_REGION=us-east-1\n',
    );
    assert.match(out.message, /não imprima o conteúdo/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bucket_credentials overwrites a loose file and tightens it to 0600', async () => {
  const home = tmpHome();
  try {
    const dir = path.join(home, '.config', 'maestria-vm-manager', 'credentials');
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'uplii.env'), 'velho', { mode: 0o644 });
    const { ctx } = makeCtx({ home, api: bucketApi() });
    await tools.handle('bucket_credentials', { owner: 'uplii' }, ctx);
    assert.equal(fs.statSync(path.join(dir, 'uplii.env')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'uplii.env'), 'utf8'), /velho/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bucket_credentials result and logs never contain the secret', async () => {
  const home = tmpHome();
  try {
    const { ctx, logs } = makeCtx({ home, api: bucketApi() });
    const r = await tools.handle('bucket_credentials', { owner: 'uplii' }, ctx);
    assert.doesNotMatch(text(r), /SEKRET/);
    assert.doesNotMatch(logs.join('\n'), /SEKRET/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bucket_credentials error never carries the secret', async () => {
  const home = tmpHome();
  try {
    const { ctx, logs } = makeCtx({
      home: path.join(home, 'nao-existe', '\0'),
      api: bucketApi(),
    });
    const r = await tools.handle('bucket_credentials', { owner: 'uplii' }, ctx);
    assert.equal(r.isError, true);
    assert.doesNotMatch(text(r), /SEKRET/);
    assert.doesNotMatch(logs.join('\n'), /SEKRET/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bucket_credentials rejects owner with / or ..', async () => {
  for (const owner of ['../x', 'a/b', '..', '.hidden', '']) {
    const { ctx, calls } = makeCtx({ api: bucketApi() });
    const r = await tools.handle('bucket_credentials', { owner }, ctx);
    assert.equal(r.isError, true, owner);
    assert.equal(calls.length, 0, owner);
  }
});

test('bucket_credentials without access key says so and writes nothing', async () => {
  const home = tmpHome();
  try {
    const { ctx, calls } = makeCtx({ home, api: bucketApi({ credentials: async (owner) => ({ owner, endpoint: 'e', region: 'r', accessKey: null }) }) });
    const r = await tools.handle('bucket_credentials', { owner: 'uplii' }, ctx);
    assert.equal(r.isError, true);
    assert.equal(calls.filter((c) => c.k === 'secret').length, 0);
    assert.equal(fs.existsSync(path.join(home, '.config')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bucket_create never returns the secret and hints bucket_credentials', async () => {
  const { ctx, calls } = makeCtx({ api: bucketApi() });
  const r = await tools.handle('bucket_create', { name: 'backups-ch', owner: 'uplii', newOwner: true }, ctx);
  assert.equal(r.isError, undefined, text(r));
  assert.doesNotMatch(text(r), /SEKRET/);
  const out = json(r);
  assert.deepEqual(out.bucket, { name: 'backups-ch', owner: 'uplii' });
  assert.equal(out.next, 'Para usar no servidor, chame bucket_credentials com owner "uplii".');
  assert.deepEqual(calls[0].a[0], { name: 'backups-ch', owner: 'uplii', newOwner: true });
});
