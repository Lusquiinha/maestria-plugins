'use strict';
// As ferramentas MCP que o Claude ganha numa sessão do Maestria (`vm_*`, `bucket_*`):
// as mesmas operações da tela, com a sessão "Entrar com Marrow" do plugin. main.js liga
// `tool.call` a handle(); `ctx` vem de toolCtx() lá (os testes passam um falso):
// { api, loggedIn, setting, pick, banner, now, sleep, schedule, budgetMs, pollMs, home, readPubKey, log }

const { createCreateFlow } = require('./create-flow');

const LOGIN_HINT = 'Entre no VM Manager pelo comando "vm-manager: entrar" e tente de novo.';
const FORBIDDEN = 'Seu papel no console não permite isso.';

const VM_REF = { type: ['integer', 'string'], description: 'VM id (number) or exact VM name.' };

const SCHEMAS = [
  {
    name: 'vm_list',
    description: 'List the VMs of the CCS Proxmox cluster (vmid, name, type, status, node, size, IP, tags). Templates are left out. Use it to find a VM before vm_get/vm_start/vm_stop/vm_destroy.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vm_get',
    description: 'Details of one VM by vmid or exact name: status, size, IP, disks, OS type and guest agent.',
    inputSchema: { type: 'object', properties: { vm: VM_REF }, required: ['vm'], additionalProperties: false },
  },
  {
    name: 'vm_catalog',
    description: 'What a new VM can use: nodes, storages, templates, the environment defaults (cores, memory MiB, disk GiB) and the SSH user of new VMs. Read it before vm_create to pick a sensible size.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vm_create',
    description: 'Create a VM (clone + cloud-init + NetBox) and wait until it is ready with an IP, for up to ~100 s. Your local SSH public key is added, and the result has `ssh` (user@ip) ready to use. If it is still creating, the result says "em andamento": call vm_wait with the same name. Never call vm_create again for the same name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'VM hostname: lowercase letters, digits and hyphen (1-63 chars).' },
        cores: { type: 'integer', description: 'vCPU cores (1-64). Omit for the default.' },
        memoryMiB: { type: 'integer', description: 'Memory in MiB (512-524288). Omit for the default.' },
        diskGiB: { type: 'integer', description: 'Root disk in GiB (4-2048). Omit for the default.' },
        template: { type: 'string', description: 'Template to clone (from vm_catalog). Omit for the default.' },
        node: { type: 'string', description: 'Target node (from vm_catalog). Omit for the default.' },
        storage: { type: 'string', description: 'Disk storage (from vm_catalog). Omit for the default.' },
        ipCidr: { type: 'string', description: 'IPv4 with CIDR, e.g. 192.168.100.80/24. Omit to get the next free IP.' },
        backup: { type: 'boolean', description: 'Include in the daily backup. Default true.' },
        ha: { type: 'boolean', description: 'Include in the cluster HA. Default true.' },
        startAfterCreate: { type: 'boolean', description: 'Start the VM after creating. Default true.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'vm_wait',
    description: 'Keep waiting (up to ~100 s per call) for a VM creation that vm_create left "em andamento". Never creates anything.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The name passed to vm_create.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'vm_start',
    description: 'Start a VM.',
    inputSchema: { type: 'object', properties: { vm: VM_REF }, required: ['vm'], additionalProperties: false },
  },
  {
    name: 'vm_stop',
    description: 'Shut a VM down (ACPI).',
    inputSchema: { type: 'object', properties: { vm: VM_REF }, required: ['vm'], additionalProperties: false },
  },
  {
    name: 'vm_destroy',
    description: 'Destroy a VM and remove it from NetBox. The user is always asked to confirm in Maestria; if they cancel or do not answer in time, nothing is destroyed. Only VMs, not containers or templates.',
    inputSchema: { type: 'object', properties: { vm: VM_REF }, required: ['vm'], additionalProperties: false },
  },
  {
    name: 'bucket_list',
    description: 'List the S3 buckets (name, owner, objects, used bytes, quota) and the owners a new bucket can have.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bucket_create',
    description: 'Create an S3 bucket for an existing owner, or for a new owner with newOwner=true. Returns no secret: use bucket_credentials to get the keys into a file.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Bucket name.' },
        owner: { type: 'string', description: 'Owner uid (from bucket_list), or the new owner uid.' },
        newOwner: { type: 'boolean', description: 'Create the owner too. Default false.' },
      },
      required: ['name', 'owner'],
      additionalProperties: false,
    },
  },
  {
    name: 'bucket_credentials',
    description: 'Write the S3 credentials of a bucket owner to a local .env file (mode 0600) and return only its path, the access key and the endpoint. The secret key is only in the file: copy the file to the server with scp and use it by path. Never print its contents (no cat, echo or grep of the secret).',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string', description: 'Owner uid (from bucket_list).' } },
      required: ['owner'],
      additionalProperties: false,
    },
  },
];

// --- resultados e erros ------------------------------------------------------------------

const scrub = (s) => String(s).replace(/Bearer\s+\S+/gi, 'Bearer ***');
const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (s) => ({ content: [{ type: 'text', text: scrub(s) }], isError: true });

class ToolError extends Error {}

function apiError(e) {
  if (e instanceof ToolError) return e.message;
  const status = e && e.status;
  if (status === 401) return LOGIN_HINT;
  const msg = e && e.message ? e.message : String(e);
  if (status === 403) return `${FORBIDDEN} ${msg}`;
  return msg;
}

// --- VMs --------------------------------------------------------------------------------------

const noCidr = (ip) => (ip ? String(ip).split('/')[0] : null);

function vmSummary(vm) {
  return {
    vmid: vm.vmid,
    name: vm.name,
    type: vm.type || 'qemu',
    status: vm.status,
    node: vm.node,
    cores: vm.cores,
    memoryMiB: vm.memoryMiB,
    diskGiB: vm.diskGiB,
    ip: noCidr(vm.ipDetected || vm.ipConfigured),
    tags: vm.tags || [],
  };
}

/** Número (ou texto só de dígitos) = vmid; texto = nome exato, que precisa ser único. */
async function resolveVm(api, ref) {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const vmid = Number(ref);
    const list = await api.vms();
    const vm = (list || []).find((v) => v.vmid === vmid);
    if (!vm) throw new ToolError(`Nenhuma VM com vmid ${vmid}.`);
    return vm;
  }
  const name = String(ref || '');
  const found = ((await api.vms()) || []).filter((v) => v.name === name && !v.isTemplate);
  if (found.length === 0) throw new ToolError(`Nenhuma VM chamada "${name}".`);
  if (found.length > 1) throw new ToolError(`Mais de uma VM chamada "${name}" (vmids ${found.map((v) => v.vmid).join(', ')}): use o vmid.`);
  return found[0];
}

async function vmList(_args, { api }) {
  const list = (await api.vms()) || [];
  return ok({ vms: list.filter((v) => !v.isTemplate).map(vmSummary) });
}

async function vmGet({ vm }, { api }) {
  const vmid = typeof vm === 'number' || /^\d+$/.test(String(vm)) ? Number(vm) : (await resolveVm(api, vm)).vmid;
  const d = await api.vm(vmid);
  const px = (d && d.proxmox) || {};
  return ok({
    vm: vmSummary(d.vm),
    uptimeSeconds: d.vm.uptimeSeconds ?? null,
    osType: px.osType ?? null,
    agentEnabled: px.agentEnabled ?? null,
    disks: px.disks || [],
    backupSlot: d.vm.backupSlot ?? null,
    haState: d.vm.haState ?? null,
  });
}

async function vmCatalog(_args, { api, setting }) {
  const [nodes, storages, templates, defaults] = await Promise.all([
    api.catalogNodes(), api.catalogStorages(), api.catalogTemplates(), api.catalogDefaults(),
  ]);
  return ok({ nodes, storages, templates, defaults, sshUser: setting('sshUser', 'ubuntu') });
}

// --- criar e esperar ----------------------------------------------------------------------

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const NO_IP = 'A VM ainda não tem IP; use vm_get em instantes.';
const NO_KEY = 'Nenhuma chave SSH pública local (~/.ssh/id_ed25519.pub): a VM saiu só com as chaves padrão do ambiente.';
const FINAL = new Set(['succeeded', 'rejected', 'failed', 'unconfirmed']);

function creationResult(st, ctx, warnings = []) {
  if (st.phase === 'succeeded') {
    const res = st.result || {};
    const vm = res.vm ? vmSummary(res.vm) : null;
    const ip = vm && vm.ip;
    const all = [...warnings, ...(res.warnings || [])];
    if (!ip) all.push(NO_IP);
    return ok({ status: 'pronta', vm, ssh: ip ? `${ctx.setting('sshUser', 'ubuntu')}@${ip}` : null, warnings: all });
  }
  if (st.phase === 'unconfirmed') return fail(st.error);
  return fail(`Falhou: ${st.error}`);
}

/** Espera o fluxo chegar a um fim, até `ctx.budgetMs`. Ao estourar, larga só o acompanhamento local. */
async function settle(flow, name, ctx, warnings) {
  const deadline = ctx.now() + ctx.budgetMs;
  for (;;) {
    const st = flow.state();
    if (FINAL.has(st.phase)) return creationResult(st, ctx, warnings);
    if (!ctx.loggedIn()) {
      flow.abandon();
      return fail(LOGIN_HINT);
    }
    const left = deadline - ctx.now();
    if (left <= 0) {
      flow.abandon();
      return ok({ status: 'em andamento', name, next: `Ainda criando. Chame vm_wait com name "${name}".`, warnings });
    }
    await ctx.sleep(Math.min(ctx.pollMs, left));
  }
}

const newFlow = (ctx) => createCreateFlow({ api: ctx.api, now: ctx.now, schedule: ctx.schedule, pollMs: ctx.pollMs });

async function vmCreate(args, ctx) {
  const name = String(args.name || '');
  if (!HOSTNAME.test(name)) throw new ToolError('name deve ser um hostname válido (minúsculas, dígitos e hífen; 1–63 chars).');
  const body = { name };
  const map = { cores: 'cores', memoryMiB: 'memory', diskGiB: 'diskGiB', template: 'template', node: 'node', storage: 'storage', ipCidr: 'ipCidr', backup: 'backup', ha: 'ha', startAfterCreate: 'startAfterCreate' };
  for (const [k, to] of Object.entries(map)) if (args[k] !== undefined) body[to] = args[k];
  const warnings = [];
  const key = await ctx.readPubKey();
  if (key) body.sshKeys = key;
  else warnings.push(NO_KEY);
  const flow = newFlow(ctx);
  flow.submit(body);
  return settle(flow, name, ctx, warnings);
}

async function vmWait({ name }, ctx) {
  const n = String(name || '');
  if (!n) throw new ToolError('Diga o name usado no vm_create.');
  const flow = newFlow(ctx);
  flow.follow(n);
  return settle(flow, n, ctx, []);
}

// --- buckets -----------------------------------------------------------------------------------

async function bucketList(_args, { api }) {
  const [buckets, owners] = await Promise.all([api.buckets(), api.bucketOwners()]);
  return ok({
    buckets: (buckets || []).map((b) => ({ name: b.name, owner: b.owner, objects: b.objects, usedBytes: b.usedBytes, quotaBytes: b.quotaBytes })),
    owners,
  });
}

const notYet = async () => fail('não implementado');

const HANDLERS = {
  vm_list: vmList,
  vm_get: vmGet,
  vm_catalog: vmCatalog,
  vm_create: vmCreate,
  vm_wait: vmWait,
  vm_start: notYet,
  vm_stop: notYet,
  vm_destroy: notYet,
  bucket_list: bucketList,
  bucket_create: notYet,
  bucket_credentials: notYet,
};

async function handle(name, args, ctx) {
  const fn = HANDLERS[name];
  if (!fn) return fail(`ferramenta desconhecida: ${name}`);
  if (!ctx.loggedIn()) return fail(LOGIN_HINT);
  try {
    return await fn(args || {}, ctx);
  } catch (e) {
    const msg = apiError(e);
    if (ctx.log) ctx.log(`ferramenta ${name} falhou:`, scrub(msg));
    return fail(msg);
  }
}

module.exports = { SCHEMAS, handle, LOGIN_HINT, ToolError, ok, fail, scrub, apiError, resolveVm, vmSummary };
