'use strict';

// O Design na Maestria: a cola entre o protocolo (`mx`) e o motor (lib/engine).
// Cada canvas aberto é uma janela rfw (`canvas:<hash>`) com o seu motor (um
// Chrome e um Tailwind); fechar a janela fecha o motor. Nunca escreva no
// stdout: é o protocolo.
//
// Pra as ferramentas MCP: `openCanvas(dir, { tabId, cwd })` abre ou traz pra
// frente o canvas ao lado da sessão; `focusBoard(viewOrDir, name)` foca uma
// prancheta; `viewOf(dir)` devolve a janela aberta (com `.engine`).
// O comando `design: abrir` funciona sem sessão em foco: escolhe (ou cria) um
// canvas e, sem um claude ao lado, abre um no repo do canvas.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mx = require('./maestria');
const canvasMod = require('./lib/canvas');
const engineMod = require('./lib/engine');
const view = require('./lib/view');
const follow = require('./lib/follow');
const tools = require('./lib/tools');
const scanner = require('./lib/scanner');
const sweep = require('./lib/sweep');
const refs = require('./lib/refs');

const PLUGIN_ID = 'maestria.design';
const UI_FILE = path.join(__dirname, 'ui', 'canvas.rfwtxt');
const HIGHLIGHT_MS = 3000;
const CLOSE_GRACE_MS = 600; // the host SIGTERMs 0.8 s after `shutdown`
// The host only tells about closed modals (view.closed), not closed grid tabs:
// probe each open view with an empty view.update and close it on {open:false}.
const PROBE_MS = Number(process.env.MAESTRIA_DESIGN_PROBE_MS) > 0 ? Number(process.env.MAESTRIA_DESIGN_PROBE_MS) : 5000;

const OUTDATED = [
  { type: 'heading', text: 'este maestria não desenha o canvas do design' },
  { type: 'text', text: 'o canvas precisa de uma versão do maestria com widgets (rfw). atualize o app e abra de novo.' },
];

const state = {
  caps: { rfw: false, picture: 0, zoomFocus: 0, zoomPan: 0, keyListener: 0 },
  pluginDir: __dirname,
  dataDir: process.env.MAESTRIA_PLUGIN_DATA || path.join(os.homedir(), '.maestria-rs', 'plugin-data', PLUGIN_ID),
  home: os.homedir(), // where `design: abrir` looks for canvases (Desktop/Work/*/design/*)
  views: new Map(), // viewId -> V
  // the last canvas opened per session / cwd, and when each canvas was last opened (ms)
  last: { byTab: {}, byCwd: {}, usedAt: {} },
  engines: new Set(), // engines not yet closed (killed on exit, even mid-close)
  pending: new Map(), // engine dataDir -> engineMod.open() still in flight
  probe: null, // the timer of the closed-tab probe
  exiting: false,
};

// the blue band over what Claude is editing; a timed-out scan redraws its canvas
const scans = scanner.create({ onChange: (dir) => { const V = viewOf(dir); if (V) render(V); } });

const errText = (e) => String((e && e.message) || e);
const hashOf = (dir) => crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 12);
const viewIdOf = (dir) => `canvas:${hashOf(dir)}`;
const viewOf = (dir) => state.views.get(viewIdOf(dir)) || null;
const banner = (text) => mx.request('window.showBanner', { text }).catch(() => {});

function library() {
  return fs.readFileSync(UI_FILE, 'utf8');
}

// --- o último canvas de cada sessão ------------------------------------------------

const lastFile = () => path.join(state.dataDir, 'last.json');

function loadLast() {
  try {
    const j = JSON.parse(fs.readFileSync(lastFile(), 'utf8'));
    state.last = { byTab: j.byTab || {}, byCwd: j.byCwd || {}, usedAt: j.usedAt || {} };
  } catch { /* first run */ }
}

function remember(dir, { tabId, cwd } = {}) {
  if (tabId) { delete state.last.byTab[tabId]; state.last.byTab[tabId] = dir; } // key order = most recent link last
  if (cwd) state.last.byCwd[cwd] = dir;
  if (!state.last.usedAt) state.last.usedAt = {};
  state.last.usedAt[dir] = Date.now();
  try {
    fs.mkdirSync(state.dataDir, { recursive: true });
    fs.writeFileSync(lastFile(), `${JSON.stringify(state.last, null, 2)}\n`);
  } catch (e) { mx.log('last.json:', errText(e)); }
}

function lastFor({ tabId, cwd }) {
  const dir = (tabId && state.last.byTab[tabId]) || (cwd && state.last.byCwd[cwd]) || null;
  return dir && fs.existsSync(path.join(dir, 'canvas.json')) ? dir : null;
}

// --- a janela -----------------------------------------------------------------------

// The nodes tree of a board (lib/nodes, written by the engine with each
// render), cached until the board renders again; null before the first one.
function nodesOf(V, name) {
  if (V.nodes.has(name)) return V.nodes.get(name);
  let tree = null;
  try { tree = JSON.parse(fs.readFileSync(path.join(dataDirOf(V.dir), 'nodes', `${name}.json`), 'utf8')); } catch { /* not rendered yet */ }
  if (tree) V.nodes.set(name, tree);
  return tree;
}

function data(V) {
  const nodes = new Map();
  if (state.caps.zoomPan && state.caps.keyListener && V.canvas) {
    for (const name of V.canvas.order || []) { const t = nodesOf(V, name); if (t) nodes.set(name, t); }
  }
  const d = view.build({ canvas: V.canvas, states: V.states, ui: V.ui, caps: state.caps, hash: V.hash, scans: scans.active(V.dir), nodes });
  return view.wire(d);
}

async function render(V) {
  if (V.closed || !V.shown) return; // an update before view.open answers would read as "closed"
  if (!state.caps.picture) {
    try { view.cacheSprites({ pluginDir: state.pluginDir, hash: V.hash, states: V.states }); } catch (e) { mx.log('sprites:', errText(e)); }
  }
  let res;
  try {
    res = await mx.request('view.update', { viewId: V.viewId, title: V.title, data: data(V) });
  } catch (e) {
    mx.log('view.update:', errText(e));
    return;
  }
  if (res && res.open === false) await closeView(V.viewId);
}

function command(V, cmd) {
  V.ui.command = cmd;
  V.ui.rev += 1;
  V.lastCommand = Date.now();
  return render(V);
}

function focusBoard(target, name) {
  const V = typeof target === 'string' ? viewOf(target) : target;
  if (!V) throw new Error('o canvas não está aberto');
  if (!V.canvas || !Object.prototype.hasOwnProperty.call(V.canvas.boards, name)) throw new Error(`prancheta não existe: ${name}`);
  return command(V, { kind: 'focus', board: name });
}

function highlight(V, name) {
  clearTimeout(V.highlightTimer);
  V.ui.highlight = name;
  V.highlightTimer = setTimeout(() => {
    if (V.ui.highlight !== name) return;
    V.ui.highlight = null;
    render(V);
  }, HIGHLIGHT_MS);
}

function onBoard(V, name, s) {
  scans.end(name, V.dir); // the new image is here: the scan over it stops
  // new boxes: node ids of the old render mean nothing now
  V.nodes.delete(name);
  if (V.ui.sel && V.ui.sel.board === name) V.ui.sel = null;
  if (V.ui.level && V.ui.level.board === name) V.ui.level = null;
  if (s) V.states.set(name, s);
  else V.states.delete(name);
  // the first render of the boards that were there at open is not news
  if (V.fresh.delete(name) || !s) return render(V);
  highlight(V, name);
  if (follow.shouldJump({ now: Date.now(), lastUserMove: V.lastUserMove, follow: V.ui.follow })) {
    return command(V, { kind: 'focus', board: name });
  }
  return render(V);
}

/** Abre (ou traz pra frente) o canvas da pasta `dir`, ao lado da sessão `tabId`. */
async function openCanvas(input, { tabId, cwd } = {}) {
  const dir = path.resolve(input);
  if (tabId) await mx.request('session.focus', { tabId }).catch((e) => mx.log('session.focus:', errText(e)));
  const viewId = viewIdOf(dir);
  if (!state.caps.rfw) {
    await mx.request('view.open', { viewId, title: 'Design', blocks: OUTDATED });
    return null;
  }
  remember(dir, { tabId, cwd });
  const open = state.views.get(viewId);
  if (open) {
    if (open.failed) { // the last open failed (no design.json, chrome missing…): try again
      open.failed = false;
      open.ui.message = 'abrindo o canvas…';
      open.ready = startEngine(open);
    } else if (open.engine && open.engine.chromeError) { // chrome gave up for good: a fresh engine
      const old = open.engine;
      open.engine = null;
      open.ui.message = 'abrindo o canvas…';
      open.ready = closeEngine(old).then(() => startEngine(open));
    }
    await mx.request('view.open', { viewId, title: open.title, rfw: { library: library(), root: 'root' }, data: data(open) });
    await open.ready;
    return open;
  }
  let canvas;
  try { canvas = canvasMod.read(dir); } catch { canvas = { title: path.basename(dir), boards: {}, order: [], warnings: [] }; }
  const V = {
    viewId,
    dir,
    hash: hashOf(dir),
    title: `design: ${canvas.title}`,
    canvas,
    states: new Map(),
    ui: { theme: 'both', follow: true, highlight: null, command: null, rev: 0, message: 'abrindo o canvas…', sel: null, level: null, scale: 1, fit: 1 },
    nodes: new Map(), // board -> nodes tree (selection)
    engine: null,
    fresh: new Set(),
    lastUserMove: 0,
    lastTap: null, // { at, sel, level } before the last selecting tap
    lastMoveAt: 0, // the user's last pan or wheel (onMove): a tap right after it is the pan's end
    lastCommand: 0,
    highlightTimer: null,
    closed: false,
    shown: false,
    failed: false,
  };
  state.views.set(viewId, V);
  startProbe();
  V.ready = startEngine(V); // Chrome and Tailwind start while the view opens
  try {
    await mx.request('view.open', { viewId, title: V.title, rfw: { library: library(), root: 'root' }, data: data(V) });
  } catch (e) {
    await closeView(viewId); // no view: its engine closes as soon as it is up
    throw e;
  }
  V.shown = true;
  await render(V); // whatever arrived while view.open was in flight
  await V.ready;
  return V;
}

async function startEngine(V) {
  let eng;
  const dataDir = path.join(state.dataDir, V.hash);
  const opening = engineMod.open(V.dir, { dataDir, log: (m) => mx.log(m) });
  state.pending.set(dataDir, opening);
  try {
    eng = await opening;
  } catch (e) {
    if (state.pending.get(dataDir) === opening) state.pending.delete(dataDir);
    mx.log(`abrir ${V.dir}:`, errText(e));
    V.ui.message = `não abriu: ${errText(e)}`;
    V.failed = true;
    await render(V);
    return;
  }
  state.engines.add(eng);
  if (state.pending.get(dataDir) === opening) state.pending.delete(dataDir);
  if (V.closed || state.exiting) { await closeEngine(eng); return; }
  V.engine = eng;
  V.canvas = eng.canvas;
  V.title = `design: ${eng.canvas.title}`;
  V.fresh = new Set(eng.renderable());
  V.ui.message = '';
  eng.on('board', (name, s) => onBoard(V, name, s));
  eng.on('canvas', (c) => { V.canvas = c; V.title = `design: ${c.title}`; render(V); });
  await render(V);
}

async function closeView(viewId) {
  const V = state.views.get(viewId);
  if (!V) return;
  state.views.delete(viewId);
  if (!state.views.size) stopProbe();
  V.closed = true;
  clearTimeout(V.highlightTimer);
  scans.clear(V.dir);
  if (!state.caps.picture) { try { view.clearSprites({ pluginDir: state.pluginDir, hash: V.hash }); } catch { /* best effort */ } }
  if (V.engine) await closeEngine(V.engine);
}

async function closeEngine(eng) {
  await eng.close().catch((e) => mx.log('fechar o motor:', errText(e)));
  state.engines.delete(eng);
}

function startProbe() {
  if (state.probe) return;
  state.probe = setInterval(probeViews, PROBE_MS);
  state.probe.unref();
}

function stopProbe() {
  clearInterval(state.probe);
  state.probe = null;
}

async function probeViews() {
  for (const V of [...state.views.values()]) {
    if (!V.shown || V.closed) continue;
    let res;
    try { res = await mx.request('view.update', { viewId: V.viewId }); } catch { continue; }
    if (res && res.open === false) await closeView(V.viewId);
  }
}

// --- as ações da janela ---------------------------------------------------------------

// "<board>:<k>" -> { board, k } of a node that exists, or null.
function nodeArg(V, arg) {
  const j = arg.lastIndexOf(':');
  const board = arg.slice(0, j);
  const k = Number(arg.slice(j + 1));
  if (j <= 0 || !Number.isInteger(k)) return null;
  const node = view.findNode(nodesOf(V, board), k);
  return node ? { board, k, node } : null;
}

function clearSelection(V) {
  if (!V.ui.sel && !V.ui.level) return null;
  V.ui.sel = null;
  V.ui.level = null;
  return render(V);
}

// Ctrl+C: the short code of the selected node to the clipboard.
async function copySelection(V) {
  const sel = V.ui.sel;
  const tree = sel && nodesOf(V, sel.board);
  const node = tree && view.findNode(tree, sel.k);
  if (!node) return;
  let code;
  try {
    code = refs.open(dataDirOf(V.dir), V.dir).codeFor(sel.board, { ...node, via: refs.viaOf(tree.roots, node.k) });
  } catch (e) {
    return banner(errText(e));
  }
  await mx.request('clipboard.write', { text: code });
  banner(`copiado ${code}`);
}

const TAP_AFTER_MOVE_MS = 250;

// The zoom scale and the app's fit factor (onZoom/onMove extras; fit is 1 on
// apps that do not send it), so the selection chrome keeps its size on screen;
// redraws only when something selected has to follow them.
function zoomOf(V, vals) {
  const s = Number(vals.scale);
  const f = Number(vals.fit);
  const scale = s > 0 ? s : V.ui.scale;
  const fit = f > 0 ? f : 1;
  const changed = scale !== V.ui.scale || fit !== V.ui.fit;
  V.ui.scale = scale;
  V.ui.fit = fit;
  return changed;
}
function rescale(V, vals) {
  return zoomOf(V, vals) && V.ui.sel ? render(V) : null;
}

const KEY_ZOOM = { 'ctrl+0': 'fit', 'ctrl+=': 'in', 'ctrl+-': 'out' };

async function onAction(V, act, vals = {}) {
  const i = act.indexOf(':');
  const verb = i < 0 ? act : act.slice(0, i);
  const arg = i < 0 ? '' : act.slice(i + 1);
  const now = Date.now();
  // The click that ends a pan (Space+left-drag) is not a selection. onMove
  // comes 200 ms after the pan settles, so it can arrive before the click
  // (dropped here) or just after it (the click is undone on `move`).
  if (['sel', 'in', 'child', 'clear'].includes(verb)) {
    if (now - V.lastMoveAt < TAP_AFTER_MOVE_MS) return null;
    V.lastTap = { at: now, sel: V.ui.sel, level: V.ui.level };
  }
  if (act === 'clear') return clearSelection(V);
  if (verb === 'sel' || verb === 'in' || verb === 'child') {
    const hit = nodeArg(V, arg);
    if (!hit) return null;
    // a node on another board than the opened level sits at that board's top
    if (V.ui.level && V.ui.level.board !== hit.board) V.ui.level = null;
    V.ui.sel = { board: hit.board, k: hit.k };
    // a double click on a child of the selected node (layered over the level)
    // picks it, and its siblings become the clickable level
    if (verb === 'child') {
      const parent = view.parentOf(nodesOf(V, hit.board), hit.k);
      V.ui.level = parent ? { board: hit.board, k: parent.k } : null;
    }
    return render(V);
  }
  if (verb === 'rename' && arg) {
    let canvas;
    try { canvas = canvasMod.read(V.dir); } catch (e) { return banner(errText(e)); }
    const b = canvas.boards[arg];
    if (!b) return null;
    const current = typeof b.title === 'string' && b.title ? b.title : arg;
    const name = await mx.request('window.input', { title: 'design: renomear tela', placeholder: 'Nome da tela', value: current });
    const next = typeof name === 'string' ? name.trim() : '';
    if (!next || next === current) return null;
    canvasMod.write(V.dir, { ...canvas, boards: { ...canvas.boards, [arg]: { ...b, title: next } } });
    return null; // the engine watches canvas.json and re-renders
  }
  if (verb === 'copy') {
    const hit = nodeArg(V, arg);
    if (!hit) return null;
    V.ui.sel = { board: hit.board, k: hit.k };
    await copySelection(V);
    return render(V);
  }
  if (act === 'key') {
    const key = String(vals.key || '');
    if (key === 'ctrl+c') return copySelection(V);
    if (key === 'escape') return clearSelection(V);
    if (KEY_ZOOM[key]) { V.lastUserMove = now; return command(V, { kind: KEY_ZOOM[key] }); }
    return null;
  }
  // the user's own navigation (zoom keys, double-click, the board menu): follow backs off
  if (verb === 'zoom' && ['in', 'out', 'fit'].includes(arg)) { V.lastUserMove = now; return command(V, { kind: arg }); }
  if (act === 'zoom') {
    // onZoom also reports the end of our own commands
    if (follow.isUserMove({ now, lastCommand: V.lastCommand })) V.lastUserMove = now;
    return rescale(V, vals);
  }
  if (act === 'move') { // onMove only fires for the user's own pan or wheel
    V.lastUserMove = now;
    V.lastMoveAt = now;
    const tap = V.lastTap;
    V.lastTap = null;
    if (tap && now - tap.at < TAP_AFTER_MOVE_MS) { // that tap ended this pan: undo it
      V.ui.sel = tap.sel;
      V.ui.level = tap.level;
      zoomOf(V, vals);
      return render(V);
    }
    return rescale(V, vals);
  }
  if (act === 'seguir') { V.ui.follow = !V.ui.follow; return render(V); }
  if (verb === 'tema' && ['light', 'dark', 'both'].includes(arg)) { V.ui.theme = arg; return render(V); }
  if (verb === 'focus' && arg) { V.lastUserMove = now; return focusBoard(V, arg); }
  mx.log('ação desconhecida:', act);
  return null;
}

// --- os comandos ----------------------------------------------------------------------

const NOVO = ':novo'; // the pick value of "novo canvas…" (canvas values are absolute paths)
const NAME_HINT = 'use letras minúsculas, números, - e _';

const promptFor = (dir) => `Call design_open with canvas="${dir}" and wait for my request.`;

/** O repo do canvas (design.json), pra abrir o claude nele. */
function repoOf(dir) {
  try {
    const repo = JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8')).repo;
    if (typeof repo === 'string' && repo) return path.resolve(dir, repo);
  } catch { /* no design.json */ }
  return null;
}

/** As sessões do claude vivas (uma hibernada serve), por id. */
async function liveClaudeTabs() {
  let list;
  try { list = await mx.request('sessions.list', {}); } catch (e) { mx.log('sessions.list:', errText(e)); return new Set(); }
  return new Set((list || []).filter((x) => x && x.kind === 'claude' && !x.exited).map((x) => x.id));
}

/**
 * Abre o canvas ao lado de um claude: o do contexto, senão o último ainda aberto
 * que já estava ligado a este canvas, senão um novo no repo do canvas.
 * `fresh` sempre abre um claude novo (o `novo canvas…`).
 */
async function openWithSession(dir, context, { fresh = false } = {}) {
  const { cwd } = context || {};
  if (!fresh) {
    const live = await liveClaudeTabs();
    const ctxTab = context && context.tabId;
    if (ctxTab && live.has(ctxTab)) return openCanvas(dir, { tabId: ctxTab, cwd });
    const linked = Object.keys(state.last.byTab).filter((t) => state.last.byTab[t] === dir).reverse();
    const tabId = linked.find((t) => live.has(t));
    if (tabId) return openCanvas(dir, { tabId, cwd });
  }
  const repo = repoOf(dir) || cwd || path.dirname(dir);
  const opened = await mx.request('session.openClaude', { cwd: repo, prompt: promptFor(dir) });
  return openCanvas(dir, { tabId: opened && opened.tabId, cwd: repo });
}

async function askName() {
  let value = '';
  let prompt;
  for (;;) {
    const name = await mx.request('window.input', {
      title: 'design: novo canvas', placeholder: 'nome do canvas', value, ...(prompt ? { prompt } : {}),
    });
    if (!name) return null;
    if (canvasMod.validName(name)) return name;
    value = name;
    prompt = `"${name}" não serve: ${NAME_HINT}`;
  }
}

async function novoCanvas(context) {
  const name = await askName();
  if (!name) return null;
  const folders = (await mx.request('folders.list', {})) || [];
  if (!folders.length) return banner('nenhuma pasta na maestria: adicione o projeto e tente de novo');
  const root = await mx.request('window.pick', {
    title: `design: novo canvas "${name}"`,
    placeholder: 'em qual projeto?',
    items: folders.map((f) => ({ value: f.root, label: f.name, detail: f.root })),
  });
  if (!root) return null;
  const dir = canvasMod.defaultDir({ cwd: root, name, home: state.home }) || path.join(path.dirname(root), 'design', name);
  canvasMod.init(dir, { repo: canvasMod.gitRoot(root) });
  return openWithSession(dir, context, { fresh: true }); // a new canvas gets its own claude, in its project
}

async function abrir(context) {
  const canvases = canvasMod.list({ home: state.home, last: state.last });
  const choice = await mx.request('window.pick', {
    title: 'design: abrir',
    placeholder: 'qual canvas?',
    items: [
      { value: NOVO, label: 'novo canvas…', detail: 'escolha o nome e o projeto' },
      ...canvases.map((c) => ({ value: c.dir, label: c.name, detail: c.dir })),
    ],
  });
  if (!choice) return null;
  if (choice === NOVO) return novoCanvas(context);
  return openWithSession(choice, context);
}

// --- o protocolo ----------------------------------------------------------------------

mx.onRequest('initialize', (params) => {
  state.caps = {
    rfw: Number(params.rfw) >= 1,
    picture: Number(params.picture) || 0,
    zoomFocus: Number(params.zoomFocus) || 0,
    zoomPan: Number(params.zoomPan) || 0,
    keyListener: Number(params.keyListener) || 0,
  };
  if (params.dataDir) state.dataDir = params.dataDir;
  if (params.pluginDir) state.pluginDir = params.pluginDir;
  loadLast();
  try { sweep.ensure(state.pluginDir); } catch (e) { mx.log('sweep.png:', errText(e)); }
  return {};
});

mx.onRequest('command.invoke', ({ command: id, context }) => {
  // Responde na hora e trabalha depois: o command.invoke tem 30 s, e o pick espera o usuário.
  const run = (fn) => Promise.resolve().then(fn).catch((e) => {
    mx.log(id, errText(e));
    banner(errText(e));
  });
  if (id === 'abrir') run(() => abrir(context));
  else throw new Error(`comando desconhecido: ${id}`);
  return null;
});

// What the MCP tools use from here (so tests of lib/tools can fake it).
const dataDirOf = (dir) => path.join(state.dataDir, hashOf(dir)); // the engine's data dir of a canvas
const host = { request: mx.request, openCanvas, viewOf, focusBoard, lastFor, dataDirOf, remember };

mx.onRequest('tool.call', ({ tool, args, tabId, cwd }) => tools.handle(tool, args, { tabId, cwd, host }));

mx.onNotification('view.action', async ({ viewId, action, values }) => {
  const V = state.views.get(viewId);
  if (!V) return;
  const vals = values || {};
  const act = String(vals.a || vals.action || action || '');
  try {
    await onAction(V, act, vals);
  } catch (e) {
    mx.log(`ação ${act}:`, errText(e));
    banner(errText(e));
  }
});

// Hooks from a tab linked to an open canvas (last.json byTab): PreToolUse
// scans what it edits; PostToolUse(Failure) is the edit's own end.
const HOOKS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

function onHook(e) {
  if (!HOOKS.has(e.name)) return;
  const linkedDir = (tab) => state.last.byTab[tab] || null;
  const redraw = (dirs) => { for (const dir of new Set(dirs)) { const V = viewOf(dir); if (V) render(V); } };
  if (e.name !== 'PreToolUse') { redraw(scans.finish(e, { linkedDir })); return; }
  const canvases = [];
  for (const V of state.views.values()) {
    if (V.closed || !V.engine || !V.canvas) continue;
    canvases.push({ dir: V.dir, boards: V.canvas.order || [], uses: V.engine.uses || new Map() });
  }
  if (!canvases.length) return;
  redraw(scans.onHook({ tabId: e.tabId, payload: e.payload }, { canvases, linkedDir }).map((t) => t.dir));
}

mx.onNotification('event', (e) => {
  if (!e) return;
  if (e.type === 'view.closed') closeView(e.viewId);
  else if (e.type === 'hook') {
    try { onHook(e); } catch (err) { mx.log('hook:', errText(err)); }
  }
});

// --- sem órfãos: o Chrome e o Tailwind morrem com o plugin ------------------------------

// Engines still inside engineMod.open() have no handle yet: find their Chrome and
// Tailwind by the engine data dir in the command line (Linux /proc).
function killByDirSync(dir) {
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch { return; }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let cmd;
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (!cmd.includes(dir)) continue;
    try { process.kill(-Number(pid), 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
  }
}

function killAllSync() {
  state.exiting = true;
  for (const dir of state.pending.keys()) killByDirSync(dir);
  for (const eng of state.engines) {
    const c = eng.chrome;
    if (c && !c.exited && c.proc && c.proc.pid) { try { process.kill(-c.proc.pid, 'SIGKILL'); } catch { /* gone */ } }
    const t = eng.tw && eng.tw.child;
    if (t && t.pid) { try { t.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

async function closeAll() {
  state.exiting = true;
  stopProbe();
  // opens in flight close themselves on `exiting` once they finish
  const all = [...state.views.keys()].map((id) => closeView(id)).concat([...state.pending.values()].map((p) => p.catch(() => {})));
  await Promise.race([Promise.all(all), new Promise((r) => { setTimeout(r, CLOSE_GRACE_MS).unref(); })]);
}

mx.onNotification('shutdown', async () => {
  await closeAll();
  killAllSync(); // whatever did not close in time
  process.exit(0);
});

process.on('exit', killAllSync);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    killAllSync();
    process.exit(0);
  });
}

mx.start();

module.exports = { state, onAction, abrir, openCanvas, focusBoard, viewOf, hashOf, render, closeView, command, onHook, scans };
