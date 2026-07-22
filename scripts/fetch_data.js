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
    if (fl > 0) { s.tNum += (Number(r.vol) || 0) * 100; s.tDen += fl * 10000; } // 股
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

async function main() {
  const dataPath = path.join(ROOT, 'data.json');
  const customPath = path.join(ROOT, 'custom-data.json');
  const prev = readJsonSafe(dataPath) || {};
  const customFile = readJsonSafe(customPath) || {};
  const today = new Date();
  const TODAY_YMD = ymd(today);
  const begDate = new Date(today.getTime() - 200 * 86400000);
  const beg = ymd(begDate);

  // 主力：Tushare
  const sbMap = await getStockBasic();
  const hist = await ensureHistory(sbMap);

  let todaySec = null;
  try {
    const rows = await fetchDaily(TODAY_YMD);
    if (rows && rows.length) {
      todaySec = aggregate(rows, sbMap);
      console.log(`[today] ${TODAY_YMD} ${rows.length} 行, ${Object.keys(todaySec).length} 个行业`);
    } else console.log(`[today] ${TODAY_YMD} 无交易数据（非交易日？保留旧值）`);
  } catch (e) { console.log(`[today] 拉取失败(${e.message})，保留旧值`); }

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

  // 上证（Tushare）
  const indexData = prev.indexData || {};
  try {
    const bars = await fetchIndexSSE(beg, TODAY_YMD);
    const it = buildIndexItem({ name: '上证指数', code: '000001' }, bars);
    if (it) { indexData.sse = it; console.log(`[sse] ${it.price} (${it.pct}%)`); }
  } catch (e) { console.log(`[sse] 失败(${e.message})，保留旧值`); }

  // 东财备份：纳指100 / 恒生科技（大陆 IP 才成功，GitHub 自动保留旧值）
  for (const [key, meta] of Object.entries(EM_INDEX)) {
    try {
      const bars = await fetchKlinesEM(meta.secid, beg, TODAY_YMD);
      const it = buildIndexItem(meta, bars);
      if (it) { indexData[key] = it; console.log(`[em ${key}] ${it.price} (${it.pct}%)`); }
    } catch (e) { console.log(`[em ${key}] 失败(${e.message})，保留旧值`); }
    await sleep(500);
  }
  const valuationData = customFile.valuationData || prev.valuationData || BASELINE_CUSTOM.valuationData;

  const bj = new Date(today.getTime() + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  const updatedAt = `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;

  const out = { updatedAt, source: 'tushare-free + eastmoney-backup', indexData, heatmapData, valuationData };
  fs.writeFileSync(dataPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n[done] data.json 已生成，updatedAt=${updatedAt}`);
}

module.exports = { aggregate, computeMama, isLimitUp, limitPct, pctRank, std, avg, W, WSUM };

if (require.main === module) main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
