'use strict';
// A aba da lateral: cada gerente com as sessões dele embaixo, desenhado como o `tree`, na cor dele.

const { colorOf, bare } = require('./links');

const STATUS_TONE = {
  working: 'accent',
  tool: 'accent',
  starting: 'purple',
  waitingPermission: 'red',
  waitingAnswer: 'yellow',
  waitingInput: 'yellow',
  idle: 'green',
  ready: 'green',
};

function rows(links, sessions) {
  const live = new Map(sessions.filter((s) => !s.exited).map((s) => [s.id, s]));
  const out = [];
  const walk = (key, lead, last, depth) => {
    const n = links.nodes[key];
    const branch = depth === 0 ? '' : `${lead}${last ? '└─ ' : '├─ '}`;
    out.push({ key, node: n, session: live.get(n.tabId) || null, depth, branch });
    const kids = links.children(key);
    const next = depth === 0 ? '' : `${lead}${last ? '    ' : '│   '}`;
    kids.forEach((k, i) => walk(k, next, i === kids.length - 1, depth + 1));
  };
  for (const k of links.roots()) walk(k, '', true, 0);
  return out;
}

function managersMenu(links, except) {
  const roots = links.roots().filter((k) => !except.includes(k));
  if (!roots.length) return [];
  return [{
    action: 'noop',
    label: 'ligar ao gerente',
    icon: 'link',
    children: roots.map((k) => ({ action: `link:${k}`, label: bare(links.nodes[k].name) || k, tone: colorOf(links.nodes[k].color).hex })),
  }];
}

function treeItem(links, { key, node, session, depth, branch }) {
  const color = colorOf(node.color);
  const name = bare(session ? session.title : node.name) || node.name;
  const base = {
    title: `${branch}${name}`,
    avatar: { shape: 'circle', color: color.hex, text: '' },
    strong: depth === 0,
    subtitleTone: color.hex,
    ...(depth === 0 ? { actions: [{ action: `panel:${key}`, icon: 'stack', tooltip: 'painel' }] } : {}),
  };
  if (!session) return { ...base, subtitle: 'fechada', dim: true, menu: [{ action: `forget:${key}`, label: 'esquecer', icon: 'trash' }] };
  const act = session.activity || {};
  const status = session.statusLabel || session.status || '';
  const menu = [
    ...(depth === 0 ? [{ action: `panel:${key}`, label: 'abrir painel', icon: 'stack' }] : []),
    ...(depth > 0 ? [{ action: `promote:${key}`, label: 'tornar gerente', icon: 'star' }] : []),
    ...managersMenu(links, links.subtree(key)).map((m) => ({ ...m, children: m.children.map((c) => ({ ...c, action: `${c.action}:${session.id}` })) })),
    { action: `unlink:${key}`, label: 'tirar da árvore', icon: 'remove' },
  ];
  return {
    ...base,
    subtitle: act.lastPrompt ? `${status} · ${act.lastPrompt}` : status,
    status: STATUS_TONE[session.status] || 'faint',
    meta: session.needsYou ? 'você' : undefined,
    metaTone: session.needsYou ? 'yellow' : undefined,
    action: `focus:${session.id}`,
    menu,
  };
}

function looseItem(links, s) {
  return {
    title: s.title || s.id,
    subtitle: s.statusLabel || s.status || '',
    icon: 'dot',
    status: STATUS_TONE[s.status] || 'faint',
    action: `focus:${s.id}`,
    menu: [
      { action: `manager:${s.id}`, label: 'tornar gerente', icon: 'star' },
      ...managersMenu(links, []).map((m) => ({ ...m, children: m.children.map((c) => ({ ...c, action: `${c.action}:${s.id}` })) })),
    ],
  };
}

function sidebar(links, sessions) {
  const all = rows(links, sessions);
  const linked = new Set(all.map((r) => r.node.tabId));
  const loose = sessions.filter((s) => s.kind === 'claude' && !s.exited && !s.embedded && !linked.has(s.id));
  const waiting = all.filter((r) => r.session && r.session.needsYou).length;
  const blocks = [
    { type: 'header', title: 'Gerentes', subtitle: `${links.roots().length} gerente(s)`, actions: [{ action: 'novo', icon: 'add', tooltip: 'novo gerente' }] },
    {
      type: 'list',
      flat: true,
      items: all.map((r) => treeItem(links, r)),
      empty: 'Nenhum gerente. Crie um no +, ou clique com o botão direito numa sessão abaixo e "tornar gerente".',
    },
  ];
  if (loose.length) {
    blocks.push({ type: 'section', text: 'outras sessões', count: loose.length });
    blocks.push({ type: 'list', flat: true, items: loose.map((s) => looseItem(links, s)) });
  }
  return { blocks, badge: waiting ? String(waiting) : '' };
}

module.exports = { sidebar, rows, STATUS_TONE };
