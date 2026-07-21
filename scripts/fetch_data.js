/* ============================================================
 * fetch_data.js — GitHub Action 取数脚本
 * ------------------------------------------------------------
 * 每日收盘后由 GitHub Action 调用，产出 data.json：
 *   1. 三大指数 + 芯片ETF 日线（东方财富 K线）
 *   2. ★ 宝妈指数（情绪化散户活跃度）计算引擎
 *      - 对每个板块算 6 个原始维度 + 讨论度，交叉分位合成 0-100 总分
 *   3. 合并 custom-data.json（估值/持仓 等自定义数据）
 *   4. 写入 data.json 提交 → 静态页读取
 *
 * 容错：单标的失败保留上一次值；讨论度的人气榜取不到自动回退行为代理。
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INDEX_SECIDS = {
  sse:    { secid: '1.000001',   name: '上证指数',   code: '000001' },
  ndx:    { secid: '100.NDX',    name: '纳斯达克100', code: 'NDX' },
  hstech: { secid: '124.HSTECH', name: '恒生科技',   code: 'HSTECH' },
};
const ETF_SECID = '0.159995'; // 芯片ETF华夏

// ── 板块 → 东财板块匹配规则（从概念/行业板块排行里按名匹配）──
// kw: 候选关键词（按优先级）；excl: 命中后若含这些词则跳过（消歧）
const SECTOR_DEFS = [
  { name: '芯片',       kw: ['国产芯片', '芯片概念', '芯片'],        excl: ['存储', 'AI', '汽车', '第三代'] },
  { name: '半导体',     kw: ['半导体概念', '半导体'],               excl: ['第三代', '汽车'] },
  { name: '细分化工',   kw: ['化肥行业', '化工行业', '化工'],         excl: [] },
  { name: '科创创业AI', kw: ['人工智能', 'AI概念', 'AI'],            excl: ['手机', '眼镜', 'PC', 'AIPC'] },
  { name: '机器人',     kw: ['机器人概念', '机器人'],               excl: ['执行器'] },
  { name: '新能源电池', kw: ['固态电池', '锂电池', '动力电池', '电池'], excl: [] },
  { name: '恒生科技',   kw: [], excl: [], hk: true }, // 港股，无 A 股板块，回退基线
  { name: '创新药',     kw: ['创新药', '生物医药'],                 excl: [] },
  { name: '锂矿',       kw: ['锂矿', '盐湖提锂', '锂'],              excl: [] },
  { name: 'CPO',        kw: ['CPO概念', 'CPO'],                     excl: [] },
  { name: 'PCB',        kw: ['PCB概念', 'PCB'],                     excl: [] },
];

// 宝妈指数权重（6 个交易行为维度合成总分；讨论度单列）
const W = { crowding: 0.25, diffusion: 0.15, volatility: 0.15, dreb: 0.10, turnover: 0.15, zt: 0.10 };
const WSUM = Object.values(W).reduce((a, b) => a + b, 0);

// ── 内置估值/持仓基线（custom-data.json 缺省时兜底；这两块免费源算不了）──
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
  sectorBreakdown: [
    { label: 'AI芯片', value: 17.43, color: '#f85149' },
    { label: '半导体设备', value: 19.90, color: '#d29922' },
    { label: '晶圆制造', value: 8.50, color: '#a371f7' },
    { label: '存储芯片', value: 15.29, color: '#3fb950' },
    { label: '图像传感器', value: 4.20, color: '#58a6ff' },
    { label: '芯片IP/Chiplet', value: 3.55, color: '#79c0ff' },
    { label: '其他', value: 31.13, color: '#484f58' },
  ],
};

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function fmt2(n) { return Math.round(n * 100) / 100; }
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a) {
  if (a.length < 2) return 0;
  const m = avg(a);
  return Math.sqrt(avg(a.map((x) => (x - m) ** 2)));
}
// 交叉分位：value 在 arr 中的百分位 (0-100)。arr 至少含 value 自身。
function pctRank(value, arr) {
  const uniq = arr.filter((x) => x != null && !isNaN(x));
  if (uniq.length === 0) return 50;
  const less = uniq.filter((x) => x < value).length;
  return Math.round((less / (uniq.length - 1 || 1)) * 100);
}

async function fetchJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

// ── 1. 板块排行（概念 + 行业），返回 code→{name,chg,up,down,turnover} ──
async function fetchBoardPool() {
  const pool = {};
  for (const [market, type] of [['90', '3'], ['90', '2']]) { // 3=概念 2=行业
    const fs = `m:${market}+t:${type}`;
    const fields = 'f12,f14,f3,f104,f105,f184';
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=600&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${fs}&fields=${fields}`;
    try {
      const j = await fetchJson(url);
      const list = (j && j.data && j.data.diff) || [];
      list.forEach((b) => {
        if (b.f12 && !pool[b.f12]) {
          pool[b.f12] = {
            code: b.f12, name: b.f14,
            chg: +b.f3 || 0, up: +b.f104 || 0, down: +b.f105 || 0, turnover: +b.f184 || 0,
          };
        }
      });
      console.log(`[board] ${market}+${type} 拉取 ${list.length} 个板块`);
    } catch (e) {
      console.log(`[board] ${market}+${type} 失败(${e.message})`);
    }
    await sleep(600);
  }
  return pool;
}

function matchBoard(def, pool) {
  if (def.hk) return null; // 港股无 A 股板块
  const boards = Object.values(pool);
  for (const kw of def.kw) {
    const hit = boards.find((b) => String(b.name).includes(kw) && !def.excl.some((x) => String(b.name).includes(x)));
    if (hit) return hit;
  }
  return null;
}

// ── 2. 板块成分（涨停密度）──
async function fetchBoardMembers(code) {
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=600&fid=f3&fs=b:${code}&fields=f12,f14,f3`;
  try {
    const j = await fetchJson(url);
    const list = (j && j.data && j.data.diff) || [];
    const zt = list.filter((x) => +x.f3 >= 9.5).length;
    return { total: list.length, zt, codes: list.map((x) => x.f12) };
  } catch (e) {
    console.log(`  [members ${code}] 失败(${e.message})`);
    return { total: 0, zt: 0, codes: [] };
  }
}

// ── 3. 板块指数 K线（拥挤度/动摇度/D回补）──
async function fetchBoardKline(code) {
  const secid = '90.' + code;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&beg=20260101&end=20261231&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57`;
  try {
    const j = await fetchJson(url);
    const kls = (j && j.data && j.data.klines) || [];
    return kls.map((s) => {
      const a = s.split(',');
      return { close: +a[2], amount: +a[6] };
    }).filter((x) => x.close > 0);
  } catch (e) {
    console.log(`  [kline ${code}] 失败(${e.message})`);
    return [];
  }
}

// ── 4. 股吧/个股人气榜（讨论度增强，取不到自动回退）──
async function fetchGubaRank() {
  try {
    const url = 'https://emappdata.eastmoney.com/stockrank/getAllCurrentList?app=pc&fields1=f1,f2,f3&fields2=f12,f14,f62,f184,f3,f10';
    const j = await fetchJson(url);
    const list = (j && j.data && j.data.diff) || (j && j.data) || [];
    const map = new Map();
    (Array.isArray(list) ? list : []).forEach((x, i) => { if (x.f12) map.set(x.f12, i + 1); });
    console.log(`[guba] 人气榜 ${map.size} 条`);
    return map;
  } catch (e) {
    console.log(`[guba] 失败(${e.message})，讨论度回退行为代理`);
    return null;
  }
}

// ── 宝妈指数计算 ──
async function computeMamaIndex(pool, guba) {
  const rows = [];
  for (const def of SECTOR_DEFS) {
    const board = matchBoard(def, pool);
    if (!board) {
      console.log(`[mama] ${def.name} 未匹配到 A 股板块，回退基线`);
      rows.push({ name: def.name, _fallback: true });
      continue;
    }
    console.log(`[mama] ${def.name} → 板块「${board.name}」(${board.code})`);
    const [members, klines] = await Promise.all([
      fetchBoardMembers(board.code),
      fetchBoardKline(board.code),
    ]);
    await sleep(500);

    // 原始指标
    const amounts = klines.map((k) => k.amount).filter((x) => x > 0);
    const closes = klines.map((k) => k.close);
    const lastAmt = amounts[amounts.length - 1] || 0;
    const prevAmt = amounts.slice(-21, -1);
    const crowdingRaw = prevAmt.length ? lastAmt / avg(prevAmt) : 1; // 成交额异动比

    const up = board.up, down = board.down;
    const diffusionRaw = (up + down) > 0 ? up / (up + down) : 0.5; // 上涨家数占比

    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
    const volatilityRaw = std(rets.slice(-20)) * Math.sqrt(252); // 年化波动

    const last5 = closes.slice(-5);
    const high5 = Math.max(...last5), low5 = Math.min(...last5);
    const drebRaw = high5 > low5 ? (closes[closes.length - 1] - low5) / (high5 - low5) : 0; // 从近期低点的回补强度

    const turnoverRaw = board.turnover; // 换手率 %
    const ztRaw = members.total ? (members.zt / members.total) * 100 : 0; // 涨停密度 %

    // 讨论度：行为代理 = 0.5*换手 + 0.5*涨停密度（归一化后交叉分位在下游做）
    // 先存原始，讨论度的人气榜增强放最后计算
    rows.push({
      name: def.name, _fallback: false, board: board.name,
      crowdingRaw, diffusionRaw, volatilityRaw, drebRaw, turnoverRaw, ztRaw,
      gubaCodes: members.codes,
    });
  }

  // 交叉分位排名（仅用非回退行）
  const valid = rows.filter((r) => !r._fallback);
  const col = (key) => valid.map((r) => r[key]);
  const cCrowd = col('crowdingRaw'), cDiff = col('diffusionRaw'), cVol = col('volatilityRaw');
  const cDreb = col('drebRaw'), cTurn = col('turnoverRaw'), cZt = col('ztRaw');

  // 行为代理讨论度原始 = 0.5*换手 + 0.5*涨停密度
  valid.forEach((r) => { r.discBehaviorRaw = 0.5 * r.turnoverRaw + 0.5 * r.ztRaw; });
  const cDiscB = valid.map((r) => r.discBehaviorRaw);

  // guba 增强：每个板块成员平均人气排名 → 越靠前(排名小)讨论度越高
  let cDiscG = null;
  if (guba && guba.size) {
    valid.forEach((r) => {
      const ranks = r.gubaCodes.map((c) => guba.get(c)).filter((x) => x != null);
      if (ranks.length) {
        const avgRank = avg(ranks);
        // 排名越小越热：换算成 0-100（用前 1000 名做上限）
        r.discGubaRaw = Math.max(0, 100 - (avgRank / 1000) * 100);
      } else r.discGubaRaw = null;
    });
    cDiscG = valid.map((r) => r.discGubaRaw).filter((x) => x != null);
  }

  const out = [];
  rows.forEach((r) => {
    if (r._fallback) {
      // 回退：沿用上一次/基线（调用方负责合并）
      out.push({ name: r.name, _fallback: true });
      return;
    }
    const crowding = pctRank(r.crowdingRaw, cCrowd);
    const diffusion = pctRank(r.diffusionRaw, cDiff);
    const volatility = pctRank(r.volatilityRaw, cVol);
    const dreb = pctRank(r.drebRaw, cDreb);
    const turnover = pctRank(r.turnoverRaw, cTurn);
    const zt = pctRank(r.ztRaw, cZt);
    const discB = pctRank(r.discBehaviorRaw, cDiscB);
    let discussion = discB;
    if (cDiscG && r.discGubaRaw != null) {
      const discG = pctRank(r.discGubaRaw, cDiscG);
      discussion = Math.round(0.6 * discB + 0.4 * discG);
    }
    const total = Math.round(
      (W.crowding * crowding + W.diffusion * diffusion + W.volatility * volatility +
       W.dreb * dreb + W.turnover * turnover + W.zt * zt) / WSUM
    );
    out.push({
      name: r.name, board: r.board,
      ore: crowding, dif: diffusion, wov: volatility, dbu: dreb,
      zt, hs: turnover, dis: discussion, total,
    });
  });
  return out;
}

// ── 指数 / ETF ──
async function fetchKlines(secid, beg, end) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&beg=${beg}&end=${end}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57`;
  const j = await fetchJson(url);
  const kls = (j && j.data && j.data.klines) || [];
  return kls.map((s) => {
    const a = s.split(',');
    return { date: a[0], close: +a[2] };
  });
}
function buildIndexItem(meta, bars) {
  if (!bars.length) return null;
  const last = bars[bars.length - 1];
  const price = last.close;
  let change = 0, pct = 0;
  if (bars.length >= 2) {
    const prev = bars[bars.length - 2].close;
    change = fmt2(price - prev); pct = fmt2(((price - prev) / prev) * 100);
  }
  return { name: meta.name, code: meta.code, price: fmt2(price), change, pct, date: last.date };
}
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

async function main() {
  const root = path.resolve(__dirname, '..');
  const dataPath = path.join(root, 'data.json');
  const customPath = path.join(root, 'custom-data.json');
  const prev = readJsonSafe(dataPath) || {};
  const customFile = readJsonSafe(customPath) || {};

  const today = new Date();
  const end = ymd(today);
  const begDate = new Date(today.getTime() - 200 * 86400000);
  const beg = ymd(begDate);

  // 指数
  const indexData = prev.indexData || {};
  for (const [key, meta] of Object.entries(INDEX_SECIDS)) {
    try {
      const bars = await fetchKlines(meta.secid, beg, end);
      const item = buildIndexItem(meta, bars);
      if (item) { indexData[key] = item; console.log(`[index] ${key} OK ${item.price} (${item.pct}%)`); }
    } catch (e) { console.log(`[index] ${key} 失败(${e.message})，保留旧值`); }
    await sleep(600);
  }

  // ETF
  let navHistory = prev.navHistory || [];
  try {
    const bars = await fetchKlines(ETF_SECID, beg, end);
    if (bars.length) {
      navHistory = bars.map((b) => ({ date: b.date, nav: fmt2(b.close) }));
      console.log(`[etf] 159995 OK ${bars.length} 根`);
    }
  } catch (e) { console.log(`[etf] 159995 失败(${e.message})，保留旧值`); }

  // ★ 宝妈指数
  let heatmapData = prev.heatmapData || [];
  try {
    const pool = await fetchBoardPool();
    const guba = await fetchGubaRank();
    const computed = await computeMamaIndex(pool, guba);
    // 合并：计算成功的用新值；回退行/失败行用上一次值；首次无旧值用内置基线
    const prevMap = new Map((prev.heatmapData || []).map((r) => [r.name, r]));
    const BASE = {
      芯片: { ore: 105, dif: 92, wov: 112, dbu: 35, zt: 60, hs: 80, dis: 85, total: 91, chg: 12 },
      半导体: { ore: 90, dif: 92, wov: 92, dbu: 60, zt: 55, hs: 75, dis: 80, total: 88, chg: 0 },
      细分化工: { ore: 55, dif: 60, wov: 40, dbu: 45, zt: 30, hs: 45, dis: 50, total: 50, chg: 0 },
      科创创业AI: { ore: 88, dif: 85, wov: 88, dbu: 55, zt: 65, hs: 78, dis: 82, total: 82, chg: 8 },
      机器人: { ore: 90, dif: 113, wov: 10, dbu: 53, zt: 60, hs: 70, dis: 78, total: 67, chg: 12 },
      新能源电池: { ore: 65, dif: 55, wov: 50, dbu: 40, zt: 35, hs: 55, dis: 55, total: 55, chg: -5 },
      恒生科技: { ore: 70, dif: 75, wov: 65, dbu: 72, zt: 40, hs: 60, dis: 70, total: 70, chg: 15 },
      创新药: { ore: 50, dif: 70, wov: 45, dbu: 55, zt: 30, hs: 50, dis: 55, total: 58, chg: 5 },
      锂矿: { ore: 60, dif: 65, wov: 55, dbu: 48, zt: 35, hs: 55, dis: 55, total: 60, chg: -3 },
      CPO: { ore: 65, dif: 82, wov: 77, dbu: 52, zt: 55, hs: 75, dis: 75, total: 77, chg: 11 },
      PCB: { ore: 80, dif: 78, wov: 70, dbu: 60, zt: 50, hs: 70, dis: 72, total: 75, chg: 6 },
    };
    // 防护：本次全部回退（板块接口被封锁/限流）且历史已有数据 → 保留真实值，绝不用静态基线覆盖
    if (computed.every((r) => r._fallback) && prev.heatmapData && prev.heatmapData.length) {
      console.log('[mama] 本次全部回退且有历史数据 → 保留上一次 heatmapData，不覆盖');
      heatmapData = prev.heatmapData;
    } else {
      heatmapData = computed.map((r) => {
        const base = BASE[r.name] || {};
        const merged = r._fallback ? (prevMap.get(r.name) || base) : r;
        const oldTotal = (prevMap.get(r.name) || {}).total;
        const chg = (merged.total != null && oldTotal != null) ? Math.round(merged.total - oldTotal) : (base.chg || 0);
        return {
          name: r.name, board: merged.board,
          ore: merged.ore ?? base.ore, dif: merged.dif ?? base.dif, wov: merged.wov ?? base.wov,
          dbu: merged.dbu ?? base.dbu, zt: merged.zt ?? base.zt, hs: merged.hs ?? base.hs,
          dis: merged.dis ?? base.dis, total: merged.total ?? base.total,
          _fallback: r._fallback || undefined, chg,
        };
      });
      console.log(`[mama] 计算完成，板块数=${heatmapData.length}`);
    }
  } catch (e) {
    console.log(`[mama] 计算失败(${e.message})，保留旧值`);
  }

  const valuationData = customFile.valuationData || prev.valuationData || BASELINE_CUSTOM.valuationData;
  const sectorBreakdown = customFile.sectorBreakdown || prev.sectorBreakdown || BASELINE_CUSTOM.sectorBreakdown;

  const bj = new Date(today.getTime() + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  const updatedAt = `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;

  const out = { updatedAt, source: 'eastmoney-kline + sentiment-engine', indexData, heatmapData, valuationData, navHistory, sectorBreakdown };
  fs.writeFileSync(dataPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n[done] data.json 已生成，updatedAt=${updatedAt}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
