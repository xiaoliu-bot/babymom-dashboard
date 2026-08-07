// 估值自动化验证（不跑全量 main，避免重击 Tushare）
const fd = require('./fetch_data.js');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, 'cache');

function ymd(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; }
function check(name, cond, extra) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); if (!cond) process.exitCode = 1; }

(async () => {
  // ── 1) parseTencentRealtime 解析 pe/pb（A股）──
  const f = new Array(50).fill('0');
  f[1] = '贵州茅台'; f[3] = '1497.94'; f[4] = '1490.00'; f[5] = '1495.00';
  f[33] = '1500'; f[34] = '1480'; f[36] = '1234'; f[37] = '737346'; f[39] = '20.41'; f[46] = '7.25';
  const lineA = `v_sh600519="${f.join('~')}";`;
  const mA = fd.parseTencentRealtime('var hq_str_' + lineA);
  check('A股 pe 解析', mA.sh600519 && mA.sh600519.pe === 20.41, mA.sh600519 && { pe: mA.sh600519.pe, pb: mA.sh600519.pb });
  check('A股 pb 解析', mA.sh600519 && mA.sh600519.pb === 7.25);

  // 美股不应解析 pe/pb（字段布局不同）
  const fu = new Array(50).fill('0');
  fu[1] = 'Apple Inc.'; fu[3] = '200.72'; fu[4] = '199'; fu[5] = '200'; fu[33] = '201'; fu[34] = '198'; fu[36] = '1'; fu[37] = '1'; fu[39] = '48941'; fu[46] = 'Apple Inc.';
  const lineU = `v_usAAPL="${fu.join('~')}";`;
  const mU = fd.parseTencentRealtime('var hq_str_' + lineU);
  check('美股 pe 跳过(应为null)', mU.usAAPL && mU.usAAPL.pe === null, mU.usAAPL && { pe: mU.usAAPL.pe, pb: mU.usAAPL.pb });

  // ── 2) 真实拉取估值 map ──
  const sbCache = JSON.parse(fs.readFileSync(path.join(CACHE, 'stock_basic.json'), 'utf8'));
  const sbMap = sbCache.map;
  console.log('sbMap 规模', Object.keys(sbMap).length);
  const valMap = await fd.getTencentValuationMap(sbMap);
  const keys = Object.keys(valMap);
  check('估值 map 非空', keys.length > 0, { n: keys.length });
  // 检查无 NaN
  let nan = 0;
  keys.forEach((k) => { const v = valMap[k]; if ((v.pe != null && isNaN(v.pe)) || (v.pb != null && isNaN(v.pb))) nan++; });
  check('估值 map 无 NaN', nan === 0, { nan });
  const sample = keys.slice(0, 6).map((k) => ({ ts: k, pe: valMap[k].pe, pb: valMap[k].pb }));
  console.log('估值样例', sample);

  // 诊断：前 20 个 valMap 的 sb / float_share / price / cap
  console.log('--- 诊断 ensureValuationHistory ---');
  keys.slice(0, 20).forEach((ts) => {
    const sb = sbMap[ts];
    const v = valMap[ts];
    const cap = (v.price || 0) * (Number(sb ? sb.float_share : 0) || 0);
    console.log(ts, 'sb?', !!sb, 'float=', sb && sb.float_share, 'price=', v.price, 'pe=', v.pe, 'cap=', cap);
  });

  // ── 3) ensureValuationHistory（真实今日）→ today 各板块 PE/PB ──
  const todayYmd = ymd(new Date());
  const { hist, today } = fd.ensureValuationHistory(sbMap, valMap, todayYmd);
  const secs = Object.keys(today.pe);
  check('今日有板块 PE/PB', secs.length > 0, { sectors: secs });
  console.log('今日板块估值:', secs.map((s) => ({ s, pe: today.pe[s], pb: today.pb[s] })));

  // ── 4) 冷启动：历史不足 → 用基线种子百分位（非50默认除外）──
  const baseline = [{ name: '半导体', pePct: 94, pbPct: 97 }, { name: '恒生科技', pe: 32.5, pePct: 45, pbPct: 55 }];
  const cold = fd.computeValuationTable({ days: [] }, today, { valuationData: [] }, baseline);
  const semiCold = cold.find((r) => r.name === '半导体');
  check('冷启动 半导体 pePct=基线94', semiCold && semiCold.pePct === 94, semiCold);
  check('冷启动含恒生科技行', cold.some((r) => r.name === '恒生科技'));

  // ── 5) 历史足够 → 计算百分位（非基线）──
  const synthetic = { days: [] };
  for (let i = 0; i < 15; i++) {
    const pe = {}, pb = {};
    secs.forEach((s) => { pe[s] = (today.pe[s] || 30) * (0.85 + 0.02 * i); pb[s] = (today.pb[s] || 5) * (0.85 + 0.02 * i); });
    synthetic.days.push({ date: '20260' + (i < 9 ? '0' + (i + 1) : i + 1) + '01', pe, pb });
  }
  const warm = fd.computeValuationTable(synthetic, today, { valuationData: [] }, baseline);
  const w = warm.find((r) => r.name === secs[0]);
  console.log('计算百分位样例', w);
  // 今日值 ≈ 区间高端（我们构造的序列递增到 today 附近），pct 应偏高且不恒等于基线
  check('计算百分位 非基线固定值', w && w.pePct !== 94 && w.pePct > 0 && w.pePct <= 100, w && { pePct: w.pePct });

  // ── 6) 自定义覆盖 ──
  const withOverride = fd.computeValuationTable(synthetic, today, { valuationData: [{ name: '半导体设备', pe: 999, pePct: 1, pbPct: 1, peChg: -99 }] }, baseline);
  const ov = withOverride.find((r) => r.name === '半导体');
  check('自定义覆盖生效(pe=999)', ov && ov.pe === 999, ov);

  console.log('\n完成。退出码', process.exitCode || 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
