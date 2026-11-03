'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tools = require('../lib/tools');
const canvasMod = require('../lib/canvas');
const project = require('../lib/project');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-tools-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// home/co/repo is a "project" with a (fake) tailwind; home/co/design is where canvases go.
const home = path.join(tmp, 'home');
const repo = path.join(home, 'co', 'repo');
fs.mkdirSync(path.join(repo, 'node_modules', '.bin'), { recursive: true });
fs.writeFileSync(path.join(repo, 'node_modules', '.bin', 'tailwindcss'), '');
fs.writeFileSync(path.join(repo, 'tailwind.config.js'),
  "const { c } = require('./colors.js');\nmodule.exports = { theme: { colors: { white: '#fff', ...c, brand: { 500: '#00f' } } } };\n");
fs.writeFileSync(path.join(repo, 'colors.js'), "const c = {\n  woot: { 500: '#00f' },\n  slate: { 1: '#fff' },\n};\nmodule.exports = { c };\n");

const PNG = Buffer.from('iVBORw0KGgo=', 'base64');
const png = path.join(tmp, 'x.png');
fs.writeFileSync(png, PNG);
const BIG = Buffer.from('iVBORw0KGgoAAAA=', 'base64'); // stands for the 2x canvas png
const big2x = path.join(tmp, 'x2.png');
fs.writeFileSync(big2x, BIG);

function fakeHost() {
  const calls = [];
  const last = {};
  const host = {
    calls,
    lastFor: ({ tabId }) => last[tabId] || null,
    viewOf: () => null,
    request: async (m, p) => { calls.push(['request', m, p]); },
    openCanvas: async (dir, opts) => {
      calls.push(['openCanvas', dir, opts, fs.existsSync(path.join(dir, 'canvas.json'))]);
      last[opts.tabId] = dir;
      return {
        failed: false,
        ui: {},
        engine: {
          known: new Set(),
          loadCanvas() { this.known = new Set(canvasMod.read(dir).order); },
          render: async function render(names, opts) {
            for (const n of names) if (!this.known.has(n)) return new Map(names.map((x) => [x, null]));
            calls.push(['render', names, opts]);
            return new Map(names.map((n) => [n, n === 'bad'
              ? { error: 'marcação inválida', width: 10, height: 10, ms: 5 }
              : { light: big2x, dark: big2x, claude: { light: png, dark: png }, width: 1440, height: 900, ms: 30, cut: false }]));
          },
        },
      };
    },
    focusBoard: async (dir, name) => { calls.push(['focus', dir, name]); },
    dataDirOf: (dir) => path.join(tmp, 'data', path.basename(dir)),
    remember: (dir, opts) => { calls.push(['remember', dir, opts]); last[opts.tabId] = dir; },
  };
  return host;
}

const ctxOf = (host, extra = {}) => ({ tabId: 't1', cwd: repo, home, host, ...extra });
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('manifest-facing schemas: design_ names, object inputSchema', () => {
  assert.deepStrictEqual(tools.SCHEMAS.map((s) => s.name),
    ['design_open', 'design_board', 'design_render', 'design_focus', 'design_list', 'design_ref', 'design_comments', 'design_comment_reply']);
  for (const s of tools.SCHEMAS) {
    assert.strictEqual(s.inputSchema.type, 'object');
    assert.ok(s.description.length > 20 && s.description.length < 400);
  }
});

test('design_open without a name directly under home is an error with the exact message', async () => {
  const host = fakeHost();
  const r = await tools.handle('design_open', {}, ctxOf(host, { cwd: path.join(home, 'solto') }));
  assert.strictEqual(r.isError, true);
  assert.strictEqual(textOf(r), 'diga onde criar o canvas (ex.: ~/Desktop/Work/Ninepay/design/<nome>)');
  assert.strictEqual(host.calls.length, 0);
});

test('design_open with a name creates the folder, then opens the view for the caller tab', async () => {
  const host = fakeHost();
  const r = await tools.handle('design_open', { name: 'sidebar' }, ctxOf(host));
  assert.ok(!r.isError, textOf(r));
  const dir = path.join(home, 'co', 'design', 'sidebar');
  assert.ok(fs.existsSync(path.join(dir, 'canvas.json')));
  assert.ok(fs.existsSync(path.join(dir, 'design.json')));
  const [kind, openedDir, opts, existedThen] = host.calls[0];
  assert.strictEqual(kind, 'openCanvas');
  assert.strictEqual(openedDir, dir);
  assert.strictEqual(opts.tabId, 't1');
  assert.strictEqual(existedThen, true, 'the folder exists before the view opens');
  const t = textOf(r);
  assert.match(t, new RegExp(`canvas: ${dir}`));
  assert.match(t, new RegExp(`repo: ${repo}`));
  assert.match(t, /cores do tailwind do projeto: brand, woot, slate/);
  assert.match(t, /# Design canvas guide/);
});

test('design_open reuses the last canvas of the tab when no name is given', async () => {
  const host = fakeHost();
  await tools.handle('design_open', { name: 'a' }, ctxOf(host));
  const r = await tools.handle('design_open', {}, ctxOf(host));
  assert.match(textOf(r), /design\/a\n/);
});

test('design_open rejects a canvas outside home', async () => {
  const r = await tools.handle('design_open', { canvas: '/etc/x' }, ctxOf(fakeHost()));
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /dentro da home/);
});

test('design_board twice with the same name updates instead of duplicating', async () => {
  const host = fakeHost();
  await tools.handle('design_open', { name: 'b' }, ctxOf(host));
  const dir = path.join(home, 'co', 'design', 'b');
  const r1 = await tools.handle('design_board', { name: 'login', w: 1440 }, ctxOf(host));
  assert.strictEqual(textOf(r1).split('\n')[0], path.join(dir, 'boards', 'login.html'));
  assert.match(textOf(r1), /Write\/Edit.*design_render/);
  const r2 = await tools.handle('design_board', { name: 'login', w: 390, title: 'Login' }, ctxOf(host));
  assert.ok(!r2.isError);
  const c = canvasMod.read(dir);
  assert.deepStrictEqual(c.order, ['login']);
  assert.strictEqual(c.boards.login.w, 390);
  assert.strictEqual(c.boards.login.title, 'Login');
});

test('design_board without an open canvas says so', async () => {
  const r = await tools.handle('design_board', { name: 'x', w: 100 }, ctxOf(fakeHost(), { tabId: 'other' }));
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /design_open/);
});

async function withBoards(names) {
  const host = fakeHost();
  await tools.handle('design_open', { name: `r${names.length}${Math.random().toString(36).slice(2, 6)}` }, ctxOf(host));
  for (const n of names) await tools.handle('design_board', { name: n, w: 390 }, ctxOf(host));
  return host;
}

test('design_render returns png image items, light then dark', async () => {
  const host = await withBoards(['a']);
  const r = await tools.handle('design_render', { boards: ['a'] }, ctxOf(host));
  assert.ok(!r.isError);
  const imgs = r.content.filter((c) => c.type === 'image');
  assert.strictEqual(imgs.length, 2);
  assert.deepStrictEqual(imgs[0], { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
  assert.match(textOf(r), /a: 1440×900 px, 30 ms/);
  const labels = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  assert.ok(labels.indexOf('a (claro)') < labels.indexOf('a (escuro)'));
});

test('design_render asks for the small captures and never returns the 2x canvas png', async () => {
  const host = await withBoards(['a']);
  const r = await tools.handle('design_render', { boards: ['a'] }, ctxOf(host));
  assert.deepStrictEqual(host.calls.filter((c) => c[0] === 'render').pop()[2], { forClaude: true });
  for (const img of r.content.filter((c) => c.type === 'image')) assert.notStrictEqual(img.data, BIG.toString('base64'));
  // a state without the small capture (a newer save took over) is not sent at 2x
  const open = host.openCanvas;
  host.openCanvas = async (...a) => {
    const V = await open(...a);
    const real = V.engine.render;
    V.engine.render = async function render(names, opts) {
      const m = await real.call(this, names, opts);
      for (const s of m.values()) if (s) delete s.claude;
      return m;
    };
    return V;
  };
  const host2 = host;
  await tools.handle('design_open', { name: `z${Math.random().toString(36).slice(2, 6)}` }, ctxOf(host2));
  await tools.handle('design_board', { name: 'a', w: 1440 }, ctxOf(host2));
  const r2 = await tools.handle('design_render', { boards: ['a'] }, ctxOf(host2));
  assert.strictEqual(r2.content.filter((c) => c.type === 'image').length, 0);
  assert.match(textOf(r2), /a \(claro\): imagem omitida.*design_render de novo/);
});

test('design_render honors theme and reports errors without images', async () => {
  const host = await withBoards(['a', 'bad']);
  const r = await tools.handle('design_render', { theme: 'dark' }, ctxOf(host));
  assert.strictEqual(r.content.filter((c) => c.type === 'image').length, 1);
  assert.match(textOf(r), /bad: 10×10 px, 5 ms, ERRO: marcação inválida/);
});

test('design_render caps at 8 images and says what it left out', async () => {
  const host = await withBoards(['a', 'b', 'c', 'd', 'e', 'f']);
  const r = await tools.handle('design_render', {}, ctxOf(host));
  assert.strictEqual(r.content.filter((c) => c.type === 'image').length, 8);
  assert.match(textOf(r), /não renderizadas.*e, f/);
  assert.deepStrictEqual(host.calls.filter((c) => c[0] === 'render').pop()[1], ['a', 'b', 'c', 'd']);
});

test('design_render with an unknown board is an error', async () => {
  const host = await withBoards(['a']);
  const r = await tools.handle('design_render', { boards: ['x'] }, ctxOf(host));
  assert.strictEqual(r.isError, true);
  assert.strictEqual(textOf(r), 'prancheta não existe: x');
});

test('design_focus focuses a known board and rejects an unknown one', async () => {
  const host = await withBoards(['a']);
  const ok = await tools.handle('design_focus', { board: 'a' }, ctxOf(host));
  assert.ok(!ok.isError);
  assert.strictEqual(host.calls.filter((c) => c[0] === 'focus').pop()[2], 'a');
  const bad = await tools.handle('design_focus', { board: 'x' }, ctxOf(host));
  assert.strictEqual(textOf(bad), 'prancheta não existe: x');
});

test('design_list shows boards with components used and components with dependents', async () => {
  const host = await withBoards(['a', 'b']);
  const dir = host.calls.find((c) => c[0] === 'openCanvas')[1];
  fs.writeFileSync(path.join(dir, 'components', 'Toast.html'), '<div>{{ text }}</div>');
  fs.writeFileSync(path.join(dir, 'components', 'Unused.html'), '<i></i>');
  fs.writeFileSync(path.join(dir, 'boards', 'a.html'), '<x-toast text="oi"></x-toast>');
  const r = await tools.handle('design_list', {}, ctxOf(host));
  const t = textOf(r);
  assert.match(t, /- a: 390 px, .*boards\/a\.html, usa: Toast/);
  assert.match(t, /- b: 390 px, .*boards\/b\.html\n/);
  assert.match(t, /- Toast: .*components\/Toast\.html, usado em: a/);
  assert.match(t, /- Unused: .*sem uso/);
});

test('unknown tool', async () => {
  const r = await tools.handle('design_nope', {}, ctxOf(fakeHost()));
  assert.strictEqual(r.isError, true);
});

test('colorFamilies follows a spread of a relative import', () => {
  assert.deepStrictEqual(project.colorFamilies(repo).sort(), ['brand', 'slate', 'woot']);
  assert.deepStrictEqual(project.colorFamilies(tmp), []);
});

test('manifest tools equal tools.SCHEMAS', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'maestria-plugin.json'), 'utf8'));
  assert.deepStrictEqual(m.contributes.tools, tools.SCHEMAS);
  for (const t of m.contributes.tools) assert.ok(t.name.startsWith('design_'));
  for (const t of m.contributes.tools) assert.ok(m.activationEvents.includes(`onTool:${t.name}`));
});

test('design_board validates sizes, positions and title', async () => {
  const host = await withBoards([]);
  const bad = [{ w: 0 }, { w: 5000 }, { w: '10' }, { w: 10, h: '800' }, { w: 10, h: 4001 }, { w: 10, x: 'a' }, { w: 10, y: 1e9 }, { w: 10, title: 'x'.repeat(121) }, { w: 10, title: 5 }];
  for (const b of bad) {
    const r = await tools.handle('design_board', { name: 'v', ...b }, ctxOf(host));
    assert.strictEqual(r.isError, true, JSON.stringify(b));
  }
  const ok = await tools.handle('design_board', { name: 'v', w: 4000, h: 1, x: -5, y: 100000, title: 'ok' }, ctxOf(host));
  assert.ok(!ok.isError, textOf(ok));
});

test('design_render rejects an invalid theme', async () => {
  const host = await withBoards(['a']);
  const r = await tools.handle('design_render', { theme: 'blue' }, ctxOf(host));
  assert.strictEqual(r.isError, true);
  assert.strictEqual(textOf(r), 'theme deve ser light, dark ou both');
});

test('design_render skips images over 3.5 MB and over the 10 MB total', async () => {
  const host = await withBoards(['a', 'b', 'c']);
  const big = path.join(tmp, 'big.png');
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024)); // 3 MB each: 3 fit in 10 MB, the 4th does not
  const huge = path.join(tmp, 'huge.png');
  fs.writeFileSync(huge, Buffer.alloc(4 * 1024 * 1024));
  const open = host.openCanvas;
  host.openCanvas = async (...a) => {
    const V = await open(...a);
    const r = V.engine.render;
    V.engine.render = async function render(names, opts) {
      const m = await r.call(this, names, opts);
      for (const [n, s] of m) if (s) s.claude = { light: n === 'a' ? huge : big, dark: big };
      return m;
    };
    return V;
  };
  const r = await tools.handle('design_render', {}, ctxOf(host));
  assert.strictEqual(r.content.filter((c) => c.type === 'image').length, 3);
  assert.match(textOf(r), /a \(claro\): imagem omitida/);
  assert.match(textOf(r), /imagem omitida/);
});

test('without cwd, design_open needs an explicit canvas', async () => {
  const host = fakeHost();
  const r = await tools.handle('design_open', { name: 'z' }, ctxOf(host, { cwd: undefined }));
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /passe `canvas`/);
  const rel = await tools.handle('design_open', { canvas: 'rel/dir' }, ctxOf(host, { cwd: undefined }));
  assert.match(textOf(rel), /passe `canvas`/);
  assert.strictEqual(host.calls.length, 0);
});

test('a board registered moments ago renders and focuses right away', async () => {
  const host = await withBoards([]);
  await tools.handle('design_board', { name: 'fresh', w: 390 }, ctxOf(host));
  const r = await tools.handle('design_render', { boards: ['fresh'] }, ctxOf(host));
  assert.strictEqual(r.content.filter((c) => c.type === 'image').length, 2);
  await tools.handle('design_board', { name: 'fresh2', w: 390 }, ctxOf(host));
  const f = await tools.handle('design_focus', { board: 'fresh2' }, ctxOf(host));
  assert.ok(!f.isError, textOf(f));
});

test('design_open on a design.json without repo is a readable error', async () => {
  const host = fakeHost();
  const dir = path.join(home, 'co', 'design', 'semrepo');
  fs.mkdirSync(dir, { recursive: true });
  canvasMod.write(dir, { v: 1, title: 'semrepo', boards: {}, order: [] });
  fs.writeFileSync(path.join(dir, 'design.json'), JSON.stringify({ darkMode: { class: 'dark' }, css: [] }));
  const r = await tools.handle('design_open', { canvas: dir }, ctxOf(host, { cwd: undefined }));
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /design\.json.*"repo"/);
  assert.doesNotMatch(textOf(r), /paths\[1\]|TypeError/);
});

// ---- design_ref ----------------------------------------------------------------
const refs = require('../lib/refs');
const marks = require('../lib/marks');
const crop = require('../lib/crop');
const { readPng } = require('./png');

function refCanvas() {
  return withBoards(['a', 'b']).then((host) => {
    const dir = host.calls.find((c) => c[0] === 'openCanvas')[1];
    fs.writeFileSync(path.join(dir, 'components', 'NavItem.html'), '<a class="px-2"><span>{{ label }}</span></a>');
    fs.writeFileSync(path.join(dir, 'boards', 'a.html'), '<nav>\n  <x-nav-item label="Início"></x-nav-item>\n  <x-nav-item label="Sair"></x-nav-item>\n</nav>');
    fs.writeFileSync(path.join(dir, 'boards', 'b.html'), '<x-nav-item label="x" />');
    const data = host.dataDirOf(dir);
    // the nodes map and the 2x light png the engine leaves after a render (board a: 100x60 css px)
    const call = (i, y) => ({ k: 10 + i, rect: { x: 0, y, w: 100, h: 20 }, kind: 'component', name: 'NavItem', file: 'boards/a.html', path: [0, i],
      call: { file: 'boards/a.html', path: [0, i] }, componentFile: 'components/NavItem.html',
      children: [{ k: 20 + i, rect: { x: 0, y, w: 100, h: 20 }, kind: 'element', name: 'a', file: 'components/NavItem.html', path: [0], call: null, componentFile: null,
        children: [{ k: 30 + i, rect: { x: 4, y: y + 2, w: 40, h: 16 }, kind: 'element', name: 'span', file: 'components/NavItem.html', path: [0, 0], call: null, componentFile: null, children: [] }] }] });
    const roots = [{ k: 1, rect: { x: 0, y: 0, w: 100, h: 60 }, kind: 'element', name: 'nav', file: 'boards/a.html', path: [0], call: null, componentFile: null, children: [call(0, 0), call(1, 20)] }];
    fs.mkdirSync(path.join(data, 'nodes'), { recursive: true });
    fs.writeFileSync(path.join(data, 'nodes', 'a.json'), JSON.stringify({ rev: 1, width: 100, height: 60, roots }));
    fs.mkdirSync(path.join(data, 'png'), { recursive: true });
    const w = 200; const h = 120;
    const raw = Buffer.alloc((w * 3 + 1) * h, 200);
    for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
    fs.writeFileSync(path.join(data, 'png', 'a.light.png'), crop.encode(w, h, 3, raw, true));
    return { host, dir, data, roots };
  });
}

test('design_ref returns the call site, the component file with its boards, a crop, and marks the tab', async () => {
  const { host, dir, data, roots } = await refCanvas();
  const r = refs.open(data, dir);
  const code = r.codeFor('a', { ...roots[0].children[1].children[0].children[0], via: refs.viaOf(roots, 31) });
  const res = await tools.handle('design_ref', { ref: code }, ctxOf(host));
  assert.ok(!res.isError, textOf(res));
  const t = textOf(res);
  assert.match(t, /prancheta: a/);
  assert.match(t, new RegExp(`${path.join(dir, 'components', 'NavItem.html').replace(/[.]/g, '\\.')}`));
  assert.match(t, /<span>\{\{ label \}\}<\/span>/, 'the element in the component file');
  assert.match(t, /boards\/a\.html:3/, 'the call site of the second item, with its line');
  assert.match(t, /<x-nav-item label="Sair"><\/x-nav-item>/);
  assert.match(t, /usado em 2 pranchetas: a, b/);
  const imgs = res.content.filter((c) => c.type === 'image');
  assert.strictEqual(imgs.length, 1);
  const p = readPng(Buffer.from(imgs[0].data, 'base64'));
  assert.deepStrictEqual([p.width, p.height], [80, 32], 'the span rect at 2x');
  assert.deepStrictEqual(marks.get('t1', Date.now()), { board: 'a', rect: { x: 4, y: 22, w: 40, h: 16 }, canvas: dir });
  assert.ok(host.calls.some((c) => c[0] === 'remember' && c[1] === dir && c[2].tabId === 't1'));
});

test('design_ref of a component call gives the call and the component', async () => {
  const { host, dir, data, roots } = await refCanvas();
  const code = refs.open(data, dir).codeFor('a', roots[0].children[0]);
  const t = textOf(await tools.handle('design_ref', { ref: code }, ctxOf(host)));
  assert.match(t, /<x-nav-item label="Início"><\/x-nav-item>/);
  assert.match(t, /<a class="px-2">/);
  assert.match(t, /usado em 2 pranchetas/);
});

test('design_ref of a stale code is an error with the exact message', async () => {
  const { host, dir, data, roots } = await refCanvas();
  const code = refs.open(data, dir).codeFor('a', roots[0].children[1]);
  fs.writeFileSync(path.join(dir, 'boards', 'a.html'), '<nav><x-nav-item label="Novo"></x-nav-item><x-nav-item label="Início"></x-nav-item><x-nav-item label="Sair!"></x-nav-item></nav>');
  const r = await tools.handle('design_ref', { ref: code }, ctxOf(host));
  assert.strictEqual(r.isError, true);
  assert.strictEqual(textOf(r), 'código vencido: selecione de novo');
});

// ---- design_comments / design_comment_reply -------------------------------------
const commentsMod = require('../lib/comments');

test('design_comments lists with the resolved ref, reports stale and unknown; filters by status', async () => {
  const { host, dir, data, roots } = await refCanvas();
  const code = refs.open(data, dir).codeFor('a', roots[0].children[0]);
  const C = commentsMod.open(dir);
  const ok = C.add({ board: 'a', code, text: 'mais largo' });
  C.add({ board: 'a', code: '@n99999', text: 'fantasma' });
  const r = await tools.handle('design_comments', {}, ctxOf(host));
  const t = textOf(r);
  assert.ok(!r.isError);
  assert.match(t, new RegExp(`#${ok} \\[aberto\\] a ${code.replace('@', '@')}`));
  assert.match(t, /mais largo/);
  assert.match(t, /antes de editar: design_ref @n/);
  assert.match(t, /components\/NavItem\.html/);
  assert.match(t, /desconhecido/);
  fs.writeFileSync(path.join(dir, 'boards', 'a.html'), '<p>outro</p>\n<nav>\n  <x-nav-item label="Início"></x-nav-item>\n</nav>');
  assert.match(textOf(await tools.handle('design_comments', {}, ctxOf(host))), /vencido|stale/i);
  await tools.handle('design_comment_reply', { id: ok, text: 'feito', done: true }, ctxOf(host));
  assert.ok(!/mais largo/.test(textOf(await tools.handle('design_comments', { status: 'aberto' }, ctxOf(host)))));
  assert.match(textOf(await tools.handle('design_comments', { status: 'feito' }, ctxOf(host))), /mais largo[\s\S]*claude: feito/);
});

test('design_comments with none says so; design_comment_reply on unknown id is an error', async () => {
  const { host } = await refCanvas();
  assert.match(textOf(await tools.handle('design_comments', {}, ctxOf(host))), /nenhum comentário/i);
  const r = await tools.handle('design_comment_reply', { id: 42, text: 'x', done: false }, ctxOf(host));
  assert.strictEqual(r.isError, true);
  assert.strictEqual(textOf(r), 'Comentário 42 não existe');
});

test('guide: comments section says design_ref before editing; output hints it', () => {
  const g = fs.readFileSync(path.join(__dirname, '..', 'lib', 'guide.md'), 'utf8');
  const sec = g.slice(g.indexOf('## Comentários'));
  assert.match(sec, /design_comments[\s\S]*design_ref[\s\S]*depois edite[\s\S]*design_comment_reply/);
});

test('design_comment_reply rejects empty text; corrupt comments.json is not overwritten', async () => {
  const { host, dir } = await refCanvas();
  const id = commentsMod.open(dir).add({ board: 'a', code: '@n1', text: 'x' });
  const r = await tools.handle('design_comment_reply', { id, text: '  ', done: true }, ctxOf(host));
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /vazio/);
  fs.writeFileSync(path.join(dir, 'comments.json'), '{oops');
  const r2 = await tools.handle('design_comment_reply', { id, text: 'ok', done: true }, ctxOf(host));
  assert.strictEqual(r2.isError, true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'comments.json'), 'utf8'), '{oops');
});
