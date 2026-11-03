'use strict';
// The Design tab in the Maestria sidebar (ui/sidebar.rfwtxt) and the
// `abrir` picker: the canvases, most recent first, each with its project.
// Pure except for reading design.json and listing the canvases.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const canvasMod = require('./canvas');

const TEXT = 'Para criar um design novo, peça ao Claude numa sessão: "cria uma tela de…"';
const EMPTY_BANNER = 'Nenhum canvas ainda. Peça ao Claude numa sessão: "cria uma tela de…"';

// The repo folder of design.json, else the company folder (<company>/design/<name>).
function projectOf(dir) {
  try {
    const repo = JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8')).repo;
    if (typeof repo === 'string' && repo) return path.basename(path.resolve(dir, repo));
  } catch { /* no design.json */ }
  const parent = path.dirname(dir);
  return path.basename(parent) === 'design' ? path.basename(path.dirname(parent)) : '';
}

function canvases({ home = os.homedir(), last = {} } = {}) {
  return canvasMod.list({ home, last }).map((c) => ({ ...c, project: projectOf(c.dir) }));
}

function data(list) {
  const items = (list || []).map((c) => ({ name: c.name, project: c.project || '', hasProject: !!c.project, open: `open:${c.dir}` }));
  return { text: TEXT, canvases: items, hasCanvases: items.length > 0 };
}

function blocks(list) {
  const out = [{ type: 'text', text: TEXT }];
  if (list && list.length) {
    out.push({ type: 'list', flat: true, items: list.map((c) => ({ title: c.name, ...(c.project ? { subtitle: c.project } : {}), action: `open:${c.dir}` })) });
  }
  return out;
}

const tilde = (dir, home) => (home && (dir === home || dir.startsWith(`${home}${path.sep}`)) ? `~${dir.slice(home.length)}` : dir);

function pickItems(list, { home = os.homedir() } = {}) {
  return (list || []).map((c) => {
    const where = tilde(c.dir, home);
    return { value: c.dir, label: c.name, detail: c.project ? `${c.project} · ${where}` : where };
  });
}

const viewTitle = (title) => (title ? `Design · ${title}` : 'Design');

module.exports = { TEXT, EMPTY_BANNER, projectOf, canvases, data, blocks, pickItems, viewTitle };
