const { aggregate, computeMama } = require('./scripts/fetch_data.js');

// ── 构造假数据（仿 Tushare daily / stock_basic 形状）──
const IND = ['半导体', '银行', '白酒', '医药', '新能源', '房地产'];
const mood = {
  半导体: { pct: 5.2, vol: 90000, amt: 120000 }, // 热
  银行:   { pct: 0.3, vol: 12000, amt: 30000 },  // 冷
  白酒:   { pct: 1.8, vol: 20000, amt: 45000 },
  医药:   { pct: -0.5, vol: 18000, amt: 40000 },
  新能源: { pct: 2.4, vol: 35000, amt: 60000 },
  房地产: { pct: -2.1, vol: 15000, amt: 25000 }, // 弱
};
const sbMap = {};
const todayRows = [];
for (const ind of IND) {
  for (let i = 0; i < 12; i++) {
    const code = `${ind}${i}.SZ`;
    sbMap[code] = { name: ind + i, industry: ind, float_share: 50000, exchange: 'SZ', list_status: 'L' };
    const m = mood[ind];
    // 个股在板块情绪上叠加微小扰动
    const jitter = (Math.random() - 0.5) * 1.5;
    const pct = +(m.pct + jitter).toFixed(2);
    todayRows.push({ ts_code: code, pct_chg: pct, vol: m.vol + Math.round(Math.random() * 5000), amount: m.amt + Math.round(Math.random() * 5000) });
  }
}

const todaySec = aggregate(todayRows, sbMap);

// 构造 20 天历史（ret 小数 / amt），半导体波动大、银行平稳
const historyDays = [];
for (let d = 20; d >= 1; d--) {
  const date = `202607${String(d).padStart(2, '0')}`;
  const ret = {}, amt = {};
  for (const ind of IND) {
    const base = mood[ind].pct / 100;
    const vol = ind === '半导体' ? 0.04 : ind === '银行' ? 0.008 : 0.02;
    ret[ind] = +(base + (Math.random() - 0.5) * 2 * vol).toFixed(5);
    amt[ind] = mood[ind].amt + Math.round((Math.random() - 0.5) * 10000);
  }
  historyDays.push({ date, ret, amt });
}

const out = computeMama(todaySec, historyDays, null, '20260721');
console.log('板块数:', out.length);
console.log('name\tore\tdif\twov\tdbu\tzt\ths\tdis\ttotal');
out.forEach((r) => console.log(
  `${r.name}\t${r.ore}\t${r.dif}\t${r.wov}\t${r.dbu}\t${r.zt}\t${r.hs}\t${r.dis}\t${r.total}`
));

// 断言
const byName = Object.fromEntries(out.map((r) => [r.name, r]));
const ok =
  byName.半导体.total > byName.银行.total &&
  byName.半导体.total > byName.房地产.total &&
  byName.房地产.dif < 50 && // 房地产下跌家数多 → 扩散力分位低
  out.every((r) => [r.ore, r.dif, r.wov, r.dbu, r.zt, r.hs, r.dis, r.total].every((v) => v >= 0 && v <= 100));
console.log('\n断言通过:', ok);
process.exit(ok ? 0 : 1);
