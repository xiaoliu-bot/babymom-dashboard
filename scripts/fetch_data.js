/* ============================================================
 * fetch_data.js — GitHub Action 取数脚本（v3：Tushare 免费档为主 + 东财备份）
 * ------------------------------------------------------------
 * 数据源策略（用户拍板：「Tushare 免费档 + 东财备份」）：
 *   ★ 主力 = Tushare 免费档（从 GitHub 美国 runner 可直连，无需大陆 IP）：
 *       - stock_basic  → 全 A 股列表 + 行业(industry) + 流通股本(float_share)，直接当「板块篮子」
 *       - daily(trade_date=当天) 批量 → 一次拿全市场 OHLC/涨跌幅/成交量/成交额
 *       - index_daily(000001.SH) → 上证指数序列
 *       → 自聚合成板块，算出「宝妈指数」6 维 + 讨论度（行为代理）
 *   ☆ 备份 = 东方财富（仅大陆 IP / 自托管 runner 才跑得通，GitHub 美国 runner 被墙）：
 *       - 纳斯达克100 / 恒生科技 日线
 *       - 股吧人气榜 → 增强「讨论度」
 *   任何一部分失败都保留上一次真实值，绝不用静态基线覆盖。
 *
 * 宝妈指数 = 板块级「情绪化散户活跃度」代理：
 *   拥挤度(成交额异动) / 扩散力(上涨家数占比) / 动摇度(年化波动) /
 *   D回补(从低点回补) / 换手度 / 涨停密度 → 跨板块分位(0-100) → 加权总分
 *   讨论度 = 行为代理(换手+涨停密度) + 可选股吧人气榜增强
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TUSHARE_TOKEN || '0cdd5c099fd79ce5b598c77d97dd1ad1ec86aedeb22c77756222c4d2';
const TUSHARE_API = 'https://api.tushare.pro';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const EM_HEADERS = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 可调参数 ──
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS) || 45; // 波动/回补回看窗口
const MIN_STOCKS = 8; // 板块最少成分股，过滤噪音行业
const CALL_GAP = Number(process.env.CALL_GAP) || 1200; // Tushare 调用间隔(ms)，礼貌限速

// 东财备份标的
const EM_INDEX = {
  ndx:    { secid: '100.NDX',    name: '纳斯达克100', code: 'NDX' },
  hstech: { secid: '124.HSTECH', name: '恒生科技',   code: 'HSTECH' },
};
// 宝妈指数权重（6 个交易行为维度合成总分；讨论度单列）
const W = { crowding: 0.25, diffusion: 0.15, volatility: 0.15, dreb: 0.10, turnover: 0.15, zt: 0.10 };
const WSUM = Object.values(W).reduce((a, b) => a + b, 0);

// 估值/持仓基线（custom-data.json 缺省时兜底；这两块免费源算不了）
const BASELINE_CUSTOM = {
  valuationData: [
    { name: '半导体设备', pe: 166.96, pePct: 96.36, pbPct: 99.36, peChg: -7.5 },
    { name: '存储器/芯片', pe: 141.01, pePct: 95.48, pbPct: 99.48, peChg: -6.8 },
    { name: '半导体产业', pe: 124.23, pePct: 94.56, pbPct: 97.54, peChg: -7.2 },
    { name: '光模块CPO', pe: 71.92, pePct: 86.58, pbPct: 99.32, peChg: -9.6 },
    { name: '机器人概念', pe: 58.40, pePct: 72.30, pbPct: 78.50, peChg: 2.1 },
    { name: '恒生科技', pe: 32.50, pePct: 45.20, pbPct: 55.80, peChg: -3.4 },
    { name: '创新药', pe: 38.70, pePct: 38.50, pbPct: 42.10, peChg: 1.2 },
    { name: '新能源电池', pe: 28.90, pePct: 35.60, pbPct: 48.20, peChg: -1.8 },
  ],
};

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'cache');
const STOCK_BASIC_CACHE = path.join(CACHE_DIR, 'stock_basic.json');
const HISTORY_CACHE = path.join(CACHE_DIR, 'sector_history.json');
const ARCHIVE_DIR = path.join(ROOT, 'archive');
const MANIFEST_PATH = path.join(ARCHIVE_DIR, 'manifest.json');
const RETAIN_FILES = Number(process.env.RETAIN_FILES) || 800; // 归档保留上限，超出删最旧（≈3年双频次）

// ── 新浪财经（实时行情，GitHub 可直连；需请求头伪装 + 严格限速防封）──
// 参考：单 IP ≈30~60 次/分，突发易 403/封 IP；必须带 UA + Referer(finance.sina.com.cn)；返回 GBK。
const SINA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://finance.sina.com.cn/',
};
const SINA_MIN_GAP = 1500;            // 两次请求最小间隔(ms)，留余量（红线 30~60次/分）
const SINA_JITTER = 500;              // 随机抖动上限(ms)，打散节奏
const SINA_CHUNK = 80;                // 单次批量代码数（list= 多代码上限）
const SINA_RT_TTL = 20 * 60 * 1000;   // 实时快照本地缓存 20 分钟（同类数据不重复拉）
const SINA_BAN_COOLDOWN = 10 * 60 * 1000; // 触发限流后暂停 10 分钟
const SINA_RT_CACHE = path.join(CACHE_DIR, 'sina_realtime.json');
const SINA_IDX = { sse: 'sh000001' }; // 上证指数（其他指数沿用东财/Tushare 兜底）
let _sinaLastCall = 0;
let _sinaBannedUntil = 0;

// ── 工具 ──
function ymd(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; }
function fmt2(n) { return Math.round(n * 100) / 100; }
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a) { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(avg(a.map((x) => (x - m) ** 2))); }
function pctRank(value, arr) {
  const uniq = arr.filter((x) => x != null && !isNaN(x));
  if (uniq.length === 0) return 50;
  const less = uniq.filter((x) => x < value).length;
  return Math.round((less / (uniq.length - 1 || 1)) * 100);
}
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function writeJsonSafe(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o), 'utf8'); }

// ── 归档：每次运行留存一份快照，供前端回溯 ──
function writeArchive(out, session, sessionLabel, updatedAt, incomplete) {
  const bj = new Date(Date.now() + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  const datePart = `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}`;
  const fileBase = `${datePart}-${p(bj.getUTCHours())}${p(bj.getUTCMinutes())}`;
  const relFile = `archive/${fileBase}.json`;
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archObj = { ...out, meta: { session, sessionLabel, date: datePart, file: relFile, updatedAt, incomplete } };
  fs.writeFileSync(path.join(ARCHIVE_DIR, fileBase + '.json'), JSON.stringify(archObj, null, 2), 'utf8');

  let manifest = readJsonSafe(MANIFEST_PATH) || [];
  if (!Array.isArray(manifest)) manifest = [];
  manifest.push({ file: relFile, date: datePart, session, sessionLabel, updatedAt, source: out.source, sectors: (out.heatmapData || []).length, incomplete });
  manifest.sort((a, b) => b.file.localeCompare(a.file)); // 新 → 旧
  if (manifest.length > RETAIN_FILES) {
    const remove = manifest.splice(RETAIN_FILES);
    remove.forEach((m) => { try { fs.unlinkSync(path.join(ROOT, m.file)); } catch (e) {} });
    console.log(`[archive] 超出保留上限 ${RETAIN_FILES}，清理 ${remove.length} 个最旧快照`);
  }
  writeJsonSafe(MANIFEST_PATH, manifest);
  console.log(`[archive] 已留存快照 ${relFile}（session=${session}, incomplete=${incomplete}）`);
  return path.join(ARCHIVE_DIR, fileBase + '.json');
}

// ── Tushare 调用（带重试/限流退避）──
async function tushare(api_name, params, fields, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(TUSHARE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_name, token: TOKEN, params, fields }),
      });
      const j = await res.json();
      if (j && j.code === 0 && j.data) { await sleep(CALL_GAP); return j.data; }
      if (j && j.code === 40101) throw new Error('Tushare token 无效');
      lastErr = new Error('Tushare code ' + (j && j.code) + ' ' + (j && j.msg));
      await sleep(j && j.code === 40203 ? 60000 : 5000 * (i + 1)); // 限流退避满1分钟；无权限较短
    } catch (e) {
      lastErr = e;
      await sleep(5000 * (i + 1));
    }
  }
  throw lastErr;
}

// ── 涨跌停阈值（按代码/ST 判定）──
function limitPct(code, name) {
  if (name && /ST/i.test(name)) return 5;
  if (/\.BJ$/.test(code)) return 30;
  if (/^(688|689)/.test(code)) return 20; // 科创板
  if (/^(300|301)/.test(code)) return 20; // 创业板
  return 10; // 主板
}
function isLimitUp(pct, code, name) { return pct >= limitPct(code, name) - 0.3; }

// ── 个股日线聚合为板块 ──
function aggregate(rows, sbMap) {
  const sec = {};
  for (const r of rows) {
    const sb = sbMap[r.ts_code];
    if (!sb || !sb.industry) continue;
    const ind = sb.industry;
    if (!sec[ind]) sec[ind] = { ret: 0, amt: 0, up: 0, down: 0, total: 0, zt: 0, tNum: 0, tDen: 0, codes: [] };
    const s = sec[ind];
    const pct = Number(r.pct_chg) || 0;
    s.ret += pct;                 // 累加涨跌幅（%，最后转小数取均值）
    s.amt += Number(r.amount) || 0;
    s.total += 1;
    if (pct > 0) s.up += 1; else if (pct < 0) s.down += 1;
    if (isLimitUp(pct, r.ts_code, sb.name)) s.zt += 1;
    const fl = Number(sb.float_share) || 0;
    if (fl > 0) { s.tNum += (Number(r.vol) || 0) * 100; s.tDen += fl; } // Tushare vol=手→×100=股；float_share=股（勿×10000）
    s.codes.push(r.ts_code);
  }
  for (const k in sec) sec[k].ret = (sec[k].total ? sec[k].ret / sec[k].total : 0) / 100; // 板块等权日收益(小数)
  return sec;
}

// ── 1. 个股列表（缓存 7 天）──
async function getStockBasic() {
  const cache = readJsonSafe(STOCK_BASIC_CACHE);
  if (cache && cache.fetchedAt && (Date.now() - new Date(cache.fetchedAt).getTime()) < 7 * 86400000 && cache.map) {
    console.log(`[sb] 使用缓存（${Object.keys(cache.map).length} 只）`);
    return cache.map;
  }
  console.log('[sb] 拉取 stock_basic …');
  try {
    const data = await tushare('stock_basic',
      { exchange: '', list_status: 'L' },
      'ts_code,symbol,name,industry,market,exchange,list_status,float_share,total_share');
    const fi = {}; data.fields.forEach((f, i) => (fi[f] = i));
    const map = {};
    data.items.forEach((it) => {
      map[it[fi.ts_code]] = {
        name: it[fi.name],
        industry: it[fi.industry] || '',
        float_share: it[fi.float_share] || 0,
        exchange: it[fi.exchange] || '',
        list_status: it[fi.list_status] || '',
      };
    });
    writeJsonSafe(STOCK_BASIC_CACHE, { fetchedAt: new Date().toISOString(), map });
    console.log(`[sb] ${Object.keys(map).length} 只`);
    return map;
  } catch (e) {
    if (cache && cache.map && Object.keys(cache.map).length) {
      console.log(`[sb] Tushare 拉取失败(${e.message})，回退到已缓存的 ${Object.keys(cache.map).length} 只`);
      return cache.map;
    }
    throw e;
  }
}

// ── 2. 当日全市场日线（批量，1 次调用）──
async function fetchDaily(tradeDate) {
  const data = await tushare('daily', { trade_date: tradeDate },
    'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount');
  const fi = {}; data.fields.forEach((f, i) => (fi[f] = i));
  return data.items.map((it) => ({
    ts_code: it[fi.ts_code], pct_chg: it[fi.pct_chg], vol: it[fi.vol], amount: it[fi.amount],
  }));
}

// ── 3. 上证指数（Tushare，1 次调用拿区间）──
async function fetchIndexSSE(beg, end) {
  const data = await tushare('index_daily', { ts_code: '000001.SH', start_date: beg, end_date: end }, 'trade_date,close');
  const fi = {}; data.fields.forEach((f, i) => (fi[f] = i));
  return data.items
    .map((it) => ({ date: String(it[fi.trade_date]), close: +it[fi.close] }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── 4. 历史回看（bootstrap + 增量）──
async function ensureHistory(sbMap) {
  let hist = readJsonSafe(HISTORY_CACHE) || { days: [] };
  if (!Array.isArray(hist.days)) hist.days = [];
  const need = HISTORY_DAYS - hist.days.length;
  if (need > 0) {
    console.log(`[hist] 需补 ${need} 个交易日历史`);
    let cursor = hist.days.length
      ? new Date(hist.days[hist.days.length - 1].date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'))
      : new Date();
    cursor.setDate(cursor.getDate() - 1);
    let added = 0, attempts = 0; const maxAttempts = need + 40;
    while (added < need && attempts < maxAttempts) {
      attempts++;
      const d = ymd(cursor);
      cursor.setDate(cursor.getDate() - 1);
      const dow = cursor.getDay();
      if (dow === 0 || dow === 6) continue;
      try {
        const rows = await fetchDaily(d);
        if (rows && rows.length) {
          const agg = aggregate(rows, sbMap);
          const entry = { date: d, ret: {}, amt: {} };
          for (const k in agg) { entry.ret[k] = agg[k].ret; entry.amt[k] = agg[k].amt; }
          hist.days.push(entry);
          added++;
          if (added % 10 === 0) console.log(`[hist] 已补 ${added} 天（最新 ${d}）`);
        }
      } catch (e) {
        console.log(`[hist] ${d} 拉取失败(${e.message})，限流中停止本次回看，已取历史将保留（后续运行继续累积）`);
        break; // 遇限流/错误即停止本轮 bootstrap，避免耗尽超时；历史已落盘，下次运行继续补
      }
      await sleep(250);
    }
    if (hist.days.length > HISTORY_DAYS * 2) hist.days = hist.days.slice(-HISTORY_DAYS * 2);
    writeJsonSafe(HISTORY_CACHE, hist);
  }
  console.log(`[hist] 现有 ${hist.days.length} 天`);
  return hist;
}

// ── 5. 宝妈指数计算 ──
function computeMama(todaySec, histDays, guba, todayYmd) {
  const allDays = histDays.slice().sort((a, b) => a.date.localeCompare(b.date));
  const todayEntry = { date: todayYmd, ret: {}, amt: {} };
  for (const k in todaySec) { todayEntry.ret[k] = todaySec[k].ret; todayEntry.amt[k] = todaySec[k].amt; }
  allDays.push(todayEntry);

  const sectors = Object.keys(todaySec).filter((k) => todaySec[k].total >= MIN_STOCKS);
  const raw = {};
  for (const s of sectors) {
    const window = allDays.slice(-(HISTORY_DAYS + 1));
    const amtsAll = window.map((d) => d.amt[s]).filter((x) => x != null);
    const prevAmts = amtsAll.slice(0, -1);
    const avgPrev = avg(prevAmts);
    const crowdingRaw = avgPrev > 0 ? todaySec[s].amt / avgPrev : 1; // 成交额异动比
    const rets = window.map((d) => d.ret[s]).filter((x) => x != null);
    const volatilityRaw = std(rets) * Math.sqrt(252); // 年化波动
    let idx = 100, minIdx = 100;
    for (let i = 1; i < rets.length; i++) { idx *= 1 + rets[i]; if (idx < minIdx) minIdx = idx; }
    const drebRaw = minIdx > 0 ? idx / minIdx - 1 : 0; // 从区间低点的回补强度
    const diffusionRaw = todaySec[s].total ? todaySec[s].up / todaySec[s].total : 0;
    const turnoverRaw = todaySec[s].tDen > 0 ? (todaySec[s].tNum / todaySec[s].tDen) * 100 : 0;
    const ztRaw = todaySec[s].total ? (todaySec[s].zt / todaySec[s].total) * 100 : 0;
    raw[s] = { crowdingRaw, volatilityRaw, drebRaw, diffusionRaw, turnoverRaw, ztRaw };
  }

  const arr = (key) => sectors.map((s) => raw[s][key]);
  const cCrowd = arr('crowdingRaw'), cVol = arr('volatilityRaw'), cDreb = arr('drebRaw');
  const cDiff = arr('diffusionRaw'), cTurn = arr('turnoverRaw'), cZt = arr('ztRaw');
  sectors.forEach((s) => (raw[s].discBraw = 0.5 * raw[s].turnoverRaw + 0.5 * raw[s].ztRaw)); // 行为代理
  const cDiscB = sectors.map((s) => raw[s].discBraw);

  let cDiscG = null;
  if (guba && guba.size) {
    sectors.forEach((s) => {
      const ranks = todaySec[s].codes.map((c) => guba.get(c.replace(/\.\w+$/, ''))).filter((x) => x != null);
      raw[s].discGraw = ranks.length ? Math.max(0, 100 - (avg(ranks) / 1000) * 100) : null;
    });
    cDiscG = sectors.map((s) => raw[s].discGraw).filter((x) => x != null);
  }

  return sectors.map((s) => {
    const crowding = pctRank(raw[s].crowdingRaw, cCrowd);
    const volatility = pctRank(raw[s].volatilityRaw, cVol);
    const dreb = pctRank(raw[s].drebRaw, cDreb);
    const diffusion = pctRank(raw[s].diffusionRaw, cDiff);
    const turnover = pctRank(raw[s].turnoverRaw, cTurn);
    const zt = pctRank(raw[s].ztRaw, cZt);
    const discB = pctRank(raw[s].discBraw, cDiscB);
    let dis = discB;
    if (cDiscG && raw[s].discGraw != null) dis = Math.round(0.6 * discB + 0.4 * pctRank(raw[s].discGraw, cDiscG));
    const total = Math.round(
      (W.crowding * crowding + W.diffusion * diffusion + W.volatility * volatility +
        W.dreb * dreb + W.turnover * turnover + W.zt * zt) / WSUM
    );
    return { name: s, board: s, ore: crowding, dif: diffusion, wov: volatility, dbu: dreb, zt, hs: turnover, dis, total };
  });
}

// ── 东财备份：指数/ETF 日线 + 股吧人气榜 ──
async function fetchKlinesEM(secid, beg, end) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&beg=${beg}&end=${end}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57`;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: EM_HEADERS });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const kls = (j && j.data && j.data.klines) || [];
      return kls.map((s) => { const a = s.split(','); return { date: a[0], close: +a[2] }; });
    } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}
async function fetchGubaRank() {
  try {
    const url = 'https://emappdata.eastmoney.com/stockrank/getAllCurrentList?app=pc&fields1=f1,f2,f3&fields2=f12,f14,f62,f184,f3,f10';
    const res = await fetch(url, { headers: EM_HEADERS });
    const j = await res.json();
    const list = (j && j.data && j.data.diff) || (j && j.data) || [];
    const map = new Map();
    (Array.isArray(list) ? list : []).forEach((x, i) => { if (x.f12) map.set(String(x.f12), i + 1); });
    console.log(`[guba] 人气榜 ${map.size} 条`);
    return map;
  } catch (e) {
    console.log(`[guba] 失败(${e.message})，讨论度回退行为代理`);
    return null;
  }
}
function buildIndexItem(meta, bars) {
  if (!bars.length) return null;
  const last = bars[bars.length - 1];
  const price = last.close;
  let change = 0, pct = 0;
  if (bars.length >= 2) { const prev = bars[bars.length - 2].close; change = fmt2(price - prev); pct = fmt2(((price - prev) / prev) * 100); }
  return { name: meta.name, code: meta.code, price: fmt2(price), change, pct, date: last.date };
}

// ── 新浪财经客户端（防封：全局限速 + 请求头伪装 + GBK + 指数退避 + 封禁冷却）──
function sinaThrottle() {
  const now = Date.now();
  const wait = Math.max(0, _sinaLastCall + SINA_MIN_GAP + Math.random() * SINA_JITTER - now);
  return sleep(wait);
}
async function sinaFetchText(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (Date.now() < _sinaBannedUntil) throw new Error('新浪处于封禁冷却期');
    await sinaThrottle();
    _sinaLastCall = Date.now();
    try {
      const res = await fetch(url, { headers: SINA_HEADERS });
      if (res.status === 403 || res.status === 429) {
        _sinaBannedUntil = Date.now() + SINA_BAN_COOLDOWN;
        lastErr = new Error('新浪限流 HTTP ' + res.status);
        await sleep(2000 * (i + 1));
        continue;
      }
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); await sleep(1500 * (i + 1)); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const txt = new TextDecoder('gbk').decode(buf); // 新浪返回 GBK
      if (!txt.includes('hq_str')) { lastErr = new Error('返回空/无数据'); await sleep(1500 * (i + 1)); continue; }
      return txt;
    } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}
function parseSinaRealtime(txt) {
  const map = {};
  txt.split(';\n').forEach((line) => {
    const m = line.match(/var hq_str_(\w+)="(.*)"/);
    if (!m) return;
    const f = m[2].split(',');
    if (f.length < 10) return;
    const cur = Number(f[3]), pre = Number(f[2]);
    if (!isFinite(cur) || !isFinite(pre) || pre <= 0) return;
    map[m[1]] = { name: f[0], open: Number(f[1]), preClose: pre, current: cur, high: Number(f[4]), low: Number(f[5]), volume: Number(f[8]) || 0, amount: Number(f[9]) || 0 };
  });
  return map;
}
async function fetchSinaRealtime(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += SINA_CHUNK) {
    const batch = codes.slice(i, i + SINA_CHUNK);
    try {
      const txt = await sinaFetchText('https://hq.sinajs.cn/list=' + batch.join(','));
      Object.assign(out, parseSinaRealtime(txt));
    } catch (e) {
      console.log(`[sina] 批量失败(${e.message})，该批 ${batch.length} 只跳过`);
    }
  }
  return out;
}
// 新浪实时 → 与 aggregate() 同构的板块聚合
// 注意单位对齐（否则 宝妈指数 维度会失真）：
//   ret   = 当日收益率(%)（与 Tushare pct_chg 同义）
//   amt   = 成交额，新浪单位为「元」→ ÷1000 转「千元」，对齐 Tushare daily.amount
//   volume= 成交量，新浪单位为「股」（已验证 price×vol≈amount），无需像 Tushare(手) 那样 ×100
function buildRealtimeSec(map, sbMap) {
  const sec = {};
  for (const code in map) {
    const rt = map[code];
    const sb = sbMap[code];
    if (!sb || !sb.industry) continue;
    const ind = sb.industry;
    if (!sec[ind]) sec[ind] = { ret: 0, amt: 0, up: 0, down: 0, total: 0, zt: 0, tNum: 0, tDen: 0, codes: [] };
    const s = sec[ind];
    const pct = (rt.current - rt.preClose) / rt.preClose * 100;
    s.ret += pct;
    s.amt += rt.amount / 1000; // 元 → 千元
    s.total += 1;
    if (pct > 0) s.up += 1; else if (pct < 0) s.down += 1;
    if (isLimitUp(pct, code, rt.name)) s.zt += 1;
    const fl = Number(sb.float_share) || 0;
    if (fl > 0) { s.tNum += rt.volume; s.tDen += fl; } // 新浪 volume 已是股；float_share=股（勿×10000）
    s.codes.push(sb.ts_code || code);
  }
  for (const k in sec) sec[k].ret = (sec[k].total ? sec[k].ret / sec[k].total : 0) / 100;
  return sec;
}
async function fetchSinaIndices() {
  const syms = Object.values(SINA_IDX);
  try {
    const txt = await sinaFetchText('https://hq.sinajs.cn/list=' + syms.join(','));
    const map = parseSinaRealtime(txt);
    const out = {};
    for (const [key, sym] of Object.entries(SINA_IDX)) {
      const r = map[sym];
      if (!r) continue;
      const change = fmt2(r.current - r.preClose);
      out[key] = { name: r.name, code: sym, price: fmt2(r.current), change, pct: fmt2((r.current - r.preClose) / r.preClose * 100), date: '' };
    }
    return out;
  } catch (e) { console.log('[sina idx] 失败', e.message); return {}; }
}
function loadSinaRtCache() {
  const c = readJsonSafe(SINA_RT_CACHE);
  if (c && c.savedAt && (Date.now() - new Date(c.savedAt).getTime()) < SINA_RT_TTL && c.map) return c.map;
  return null;
}
function saveSinaRtCache(map) { writeJsonSafe(SINA_RT_CACHE, { savedAt: new Date().toISOString(), map }); }

// ts_code(如 600000.SH) → 新浪符号(如 sh600000)
function tsCodeToSina(ts) {
  const [sym, ex] = ts.split('.');
  const pfx = { SH: 'sh', SZ: 'sz', BJ: 'bj' }[ex] || (ex || '').toLowerCase();
  return pfx + sym;
}

// 新浪实时 → 板块聚合（带 20 分钟本地缓存，命中则不重复拉取，避免触发限流）
async function getSinaTodaySec(sbMap) {
  const sinaSbMap = {};
  const symbols = [];
  for (const ts in sbMap) {
    const sb = sbMap[ts];
    if (!sb.industry) continue;
    const sym = tsCodeToSina(ts);
    sinaSbMap[sym] = { ...sb, ts_code: ts };
    symbols.push(sym);
  }
  const cached = loadSinaRtCache();
  if (cached && Object.keys(cached).length) {
    const sec = buildRealtimeSec(cached, sinaSbMap);
    console.log(`[sina] 命中 ${(SINA_RT_TTL / 60000)} 分钟缓存，${Object.keys(sec).length} 个行业`);
    return sec;
  }
  try {
    const map = await fetchSinaRealtime(symbols);
    if (map && Object.keys(map).length) {
      saveSinaRtCache(map);
      const sec = buildRealtimeSec(map, sinaSbMap);
      console.log(`[sina] 实时拉取 ${Object.keys(map).length} 只，${Object.keys(sec).length} 个行业`);
      return sec;
    }
    console.log('[sina] 实时返回为空（可能盘中未开或限流）');
  } catch (e) { console.log(`[sina] 实时拉取失败(${e.message})`); }
  return null;
}

async function main() {
  const dataPath = path.join(ROOT, 'data.json');
  const customPath = path.join(ROOT, 'custom-data.json');
  const prev = readJsonSafe(dataPath) || {};
  const customFile = readJsonSafe(customPath) || {};
  const today = new Date();
  const bj = new Date(today.getTime() + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  const TODAY_YMD = ymd(today);
  const begDate = new Date(today.getTime() - 200 * 86400000);
  const beg = ymd(begDate);

  // 会话判定：午盘收盘(<12点北京时间) / 全日收盘(>=12点)；env SESSION 可强制覆盖
  const SESSION = process.env.SESSION || (bj.getUTCHours() < 12 ? 'midday' : 'close');
  const SESSION_LABEL = SESSION === 'midday' ? '午盘收盘' : '全日收盘';

  // 主力：Tushare 列表/历史（缓存 7 天 + 限流退避保护）
  const sbMap = await getStockBasic();
  const hist = await ensureHistory(sbMap);

  // ── 今日板块聚合 ──
  //   午盘：Tushare daily 尚未发布 → 优先新浪实时（盘中快照）
  //   收盘：优先 Tushare daily（收盘权威值）；若未发布/限流 → 新浪实时回补（=当日收盘真实价）
  let todaySec = null;
  let realtimeSrc = false;
  if (SESSION === 'midday') {
    const sinaSec = await getSinaTodaySec(sbMap);
    if (sinaSec && Object.keys(sinaSec).length) { todaySec = sinaSec; realtimeSrc = true; console.log('[today] 午盘数据源=新浪实时（盘中）'); }
    else console.log('[today] 午盘新浪实时无数据，保留旧值');
  } else {
    try {
      const rows = await fetchDaily(TODAY_YMD);
      if (rows && rows.length) { todaySec = aggregate(rows, sbMap); console.log(`[today] ${TODAY_YMD} ${rows.length} 行, ${Object.keys(todaySec).length} 个行业`); }
      else console.log(`[today] ${TODAY_YMD} Tushare 无数据（未发布/非交易日？尝试新浪回补）`);
    } catch (e) { console.log(`[today] Tushare daily 失败(${e.message})，尝试新浪回补`); }
    if (!todaySec) {
      const sinaSec = await getSinaTodaySec(sbMap);
      if (sinaSec && Object.keys(sinaSec).length) { todaySec = sinaSec; realtimeSrc = true; console.log('[today] 收盘回补数据源=新浪实时'); }
    }
  }

  let heatmapData = prev.heatmapData || [];
  if (todaySec && Object.keys(todaySec).length) {
    let guba = null;
    try { guba = await fetchGubaRank(); } catch (e) { /* 跳过 */ }
    const computed = computeMama(todaySec, hist.days, guba, TODAY_YMD);
    if (computed.length) {
      const prevMap = new Map((prev.heatmapData || []).map((r) => [r.name, r]));
      heatmapData = computed
        .map((r) => {
          const old = (prevMap.get(r.name) || {}).total;
          const chg = old != null ? Math.round(r.total - old) : 0;
          return { ...r, chg };
        })
        .sort((a, b) => b.total - a.total);
      console.log(`[mama] 计算完成，板块数=${heatmapData.length}`);
    } else console.log('[mama] 空结果，保留旧值');
  } else console.log('[mama] 今日无数据，保留旧 heatmapData');

  // 上证：优先新浪实时（GitHub 可直连、盘中可得），Tushare 兜底
  const indexData = prev.indexData || {};
  try {
    const sinaIdx = await fetchSinaIndices();
    if (sinaIdx.sse) { indexData.sse = sinaIdx.sse; console.log(`[sse] 新浪实时 ${indexData.sse.price} (${indexData.sse.pct}%)`); }
    else throw new Error('新浪未返回上证');
  } catch (e) {
    console.log(`[sse] 新浪失败(${e.message})，回退 Tushare`);
    try {
      const bars = await fetchIndexSSE(beg, TODAY_YMD);
      const it = buildIndexItem({ name: '上证指数', code: '000001' }, bars);
      if (it) { indexData.sse = it; console.log(`[sse] Tushare ${it.price} (${it.pct}%)`); }
    } catch (e2) { console.log(`[sse] Tushare 也失败(${e2.message})，保留旧值`); }
  }

  // 东财备份：纳指100 / 恒生科技（大陆 IP 才成功，GitHub 自动保留旧值）
  let emUsed = false;
  for (const [key, meta] of Object.entries(EM_INDEX)) {
    try {
      const bars = await fetchKlinesEM(meta.secid, beg, TODAY_YMD);
      const it = buildIndexItem(meta, bars);
      if (it) { indexData[key] = it; emUsed = true; console.log(`[em ${key}] ${it.price} (${it.pct}%)`); }
    } catch (e) { console.log(`[em ${key}] 失败(${e.message})，保留旧值`); }
    await sleep(500);
  }
  const valuationData = customFile.valuationData || prev.valuationData || BASELINE_CUSTOM.valuationData;

  const updatedAt = `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;

  // 数据源标记（非大陆 IP 时东财/股吧多为旧值，仅标注实际生效来源）
  const srcParts = ['tushare-free'];
  if (realtimeSrc) srcParts.push('sina-realtime');
  if (emUsed) srcParts.push('eastmoney-backup');
  const source = srcParts.join(' + ');

  const out = { updatedAt, session: SESSION, sessionLabel: SESSION_LABEL, realtime: realtimeSrc, source, indexData, heatmapData, valuationData };

  const incomplete = !(todaySec && Object.keys(todaySec).length);
  const dow = today.getDay();
  const isWeekend = dow === 0 || dow === 6;

  fs.writeFileSync(dataPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n[done] data.json 已生成，updatedAt=${updatedAt}`);
  // 归档：周末且无数据则跳过（避免空快照刷屏），其余每次都留存
  if (incomplete && isWeekend) {
    console.log('[archive] 非交易日且无数据，跳过归档');
  } else {
    writeArchive(out, SESSION, SESSION_LABEL, updatedAt, incomplete);
  }
}

module.exports = { aggregate, computeMama, isLimitUp, limitPct, pctRank, std, avg, W, WSUM, writeArchive, getSinaTodaySec, tsCodeToSina, buildRealtimeSec, parseSinaRealtime };

if (require.main === module) main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
