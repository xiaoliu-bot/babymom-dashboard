/* ============================================================
 * fetch_data.js — GitHub Action 取数脚本
 * ------------------------------------------------------------
 * 每日收盘后由 GitHub Action 调用：
 *   1. 从东方财富 K线接口拉取 三大指数 + 芯片ETF 日线
 *   2. 计算指数最新价/涨跌额/涨跌幅；ETF 收盘价序列
 *   3. 合并 custom-data.json（热力图/估值/持仓，自定义数据）
 *   4. 写入 data.json，提交到仓库 → 静态页读取
 *
 * 容错：单个标的拉取失败时保留上一次 data.json 的值，页面不会空白。
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 标的 → 东财 secid
const INDEX_SECIDS = {
  sse:    { secid: '1.000001',  name: '上证指数',   code: '000001' },
  ndx:    { secid: '100.NDX',   name: '纳斯达克100', code: 'NDX' },
  hstech: { secid: '124.HSTECH', name: '恒生科技',   code: 'HSTECH' },
};
const ETF_SECID = '0.159995'; // 芯片ETF华夏

// ── 内置基线（custom-data.json 缺失或某字段缺失时兜底）──
const BASELINE_CUSTOM = {
  heatmapData: [
    { name: '芯片', ore: 105, dif: 92, wov: 112, dbu: 35, cro: 90, total: 91, chg: +12 },
    { name: '半导体', ore: 90, dif: 92, wov: 92, dbu: 60, cro: 90, total: 88, chg: 0 },
    { name: '细分化工', ore: 55, dif: 60, wov: 40, dbu: 45, cro: 35, total: 50, chg: 0 },
    { name: '科创创业AI', ore: 88, dif: 85, wov: 88, dbu: 55, cro: 80, total: 82, chg: +8 },
    { name: '机器人', ore: 90, dif: 113, wov: 10, dbu: 53, cro: 44, total: 67, chg: +12 },
    { name: '新能源电池', ore: 65, dif: 55, wov: 50, dbu: 40, cro: 50, total: 55, chg: -5 },
    { name: '恒生科技', ore: 70, dif: 75, wov: 65, dbu: 72, cro: 65, total: 70, chg: +15 },
    { name: '创新药', ore: 50, dif: 70, wov: 45, dbu: 55, cro: 40, total: 58, chg: +5 },
    { name: '锂矿', ore: 60, dif: 65, wov: 55, dbu: 48, cro: 55, total: 60, chg: -3 },
    { name: 'CPO', ore: 65, dif: 82, wov: 77, dbu: 52, cro: 85, total: 77, chg: +11 },
    { name: 'PCB', ore: 80, dif: 78, wov: 70, dbu: 60, cro: 75, total: 75, chg: +6 },
  ],
  valuationData: [
    { name: '半导体设备', pe: 166.96, pePct: 96.36, pbPct: 99.36, peChg: -7.5 },
    { name: '存储器/芯片', pe: 141.01, pePct: 95.48, pbPct: 99.48, peChg: -6.8 },
    { name: '半导体产业', pe: 124.23, pePct: 94.56, pbPct: 97.54, peChg: -7.2 },
    { name: '光模块CPO', pe: 71.92, pePct: 86.58, pbPct: 99.32, peChg: -9.6 },
    { name: '机器人概念', pe: 58.40, pePct: 72.30, pbPct: 78.50, peChg: +2.1 },
    { name: '恒生科技', pe: 32.50, pePct: 45.20, pbPct: 55.80, peChg: -3.4 },
    { name: '创新药', pe: 38.70, pePct: 38.50, pbPct: 42.10, peChg: +1.2 },
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

async function fetchKlines(secid, beg, end) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&beg=${beg}&end=${end}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const kls = (j && j.data && j.data.klines) || [];
  // 每条 "date,open,close,high,low,vol,amount"
  return kls.map((s) => {
    const a = s.split(',');
    return { date: a[0], open: +a[1], close: +a[2], high: +a[3], low: +a[4] };
  });
}

async function fetchWithRetry(secid, beg, end, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fetchKlines(secid, beg, end); }
    catch (e) { lastErr = e; await sleep(2000 * (i + 1)); }
  }
  throw lastErr;
}

function buildIndexItem(meta, bars) {
  if (!bars || bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const price = last.close;
  let change = 0, pct = 0;
  if (bars.length >= 2) {
    const prev = bars[bars.length - 2].close;
    change = fmt2(price - prev);
    pct = fmt2(((price - prev) / prev) * 100);
  }
  return { name: meta.name, code: meta.code, price: fmt2(price), change, pct, date: last.date };
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

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

  const indexData = prev.indexData || {};
  for (const [key, meta] of Object.entries(INDEX_SECIDS)) {
    try {
      const bars = await fetchWithRetry(meta.secid, beg, end);
      const item = buildIndexItem(meta, bars);
      if (item) { indexData[key] = item; console.log(`[index] ${key} OK price=${item.price} pct=${item.pct}% (${item.date})`); }
      else console.log(`[index] ${key} 无数据`);
    } catch (e) {
      console.log(`[index] ${key} 失败(${e.message})，保留旧值`);
    }
    await sleep(800);
  }

  // ETF 收盘价序列（净值走势图）
  let navHistory = prev.navHistory || [];
  try {
    const bars = await fetchWithRetry(ETF_SECID, beg, end);
    if (bars.length) {
      navHistory = bars.map((b) => ({ date: b.date, nav: fmt2(b.close) }));
      console.log(`[etf] 159995 OK ${bars.length} 根，最新 ${navHistory[navHistory.length - 1].date} 收盘 ${navHistory[navHistory.length - 1].nav}`);
    }
  } catch (e) {
    console.log(`[etf] 159995 失败(${e.message})，保留旧值`);
  }

  // 自定义数据：custom-data.json 优先，缺失字段用基线
  const heatmapData = customFile.heatmapData || prev.heatmapData || BASELINE_CUSTOM.heatmapData;
  const valuationData = customFile.valuationData || prev.valuationData || BASELINE_CUSTOM.valuationData;
  const sectorBreakdown = customFile.sectorBreakdown || prev.sectorBreakdown || BASELINE_CUSTOM.sectorBreakdown;

  // 北京时间
  const bj = new Date(today.getTime() + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  const updatedAt = `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;

  const out = { updatedAt, source: 'eastmoney-kline + custom', indexData, heatmapData, valuationData, navHistory, sectorBreakdown };
  fs.writeFileSync(dataPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n[done] data.json 已生成，updatedAt=${updatedAt}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
