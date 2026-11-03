'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VERSION = 'v4.3.4';
const BASE = `https://github.com/tailwindlabs/tailwindcss/releases/download/${VERSION}`;
const ASSETS = {
  'linux-x64': ['tailwindcss-linux-x64', '149a8ece5b855587a9c10de6da9dcbcfad0e47c4ed5dca219f721b3eae39d817'],
  'linux-arm64': ['tailwindcss-linux-arm64', 'f6d7baae1d350ed3a2defe98d0b5cc58e37400c0173b2e38d42f690ccc4bbfe1'],
  'darwin-arm64': ['tailwindcss-macos-arm64', 'a516a11b439bfbb5ecd4a2d13b75e6cdcc284dc710aed8731e31d2e5c03895a4'],
  'darwin-x64': ['tailwindcss-macos-x64', '7ec771593a1fb8bbd204f70429361b0158f7989e4136bc68d04513bf543a15ba'],
};

function asset(platform = process.platform, arch = process.arch) {
  const found = ASSETS[`${platform}-${arch}`];
  if (!found) throw new Error(`não há Tailwind pronto pra ${platform}-${arch}: instale o tailwindcss no projeto`);
  const [name, sha256] = found;
  return { name, sha256, url: `${BASE}/${name}` };
}

function cacheRoot() {
  return process.env.MAESTRIA_PLUGIN_DATA || path.join(os.homedir(), '.maestria-rs', 'plugin-data', 'maestria.design');
}

function binPath(root = cacheRoot(), a = asset()) {
  return path.join(root, 'tailwind', `${VERSION}-${a.name}`);
}

async function download(a, dest, fetchImpl) {
  const res = await fetchImpl(a.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== a.sha256) throw new Error(`o arquivo baixado não confere (sha256 ${got.slice(0, 12)}…)`);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(tmp, bytes, { mode: 0o755 });
  fs.renameSync(tmp, dest);
}

const inFlight = new Map();

async function ensure({ root = cacheRoot(), log = () => {}, fetchImpl = fetch, a = asset() } = {}) {
  const dest = binPath(root, a);
  if (fs.existsSync(dest)) return dest;
  if (!inFlight.has(dest)) {
    log(`baixando o Tailwind ${VERSION} (uma vez só)`);
    const job = download(a, dest, fetchImpl)
      .catch((e) => { throw new Error(`não consegui baixar o Tailwind: ${e.message}`); })
      .finally(() => inFlight.delete(dest));
    inFlight.set(dest, job);
  }
  await inFlight.get(dest);
  return dest;
}

module.exports = { VERSION, asset, binPath, cacheRoot, ensure };
