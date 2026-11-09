'use strict';
// As provas de um cartão: imagens copiadas pra pasta de dados (o Picture só lê de lá), PRs, áudios e log.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const AUDIO = /\.(mp3|wav|ogg|m4a|flac|opus)$/i;
const CI = ['ok', 'running', 'failed', 'none'];
const MAX = { images: 12, prs: 8, audio: 8, log: 4000 };

class ProofError extends Error {}

const text = (v) => (v == null ? '' : String(v).trim());

function file(p, re, what) {
  const abs = text(p);
  if (!path.isAbsolute(abs)) throw new ProofError(`${what} precisa de caminho absoluto: ${abs || '(vazio)'}`);
  if (!re.test(abs)) throw new ProofError(`${what} com extensão que não dá: ${abs}`);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new ProofError(`${what} não existe: ${abs}`);
  }
  if (!st.isFile()) throw new ProofError(`${what} não é arquivo: ${abs}`);
  return { abs, st };
}

/** Copia a imagem pra <dataDir>/proof e devolve o caminho relativo que o Picture lê. */
function stageImage(abs, st, dataDir) {
  const id = crypto.createHash('sha1').update(`${abs}:${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 16);
  const rel = `proof/${id}${path.extname(abs).toLowerCase()}`;
  const dest = path.join(dataDir, rel);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
  return rel;
}

function prOf(p) {
  const raw = typeof p === 'string' ? { url: p } : p || {};
  const url = text(raw.url);
  if (!/^https?:\/\//.test(url)) throw new ProofError(`PR precisa de url http(s): ${url || '(vazio)'}`);
  const ci = raw.ci == null ? 'none' : String(raw.ci);
  if (!CI.includes(ci)) throw new ProofError(`ci precisa ser um de: ${CI.join(', ')}.`);
  const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
  return { url, label: text(raw.label) || (m ? `${m[1]} #${m[2]}` : url), ci };
}

function audioOf(a) {
  const raw = typeof a === 'string' ? { path: a } : a || {};
  const { abs } = file(raw.path, AUDIO, 'áudio');
  return { path: abs, label: text(raw.label) || path.basename(abs).replace(AUDIO, '') };
}

/** Valida e normaliza as provas; as imagens vão pra pasta de dados. Sem dataDir, imagem é recusada. */
function proofOf(raw, dataDir) {
  if (raw == null) return null;
  const take = (k) => {
    const v = raw[k] == null ? [] : raw[k];
    if (!Array.isArray(v)) throw new ProofError(`proof.${k} precisa ser uma lista.`);
    if (v.length > MAX[k]) throw new ProofError(`No máximo ${MAX[k]} itens em proof.${k}.`);
    return v;
  };
  const images = take('images').map((p) => {
    if (!dataDir) throw new ProofError('esta Maestria não mandou a pasta de dados do plugin; imagem não dá.');
    const { abs, st } = file(p, IMAGE, 'imagem');
    return { path: abs, rel: stageImage(abs, st, dataDir) };
  });
  const prs = take('prs').map(prOf);
  const audio = take('audio').map(audioOf);
  const log = text(raw.log).slice(-MAX.log);
  if (!images.length && !prs.length && !audio.length && !log) return null;
  return { images, prs, audio, log };
}

module.exports = { proofOf, audioOf, ProofError, CI, AUDIO };
