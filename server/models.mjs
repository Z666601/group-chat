// 模型目录：从本机可用来源汇总可选大模型，供界面下拉选择
import fs from 'node:fs';
import path from 'node:path';

let cache = null;
let cacheAt = 0;
const TTL_MS = 60_000;

const HERMES_CONFIG = 'C:/Users/34288/AppData/Local/hermes/config.yaml';
const EKKO_CATALOG = 'C:/Users/34288/.hermes-web-ui/cache/provider-model-catalog.json';

/** 从 Hermes config.yaml 提取 providers.*.models.* 的模型 id */
function fromHermes() {
  const out = [];
  try {
    const txt = fs.readFileSync(HERMES_CONFIG, 'utf8');
    const lines = txt.split(/\r?\n/);
    let inProviders = false;
    let provider = '';
    let inModels = false;
    for (const line of lines) {
      if (/^providers:\s*$/.test(line)) { inProviders = true; continue; }
      if (inProviders && /^\S/.test(line) && !/^providers:/.test(line)) { inProviders = false; }
      if (!inProviders) continue;
      const p = line.match(/^  ([a-zA-Z0-9_.-]+):\s*$/);
      if (p) { provider = p[1]; inModels = false; continue; }
      if (/^    models:\s*$/.test(line)) { inModels = true; continue; }
      if (inModels) {
        const m = line.match(/^      ([a-zA-Z0-9][a-zA-Z0-9._/-]{1,48}):\s*\{\}\s*$/);
        if (m) out.push({ id: m[1], provider, source: 'hermes' });
        else if (/^    \S/.test(line)) inModels = false;
      }
    }
  } catch {
    /* 文件不存在时忽略 */
  }
  return out;
}

/** 从 Ekko Studio 的模型目录缓存里收集模型 id */
function fromEkko() {
  const out = [];
  try {
    const j = JSON.parse(fs.readFileSync(EKKO_CATALOG, 'utf8'));
    const seen = new Set();
    const walk = (o, depth, provider) => {
      if (!o || depth > 4 || out.length > 300) return;
      if (Array.isArray(o)) {
        for (const x of o.slice(0, 200)) walk(x, depth + 1, provider);
        return;
      }
      if (typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) {
          if (v && typeof v === 'object' && typeof v.id === 'string' && !seen.has(v.id)) {
            seen.add(v.id);
            out.push({ id: v.id, provider: provider || k, source: 'ekko' });
          }
          walk(v, depth + 1, provider || k);
        }
        return;
      }
      if (typeof o === 'string' && /^[a-z0-9][a-z0-9._-]{3,48}$/.test(o) && !seen.has(o)) {
        seen.add(o);
        out.push({ id: o, provider: provider || '', source: 'ekko' });
      }
    };
    walk(j, 0, '');
  } catch {
    /* 忽略 */
  }
  return out;
}

/**
 * 汇总模型目录。fallback 来自 agents.config.json 的 modelOptions，
 * 保证即使所有本地来源都读不到，下拉里也有可选项目。
 */
export function getModelCatalog(fallback = []) {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;

  const map = new Map(); // id -> { id, provider, source }
  const push = (item) => {
    const id = String(item.id || '').trim();
    if (!id || id.length > 64) return;
    if (!map.has(id)) map.set(id, { id, provider: item.provider || '', source: item.source || '' });
  };

  for (const f of fallback) push({ id: typeof f === 'string' ? f : f.id, provider: '', source: 'config' });
  for (const m of fromHermes()) push(m);
  for (const m of fromEkko()) push(m);

  const models = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  cache = { generatedAt: new Date().toISOString(), count: models.length, models };
  cacheAt = now;
  return cache;
}

export function findModel(id) {
  const cat = getModelCatalog();
  return cat.models.find((m) => m.id === id) || null;
}
