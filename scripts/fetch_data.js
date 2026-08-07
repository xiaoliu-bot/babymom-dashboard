/* ============================================================
 * fetch_data.js — GitHub Action 取数脚本（v5：Tushare 免费档 + 腾讯自选股实时/指数/估值 + 东财仅本地）
 * ------------------------------------------------------------
 * 数据源策略（v5：Tushare 主 + 腾讯自选股实时/指数/估值兜底 + 东财仅本地）：
 *   ★ 主力 = Tushare 免费档（从 GitHub 美国 runner 可直连，无需大陆 IP）：
 *       - stock_basic  → 全 A 股列表 + 行业(industry) + 流通股本(float_share)，直接当「板块篮子」
 *       - daily(trade_date=当天) 批量 → 一次拿全市场 OHLC/涨跌幅/成交量/成交额
 *       - index_daily(000001.SH) → 上证指数序列
 *       → 自聚合成板块，算出「小白指数」6 维（拥挤度/扩散力/动摇度/D回补/换手度/涨停密度）
 *   ★ 实时主力 + 海外备份 = 腾讯自选股（免 key、全球 CDN 可达，GitHub 美国 runner 可直连）：
 *       - qt.gtimg.cn 实时行情 → 盘中快照（替代/兜底新浪），覆盖 A股/港股/美股/指数
 *       - 上证 / 纳斯达克100 / 恒生科技 实时报价 → 指数卡片（替代被墙的东财）
 *       - A股板块 PE/PB（f[39]=PE-TTM / f[46]=PB）→ 板块估值表（替代原 manual/custom-data.json 写死值）
 *       - A股 流通市值（f[44]）→ 流通股本 → 修复「换手度」维度（free Tushare 不返回 float_share，hs 原恒为 0）
 *   ☆ 本地增强 = 东方财富（仅大陆 IP / 自托管 runner；设 EM_LOCAL=1 启用，GitHub 美国 runner 被墙）：
 *       - 股吧人气榜 → 已弃用（随「讨论度」维度移除，看板不再依赖任何行为代理推算数据）
 *   任何一部分失败都保留上一次真实值，绝不用静态基线覆盖。
 *
 * 小白指数 = 板块级「情绪化散户活跃度」代理：
 *   拥挤度(成交额异动) / 扩散力(上涨家数占比) / 动摇度(年化波动) /
 *   D回补(从低点回补) / 换手度 / 涨停密度 → 跨板块分位(0-100) → 加权总分
 *   注：讨论度(dis)已从看板移除（仅为换手+涨停密度的行为代理，非真实讨论数据）
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TUSHARE_TOKEN;
if (!TOKEN) {
  console.warn('[warn] 未设置 TUSHARE_TOKEN：Tushare 主数据源不可用，将仅依赖腾讯实时兜底（板块聚合可能为空）。请在仓库 Secrets 中配置 TUSHARE_TOKEN。');
}
const TUSHARE_API = 'https://api.tushare.pro';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const EM_HEADERS = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 可调参数 ──
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS) || 45; // 历史回看窗口（用于拥挤度基线 + 波动/回补）
const WEEK_DAYS = Number(process.env.WEEK_DAYS) || 5; // 周统计回看交易日数（默认近 5 个交易日）
const HISTORY_VERSION = 3; // 历史缓存结构版本；变更存储字段时 +1，触发旧缓存重建
const MIN_STOCKS = 5; // 板块最少成分股（白名单篮子均≥10，留余量防轻量日跌破）
const CALL_GAP = Number(process.env.CALL_GAP) || 1200; // Tushare 调用间隔(ms)，礼貌限速

// 指数卡片所需标的（上证来自腾讯实时；纳指100/恒生科技来自腾讯实时，原东财路径在 GitHub 美国 runner 被墙，已改用腾讯）
// 东财仅作「本地/自托管 runner」增强（EM_LOCAL=1 时启用股吧人气榜），CI 下不依赖。
const INDEX_KEYS = ['sse', 'ndx', 'hstech'];
// 小白指数权重（6 个交易行为维度合成总分）
const W = { crowding: 0.25, diffusion: 0.15, volatility: 0.15, dreb: 0.10, turnover: 0.15, zt: 0.10 };
const WSUM = Object.values(W).reduce((a, b) => a + b, 0);

// 估值表完全由腾讯实时 PE/PB（板块市值加权）+ 自采集历史百分位自动计算，
// 不再使用任何静态基线 / 硬编码分位（冷启动不足时前端显示「样本累积中」）。
// 恒生科技为指数、不可比，已从估值表移除，仅在顶部指数卡片跟踪。

// ── 估值自动化（腾讯实时 PE/PB → 板块市值加权 → 自采集历史百分位）──
const VAL_HISTORY_VERSION = 1;
const VAL_MIN_HIST = 12;       // 自采集历史达到该交易日数后才算百分位；不足时 PE%/PB% 标记 null（前端显示「样本累积中」）
const VAL_MIN_STOCKS = 3;      // 板块参与 PE/PB 加权的最少有效成分股
const VAL_PB_FIELDS = true;    // 占位，PB 同理由 f[46] 取
// 恒生科技为指数，PE/PB 无法由成分股聚合；估值表仅覆盖股票板块，指数仅在顶部卡片跟踪
const VAL_INDEX_NAMES = ['恒生科技'];

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'cache');
const VAL_HISTORY_CACHE = path.join(CACHE_DIR, 'sector_valuation_history.json');
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

// ── 监控白名单：仅计算这些板块的小白指数（用户指定，2026-07-23）──
// 恒生科技为指数，单独在顶部指数卡片跟踪，不计入股票板块篮子。
const WATCHLIST = ['存储芯片', '半导体', 'CPO', 'PCB', '科创创业AI', '细分化工', '锂矿', '机器人', '创新药', '电力', '电网', '电池'];

// custom-data.json.valuationData 名称 → 监控板块（用于手动覆盖匹配）
const VAL_MAP = { '半导体设备': '半导体', '存储器/芯片': '存储芯片', '半导体产业': '半导体', '光模块CPO': 'CPO', '机器人概念': '机器人', '恒生科技': '恒生科技', '创新药': '创新药', '新能源电池': '电池' };

// 把单只股票归类到白名单板块（行业 + 名称关键词）；返回 null 表示不监控
function classifySector(sb) {
  const ind = (sb && sb.industry) || '';
  const nm = (sb && sb.name) || '';
  if (ind === '半导体' && /存储|兆易|君正|江波龙|佰维|普冉|聚辰|澜起|东芯|北京君正|国科微|景嘉微|复旦微|深科技|太极实业/.test(nm)) return '存储芯片';
  if (ind === '半导体') return '半导体';
  if (ind === '电网设备') return '电网';
  if (ind === '电池') return '电池';
  if (ind === '电力') return '电力';
  if (['化学制品', '化学原料', '化学纤维', '农化制品', '塑料', '橡胶', '化学试剂'].includes(ind)) return '细分化工';
  if (['化学制药', '生物制品', '中药Ⅱ'].includes(ind)) return '创新药';
  if (ind === '能源金属' || /锂|赣锋|天齐|盐湖|盛新|融捷|永兴|中矿|雅化|天华|江特|藏格|钴|镍/.test(nm)) return '锂矿';
  if (/cpo|光模块|中际旭创|新易盛|天孚|光迅|太辰|源杰|华工科技|剑桥科技|博创|兆龙|德科立|联特|铭普|罗博|锐捷|震有/.test(nm)) return 'CPO';
  if (/pcb|电路板|深南电路|沪电|鹏鼎|胜宏|景旺|崇达|兴森|东山精密|超声电子|世运电路|澳弘|满坤|中富电路|金禄|四会富仕|本川/.test(nm)) return 'PCB';
  if (/机器人|埃斯顿|拓斯达|汇川|绿的谐波|双环|中大力德|鸣志|柯力|埃夫特|新时达|克来|迈赫|江苏北人|拓普|三花|凯尔达|禾川|步科/.test(nm)) return '机器人';
  if (/人工智能|大模型|算力|智算|寒武纪|海光|中科曙光|科大讯飞|金山办公|昆仑万维|万兴|拓维|浪潮|云从|汉王|商汤|虹软|格灵深瞳|当虹|云天励飞|海天瑞声|拓尔思|神州泰岳|三六零|视觉中国|人民网|新华网|中文在线/.test(nm)) return '科创创业AI';
  return null;
}

// ── 个股日线聚合为板块 ──
function aggregate(rows, sbMap, classify) {
  const sec = {};
  for (const r of rows) {
    const sb = sbMap[r.ts_code];
    if (!sb) continue;
    const ind = classify ? classify(sb) : (sb.industry || null);
    if (!ind) continue;
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
  let hist = readJsonSafe(HISTORY_CACHE) || {};
  if (hist.version !== HISTORY_VERSION || !Array.isArray(hist.days)) hist = { version: HISTORY_VERSION, days: [] };
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
          const agg = aggregate(rows, sbMap, classifySector);
          // 存全字段（up/total/zt/tNum/tDen 供周聚合；codes 仅今日需要，历史不存省空间）
          const entry = { date: d, ret: {}, amt: {}, up: {}, total: {}, zt: {}, tNum: {}, tDen: {} };
          for (const k in agg) {
            entry.ret[k] = agg[k].ret;
            entry.amt[k] = agg[k].amt;
            entry.up[k] = agg[k].up;
            entry.total[k] = agg[k].total;
            entry.zt[k] = agg[k].zt;
            entry.tNum[k] = agg[k].tNum;
            entry.tDen[k] = agg[k].tDen;
          }
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

// ── 5. 小白指数计算（按过去 WEEK_DAYS 个交易日聚合，降噪、看周度趋势）──
function computeMama(weekDays, histDays, todayYmd) {
  if (!weekDays || !weekDays.length) return [];
  // weekDays: 最近 WEEK_DAYS 个交易日的完整板块聚合（含今日），按 date 升序
  //   每个 entry: { date, ret:{}, amt:{}, up:{}, total:{}, zt:{}, tNum:{}, tDen:{} }
  const last = weekDays[weekDays.length - 1]; // 今日（决定板块集合）
  const sectors = Object.keys(last.amt || {}).filter((k) => (last.total[k] || 0) >= MIN_STOCKS);
  const weekStart = weekDays[0].date;
  const baselineDays = (histDays || []).filter((d) => d.date < weekStart); // 早于本周的历史：拥挤度基线

  const raw = {};
  for (const s of sectors) {
    const amtsW = weekDays.map((d) => d.amt[s]).filter((x) => x != null);
    const weekAmtAvg = avg(amtsW);
    const baseAmts = baselineDays.map((d) => d.amt[s]).filter((x) => x != null);
    const baseAmtAvg = avg(baseAmts);
    const crowdingRaw = baseAmtAvg > 0 ? weekAmtAvg / baseAmtAvg : 1; // 周日均成交额 / 更早历史日均

    const rets = weekDays.map((d) => d.ret[s]).filter((x) => x != null);
    const volatilityRaw = std(rets) * Math.sqrt(252); // 本周日收益年化波动
    let idx = 100, minIdx = 100;
    for (let i = 0; i < rets.length; i++) { idx *= 1 + rets[i]; if (idx < minIdx) minIdx = idx; }
    const drebRaw = minIdx > 0 ? idx / minIdx - 1 : 0; // 本周累计收益从周低点回补

    let sumUp = 0, sumTotal = 0, sumZt = 0, sumTNum = 0, sumTDen = 0;
    for (const d of weekDays) {
      sumUp += d.up[s] || 0;
      sumTotal += d.total[s] || 0;
      sumZt += d.zt[s] || 0;
      sumTNum += d.tNum[s] || 0;
      sumTDen += d.tDen[s] || 0;
    }
    const diffusionRaw = sumTotal > 0 ? sumUp / sumTotal : 0;        // 周上涨家数占比
    const turnoverRaw = sumTDen > 0 ? (sumTNum / sumTDen) * 100 : 0; // 周累计换手率
    const ztRaw = sumTotal > 0 ? (sumZt / sumTotal) * 100 : 0;       // 周累计涨停密度
    raw[s] = { crowdingRaw, volatilityRaw, drebRaw, diffusionRaw, turnoverRaw, ztRaw };
  }

  const arr = (key) => sectors.map((s) => raw[s][key]);
  const cCrowd = arr('crowdingRaw'), cVol = arr('volatilityRaw'), cDreb = arr('drebRaw');
  const cDiff = arr('diffusionRaw'), cTurn = arr('turnoverRaw'), cZt = arr('ztRaw');

  return sectors.map((s) => {
    const crowding = pctRank(raw[s].crowdingRaw, cCrowd);
    const volatility = pctRank(raw[s].volatilityRaw, cVol);
    const dreb = pctRank(raw[s].drebRaw, cDreb);
    const diffusion = pctRank(raw[s].diffusionRaw, cDiff);
    const turnover = pctRank(raw[s].turnoverRaw, cTurn);
    const zt = pctRank(raw[s].ztRaw, cZt);
    const total = Math.round(
      (W.crowding * crowding + W.diffusion * diffusion + W.volatility * volatility +
        W.dreb * dreb + W.turnover * turnover + W.zt * zt) / WSUM
    );
    // 小白指数 = 6 个交易行为维度加权；讨论度(dis)已移除（非真实数据，仅为换手+涨停密度的行为代理）
    return { name: s, board: s, ore: crowding, dif: diffusion, wov: volatility, dbu: dreb, zt, hs: turnover, total };
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
// 注：fetchGubaRank（东财股吧人气榜）已随「讨论度」维度一并移除，看板不再依赖非实时/行为代理推算数据。
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
// 注意单位对齐（否则 小白指数 维度会失真）：
//   ret   = 当日收益率(%)（与 Tushare pct_chg 同义）
//   amt   = 成交额，新浪单位为「元」→ ÷1000 转「千元」，对齐 Tushare daily.amount
//   volume= 成交量，新浪单位为「股」（已验证 price×vol≈amount），无需像 Tushare(手) 那样 ×100
function buildRealtimeSec(map, sbMap) {
  const sec = {};
  for (const code in map) {
    const rt = map[code];
    const sb = sbMap[code];
    if (!sb) continue;
    const ind = classifySector(sb);
    if (!ind) continue;
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
    if (!sb) continue;
    if (!classifySector(sb)) continue; // 只取白名单成分股，降低新浪请求量/限频风险
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

// ── 腾讯自选股（实时行情 + 指数；免 key、全球 CDN 可达，GitHub 美国 runner 可直连）──
// 角色：① 实时主力（盘中快照，替代/兜底新浪）；② 指数来源（替代被墙的东财，覆盖 上证/纳指100/恒生科技）。
// 接口：https://qt.gtimg.cn/q=<codes> 返回 GBK 文本，~ 分隔字段，形如 v_sh600000="1~平安银行~000001~price~...";
// 限流：腾讯较宽松，仍加全局限速 + 封禁冷却，与新浪同构。
const TENCENT_QUOTE = 'https://qt.gtimg.cn/q=';
const TENCENT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://gu.qq.com/',
};
const TENCENT_MIN_GAP = 300;             // 两次请求最小间隔(ms)
const TENCENT_JITTER = 200;             // 随机抖动上限(ms)
const TENCENT_CHUNK = 60;               // 单次批量代码数
const TENCENT_RT_TTL = 20 * 60 * 1000;  // 实时快照本地缓存 20 分钟
const TENCENT_BAN_COOLDOWN = 5 * 60 * 1000;
const TENCENT_RT_CACHE = path.join(CACHE_DIR, 'tencent_realtime.json');
const TENCENT_IDX = { sse: 'sh000001', ndx: 'usNDX', hstech: 'hkHSTECH' };
let _txLastCall = 0;
let _txBannedUntil = 0;

function tencentThrottle() {
  const now = Date.now();
  const wait = Math.max(0, _txLastCall + TENCENT_MIN_GAP + Math.random() * TENCENT_JITTER - now);
  return sleep(wait);
}
async function tencentFetchText(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (Date.now() < _txBannedUntil) throw new Error('腾讯处于封禁冷却期');
    await tencentThrottle();
    _txLastCall = Date.now();
    try {
      const res = await fetch(url, { headers: TENCENT_HEADERS });
      if (res.status === 403 || res.status === 429) {
        _txBannedUntil = Date.now() + TENCENT_BAN_COOLDOWN;
        lastErr = new Error('腾讯限流 HTTP ' + res.status);
        await sleep(2000 * (i + 1));
        continue;
      }
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); await sleep(1500 * (i + 1)); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const txt = new TextDecoder('gbk').decode(buf); // 腾讯返回 GBK
      if (!txt.includes('v_')) { lastErr = new Error('返回空/无数据'); await sleep(1500 * (i + 1)); continue; }
      return txt;
    } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}
// 解析腾讯实时 → 与 parseSinaRealtime 同构的 {name, open, preClose, current, high, low, volume, amount}
// 单位对齐（否则 小白指数 维度失真，原则同新浪）：
//   amount = 成交额，腾讯 f[37]=万元 → ×10000 转「元」（buildRealtimeSec 内再 /1000 千元，与 Tushare 对齐）
//   volume = 成交量，腾讯 f[36]=手 → ×100 转「股」（float_share 为股）
function parseTencentRealtime(txt) {
  const map = {};
  txt.split(';\n').forEach((line) => {
    const m = line.match(/v_(\w+)="(.*)"/);
    if (!m) return;
    const sym = m[1];
    const f = m[2].split('~');
    if (f.length < 10) return;
    const name = f[1];
    const preClose = Number(f[4]);
    const current = Number(f[3]);
    if (!isFinite(current) || !isFinite(preClose) || preClose <= 0) return;
    // PE/PB 仅对 A股取（f[39]=PE-TTM, f[46]=PB）；港股/美股字段布局不同，不解析
    // f[44]=流通市值(亿元) → 转 元 用于估值市值加权；÷当前价 可得流通股本(股) 修复换手度维度
    let pe = null, pb = null, mcap = null;
    if (/^(sh|sz)/.test(sym)) {
      const peRaw = Number(f[39]);
      const pbRaw = Number(f[46]);
      const mvRaw = Number(f[44]);
      if (isFinite(peRaw) && peRaw > 0) pe = fmt2(peRaw);
      if (isFinite(pbRaw) && pbRaw > 0) pb = fmt2(pbRaw);
      if (isFinite(mvRaw) && mvRaw > 0) mcap = Math.round(mvRaw * 1e8); // 亿元 → 元
    }
    map[sym] = {
      name,
      open: Number(f[5]) || 0,
      preClose,
      current,
      high: Number(f[33]) || 0,
      low: Number(f[34]) || 0,
      volume: (Number(f[36]) || 0) * 100,    // 手 → 股
      amount: (Number(f[37]) || 0) * 10000,  // 万元 → 元
      pe, pb, mcap,
    };
  });
  return map;
}
async function fetchTencentRealtime(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += TENCENT_CHUNK) {
    const batch = codes.slice(i, i + TENCENT_CHUNK);
    try {
      const txt = await tencentFetchText(TENCENT_QUOTE + batch.join(','));
      Object.assign(out, parseTencentRealtime(txt));
    } catch (e) {
      console.log(`[tx] 批量失败(${e.message})，该批 ${batch.length} 只跳过`);
    }
  }
  return out;
}
function loadTencentRtCache() {
  const c = readJsonSafe(TENCENT_RT_CACHE);
  if (c && c.savedAt && (Date.now() - new Date(c.savedAt).getTime()) < TENCENT_RT_TTL && c.map) return c.map;
  return null;
}
function saveTencentRtCache(map) { writeJsonSafe(TENCENT_RT_CACHE, { savedAt: new Date().toISOString(), map }); }
// 腾讯实时 → 板块聚合（带 20 分钟本地缓存，结构同 getSinaTodaySec）
async function getTencentTodaySec(sbMap) {
  const txSbMap = {};
  const symbols = [];
  for (const ts in sbMap) {
    const sb = sbMap[ts];
    if (!sb) continue;
    if (!classifySector(sb)) continue; // 只取白名单成分股，降低请求量/限频风险
    const sym = tsCodeToSina(ts); // 腾讯符号规则同新浪（sh/sz + 代码）
    txSbMap[sym] = { ...sb, ts_code: ts };
    symbols.push(sym);
  }
  const cached = loadTencentRtCache();
  if (cached && Object.keys(cached).length) {
    const sec = buildRealtimeSec(cached, txSbMap);
    console.log(`[tx] 命中 ${(TENCENT_RT_TTL / 60000)} 分钟缓存，${Object.keys(sec).length} 个行业`);
    return sec;
  }
  try {
    const map = await fetchTencentRealtime(symbols);
    if (map && Object.keys(map).length) {
      saveTencentRtCache(map);
      const sec = buildRealtimeSec(map, txSbMap);
      console.log(`[tx] 实时拉取 ${Object.keys(map).length} 只，${Object.keys(sec).length} 个行业`);
      return sec;
    }
    console.log('[tx] 实时返回为空（可能盘中未开或限流）');
  } catch (e) { console.log(`[tx] 实时拉取失败(${e.message})`); }
  return null;
}
// 腾讯实时 → 指数卡片（上证/纳指100/恒生科技；返回 {sse,ndx,hstech}）
async function fetchTencentIndices(todayYmd) {
  const idxDate = todayYmd || ymd(new Date(Date.now() + 8 * 3600000)); // 默认北京时间当日
  const syms = Object.values(TENCENT_IDX);
  try {
    const txt = await tencentFetchText(TENCENT_QUOTE + syms.join(','));
    const map = parseTencentRealtime(txt);
    const out = {};
    for (const [key, sym] of Object.entries(TENCENT_IDX)) {
      const r = map[sym];
      if (!r) continue;
      const change = fmt2(r.current - r.preClose);
      out[key] = { name: r.name, code: sym, price: fmt2(r.current), change, pct: fmt2((r.current - r.preClose) / r.preClose * 100), date: idxDate };
    }
    return out;
  } catch (e) { console.log('[tx idx] 失败', e.message); return {}; }
}

// 指数 last-good 缓存（腾讯失败后回退到最近一次成功值，避免静默用任意旧 data.json）
const INDEX_CACHE = path.join(CACHE_DIR, 'index_history.json');
function saveIndexCache(data) { if (data && data.sse) writeJsonSafe(INDEX_CACHE, { savedAt: new Date().toISOString(), data }); }
function loadIndexCache() { const c = readJsonSafe(INDEX_CACHE); return (c && c.data) || null; }

// ── 腾讯实时 → 板块 PE/PB 估值（免费、海外可达；市值加权聚合成分股）──
async function getTencentValuationMap(sbMap) {
  const txSbMap = {};
  const symbols = [];
  for (const ts in sbMap) {
    const sb = sbMap[ts];
    if (!sb) continue;
    const sec = classifySector(sb);
    if (!sec || !WATCHLIST.includes(sec)) continue;
    const sym = tsCodeToSina(ts);
    txSbMap[sym] = { ...sb, ts_code: ts };
    symbols.push(sym);
  }
  let map = null;
  const cached = loadTencentRtCache();
  if (cached && Object.keys(cached).length && cached[symbols[0]] && cached[symbols[0]].mcap !== undefined) {
    map = cached;
    console.log(`[tx val] 命中 ${TENCENT_RT_TTL / 60000} 分钟缓存`);
  } else {
    try {
      map = await fetchTencentRealtime(symbols);
      if (map && Object.keys(map).length) { saveTencentRtCache(map); console.log(`[tx val] 实时拉取 ${Object.keys(map).length} 只`); }
    } catch (e) { console.log(`[tx val] 实时拉取失败(${e.message})`); }
  }
  const out = {};
  if (map) {
    for (const sym in map) {
      const rt = map[sym];
      const ts = txSbMap[sym] && txSbMap[sym].ts_code;
      if (!ts) continue;
      const floatShares = (rt.mcap != null && rt.current > 0) ? Math.round(rt.mcap / rt.current) : null; // 流通股本(股)
      out[ts] = {
        pe: rt.pe != null ? rt.pe : null,
        pb: rt.pb != null ? rt.pb : null,
        price: rt.current,
        mcap: rt.mcap != null ? rt.mcap : null,   // 流通市值(元)
        floatShares,                              // 流通股本(股) → 修复换手度维度
      };
    }
  }
  return out;
}

// 计算今日各板块市值加权 PE/PB，并写入自采集历史缓存（同日期去重重算）
function ensureValuationHistory(sbMap, valuationMap, todayYmd) {
  let hist = readJsonSafe(VAL_HISTORY_CACHE) || {};
  if (hist.version !== VAL_HISTORY_VERSION || !Array.isArray(hist.days)) hist = { version: VAL_HISTORY_VERSION, days: [] };

  const acc = {};
  for (const ts in valuationMap) {
    const sb = sbMap[ts];
    if (!sb) continue;
    const sec = classifySector(sb);
    if (!sec || !WATCHLIST.includes(sec)) continue;
    const v = valuationMap[ts];
    if (v.pe == null || v.pb == null) continue;
    const mcap = v.mcap;                 // 流通市值(元)，已由腾讯实时补充（free Tushare 不返回）
    if (!(mcap > 0)) continue;
    if (!acc[sec]) acc[sec] = { capSum: 0, earnSum: 0, bvSum: 0, valid: 0 };
    const s = acc[sec];
    s.capSum += mcap;
    s.earnSum += mcap / v.pe;   // 市值加权 PE = Σ市值 / Σ盈利
    s.bvSum += mcap / v.pb;     // 市值加权 PB = Σ市值 / Σ净资产
    s.valid += 1;
  }
  const todayEntry = { date: todayYmd, pe: {}, pb: {} };
  for (const sec in acc) {
    const s = acc[sec];
    if (s.valid >= VAL_MIN_STOCKS && s.earnSum > 0 && s.bvSum > 0) {
      todayEntry.pe[sec] = fmt2(s.capSum / s.earnSum);
      todayEntry.pb[sec] = fmt2(s.capSum / s.bvSum);
    }
  }
  // 同日期去重（双 cron 可能同日多次运行）
  hist.days = hist.days.filter((d) => d.date !== todayYmd);
  if (Object.keys(todayEntry.pe).length) {
    hist.days.push(todayEntry);
    if (hist.days.length > 300) hist.days = hist.days.slice(-300);
    writeJsonSafe(VAL_HISTORY_CACHE, hist);
    console.log(`[val] 写入自采集历史，今日 ${Object.keys(todayEntry.pe).length} 个板块，历史 ${hist.days.length} 天`);
  } else {
    console.log(`[val] 今日无有效 PE/PB（可能盘中未开/限流），沿用历史`);
  }
  return { hist, today: todayEntry };
}

// 由自采集历史 + 今日值 → 估值表行（PE/PB 实时；百分位=自采集历史内分位；冷启动用基线种子）
function computeValuationTable(hist, todayEntry, customFile) {
  const histEnough = (hist.days || []).length >= VAL_MIN_HIST;
  const rows = [];
  for (const sec of WATCHLIST) {
    const pe = todayEntry.pe[sec];
    const pb = todayEntry.pb[sec];
    if (pe == null || pb == null) continue;
    let pePct, pbPct, peChg = 0;
    if (histEnough) {
      const pes = hist.days.map((d) => d.pe[sec]).filter((x) => x != null);
      const pbs = hist.days.map((d) => d.pb[sec]).filter((x) => x != null);
      pePct = pctRank(pe, pes);
      pbPct = pctRank(pb, pbs);
      const back = Math.min(5, hist.days.length - 1);
      const oldPe = hist.days[hist.days.length - 1 - back] && hist.days[hist.days.length - 1 - back].pe[sec];
      if (oldPe) peChg = fmt2((pe - oldPe) / oldPe * 100);
    } else {
      // 自采集历史不足 VAL_MIN_HIST 天：百分位尚未可信，标记为 null（前端显示「样本累积中」），绝不回填静态基线伪装真实分位
      pePct = null;
      pbPct = null;
      peChg = null;
    }
    rows.push({ name: sec, pe, pePct, pbPct, peChg });
  }
  // 自定义覆盖（custom-data.json.valuationData，经 VAL_MAP 映射到监控板块；可选手动钉值）
  const customRows = (customFile.valuationData || [])
    .map((r) => ({ ...r, _target: VAL_MAP[r.name] }))
    .filter((r) => r._target);
  customRows.forEach((r) => {
    const i = rows.findIndex((x) => x.name === r._target);
    if (i >= 0) rows[i] = { name: r._target, pe: r.pe, pePct: r.pePct, pbPct: r.pbPct, peChg: r.peChg != null ? r.peChg : 0 };
  });
  // 恒生科技为指数、不可比，已从估值表移除（仅在顶部指数卡片跟踪）
  // 按 PE%位 降序（估值越高越靠前）
  rows.sort((a, b) => b.pePct - a.pePct);
  return rows;
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
  // 腾讯实时补充流通股本（免费、海外可达）→ 修复「换手度」维度
  //   free Tushare 的 stock_basic 不返回 float_share，导致 hs 恒为 0；此处用 f[44]流通市值÷现价 推导
  let valMap = {};
  try { valMap = await getTencentValuationMap(sbMap); } catch (e) { console.log('[float] 腾讯补充失败', e.message); }
  let enrichedFloat = 0;
  for (const ts in valMap) { const fs2 = valMap[ts].floatShares; if (fs2 && fs2 > 0 && sbMap[ts]) { sbMap[ts].float_share = fs2; enrichedFloat++; } }
  if (enrichedFloat) console.log(`[float] 腾讯补充流通股本 ${enrichedFloat} 只（换手度维度已激活）`);
  const hist = await ensureHistory(sbMap);

  // ── 今日板块聚合 ──
  //   午盘：Tushare daily 尚未发布 → 优先新浪实时（盘中快照）
  //   收盘：优先 Tushare daily（收盘权威值）；若未发布/限流 → 新浪实时回补（=当日收盘真实价）
  let todaySec = null;
  let realtimeSrc = false;
  let txRealtimeUsed = false;
  if (SESSION === 'midday') {
    // 午盘：Tushare daily 尚未发布 → 腾讯实时（盘中快照）优先，新浪兜底
    const txSec = await getTencentTodaySec(sbMap);
    if (txSec && Object.keys(txSec).length) { todaySec = txSec; realtimeSrc = true; txRealtimeUsed = true; console.log('[today] 午盘数据源=腾讯实时（盘中）'); }
    else {
      const sinaSec = await getSinaTodaySec(sbMap);
      if (sinaSec && Object.keys(sinaSec).length) { todaySec = sinaSec; realtimeSrc = true; console.log('[today] 午盘腾讯失败，回退新浪实时'); }
      else console.log('[today] 午盘实时无数据，保留旧值');
    }
  } else {
    try {
      const rows = await fetchDaily(TODAY_YMD);
      if (rows && rows.length) { todaySec = aggregate(rows, sbMap, classifySector); console.log(`[today] ${TODAY_YMD} ${rows.length} 行, ${Object.keys(todaySec).length} 个板块`); }
      else console.log(`[today] ${TODAY_YMD} Tushare 无数据（未发布/非交易日？尝试实时回补）`);
    } catch (e) { console.log(`[today] Tushare daily 失败(${e.message})，尝试实时回补`); }
    if (!todaySec) {
      // 收盘回补：腾讯实时优先，新浪兜底（=当日收盘真实价）
      const txSec = await getTencentTodaySec(sbMap);
      if (txSec && Object.keys(txSec).length) { todaySec = txSec; realtimeSrc = true; txRealtimeUsed = true; console.log('[today] 收盘回补数据源=腾讯实时'); }
      else {
        const sinaSec = await getSinaTodaySec(sbMap);
        if (sinaSec && Object.keys(sinaSec).length) { todaySec = sinaSec; realtimeSrc = true; console.log('[today] 收盘回补数据源=新浪实时'); }
      }
    }
  }

  let heatmapData = prev.heatmapData || [];
  if (todaySec && Object.keys(todaySec).length) {
    // 构造「今日」板块聚合 entry（含全部字段），与历史合并取近 WEEK_DAYS 交易日形成周窗口
    const todayEntry = { date: TODAY_YMD, ret: {}, amt: {}, up: {}, total: {}, zt: {}, tNum: {}, tDen: {}, codes: {} };
    for (const k in todaySec) {
      todayEntry.ret[k] = todaySec[k].ret;
      todayEntry.amt[k] = todaySec[k].amt;
      todayEntry.up[k] = todaySec[k].up;
      todayEntry.total[k] = todaySec[k].total;
      todayEntry.zt[k] = todaySec[k].zt;
      todayEntry.tNum[k] = todaySec[k].tNum;
      todayEntry.tDen[k] = todaySec[k].tDen;
      todayEntry.codes[k] = todaySec[k].codes;
    }
    const histDaysNoToday = (hist.days || []).filter((d) => d.date !== TODAY_YMD);
    const allSorted = histDaysNoToday.concat([todayEntry]).sort((a, b) => a.date.localeCompare(b.date));
    const weekDays = allSorted.slice(-WEEK_DAYS);

    const computed = computeMama(weekDays, histDaysNoToday, TODAY_YMD);
    if (computed.length) {
      const prevMap = new Map((prev.heatmapData || []).map((r) => [r.name, r]));
      heatmapData = computed
        .map((r) => {
          const old = (prevMap.get(r.name) || {}).total;
          const chg = old != null ? Math.round(r.total - old) : 0;
          return { ...r, chg };
        })
        .sort((a, b) => b.total - a.total);
      heatmapData = heatmapData.filter((r) => WATCHLIST.includes(r.name)); // 仅保留白名单板块
      console.log(`[mama] 计算完成，监控板块数=${heatmapData.length}`);
    } else console.log('[mama] 空结果，保留旧值');
  } else console.log('[mama] 今日无数据，保留旧 heatmapData');

  // 指数：腾讯实时（免 key、全球可达，GitHub 美国 runner 可直连；覆盖 上证/纳指100/恒生科技）
  // 初始化：上一次真实值 → 失败则 last-good 缓存（避免静默沿用任意旧 data.json）
  const indexData = prev.indexData || loadIndexCache() || {};
  let txIdxUsed = 0;
  try {
    const txIdx = await fetchTencentIndices(TODAY_YMD);
    for (const key of INDEX_KEYS) {
      if (!txIdx[key]) continue;
      const fresh = txIdx[key];
      const prevVal = indexData[key];
      // 美股(纳指100)/港股(恒生科技)在北京时间收盘 cron(11:35/15:30) 时本地处于休市，腾讯返回 current==preClose → change=0，属无效快照，保留上一次真实值
      const looksClosed = (key === 'ndx' || key === 'hstech') && fresh.change === 0 && fresh.pct === 0;
      if (looksClosed && prevVal && (prevVal.change !== 0 || prevVal.pct !== 0)) {
        console.log(`[idx ${key}] 腾讯返回 change=0（休市快照），保留上一次真实值 ${prevVal.change} (${prevVal.pct}%)`);
      } else {
        indexData[key] = fresh; txIdxUsed++;
        console.log(`[idx ${key}] 腾讯实时 ${fresh.price} (${fresh.pct}%)`);
      }
    }
    if (!txIdx.sse) throw new Error('腾讯未返回上证');
  } catch (e) {
    console.log(`[idx] 腾讯实时失败(${e.message})，上证回退新浪/Tushare`);
  }
  // 上证兜底：腾讯无数据时才回退新浪实时 / Tushare
  if (!indexData.sse) {
    try {
      const sinaIdx = await fetchSinaIndices();
      if (sinaIdx.sse) { indexData.sse = sinaIdx.sse; console.log(`[sse] 新浪实时 ${indexData.sse.price} (${indexData.sse.pct}%)`); }
    } catch (e) { console.log(`[sse] 新浪失败(${e.message})`); }
    if (!indexData.sse) {
      try {
        const bars = await fetchIndexSSE(beg, TODAY_YMD);
        const it = buildIndexItem({ name: '上证指数', code: '000001' }, bars);
        if (it) { indexData.sse = it; console.log(`[sse] Tushare ${it.price} (${it.pct}%)`); }
      } catch (e2) { console.log(`[sse] Tushare 也失败(${e2.message})，保留旧值`); }
    }
  }
  // 持久化指数 last-good（腾讯成功或回退新浪/Tushare 后都写，下次失败可兜底）
  saveIndexCache(indexData);

  // 估值表：腾讯实时 PE/PB（免费、海外可达）→ 板块市值加权 → 自采集历史百分位
  //   PE/PB 全自动；百分位=自采集历史内分位（冷启动不足时前端显示「样本累积中」）；恒生科技为指数、不可比，已移出估值表
  let valuationData = [];
  let txValUsed = false;
  try {
    if (!Object.keys(valMap).length) valMap = await getTencentValuationMap(sbMap); // 早期补充失败则重试
    if (Object.keys(valMap).length) {
      const { hist: vhist, today } = ensureValuationHistory(sbMap, valMap, TODAY_YMD);
      valuationData = computeValuationTable(vhist, today, customFile);
      if (valuationData.length) txValUsed = true;
    }
  } catch (e) { console.log(`[val] 自动化失败(${e.message})，估值表留空`); }
  if (!valuationData.length) {
    // 估值自动化完全失败：不回填静态基线伪装真实分位，输出空表（前端显示「暂无估值数据」）
    valuationData = [];
    console.log('[val] 自动化失败，估值表留空（不展示伪分位）');
  }

  const updatedAt = `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;

  // 数据源标记（非大陆 IP 时东财/股吧默认关闭，仅标注实际生效来源）
  const srcParts = ['tushare-free'];
  if (txRealtimeUsed) srcParts.push('tencent-realtime');
  else if (realtimeSrc) srcParts.push('sina-realtime');
  if (txIdxUsed > 0) srcParts.push('tencent-index');
  if (txValUsed) srcParts.push('tencent-valuation');
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

module.exports = { aggregate, computeMama, isLimitUp, limitPct, pctRank, std, avg, W, WSUM, writeArchive, getSinaTodaySec, getTencentTodaySec, fetchTencentIndices, parseTencentRealtime, tsCodeToSina, buildRealtimeSec, parseSinaRealtime, getTencentValuationMap, ensureValuationHistory, computeValuationTable, VAL_MAP, WATCHLIST };

if (require.main === module) main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
