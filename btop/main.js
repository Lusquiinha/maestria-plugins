'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('./maestria');

const VIEW = 'btop';
const TITLE = 'btop';
const MISSING = 'o btop não está instalado (ou não está no PATH da Maestria).';

let tabId = null;

function onPath(name) {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function terminal(id) {
  return [{ type: 'terminal', tabId: id, expand: true, autofocus: true, empty: 'o btop fechou.' }];
}

async function release() {
  const id = tabId;
  tabId = null;
  if (id) await m.request('session.close', { tabId: id }).catch(() => {});
}

async function isOpen() {
  const r = await m.request('view.update', { viewId: VIEW }).catch(() => null);
  return Boolean(r && r.open);
}

async function open() {
  if (tabId) {
    if (await isOpen()) {
      await m.request('view.open', { viewId: VIEW, title: TITLE, modal: true, blocks: terminal(tabId) });
      return;
    }
    await release();
  }
  if (!onPath('btop')) {
    await m.request('view.open', {
      viewId: VIEW,
      title: TITLE,
      modal: true,
      width: 420,
      height: 240,
      blocks: [{ type: 'text', text: MISSING, style: 'warning' }],
    });
    return;
  }
  const shell = await m.request('session.openShell', {
    command: 'btop',
    cwd: os.homedir(),
    embedded: true,
    label: 'btop',
  });
  tabId = shell.tabId;
  await m.request('view.open', {
    viewId: VIEW,
    title: TITLE,
    modal: true,
    width: 1400,
    height: 1000,
    blocks: terminal(tabId),
  });
}

m.onRequest('command.invoke', async ({ command }) => {
  if (command === 'abrir') await open();
});

m.onNotification('event', async (e) => {
  if (e.type === 'view.closed' && e.viewId === VIEW) {
    await release();
  } else if (e.type === 'session.exited' && tabId && e.tabId === tabId) {
    await m.request('view.close', { viewId: VIEW }).catch(() => {});
    await release();
  }
});

m.start();
