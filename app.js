/* ============================================================
 * 宝妈指数看板 — 数据层 + 渲染 + 刷新控制
 * ============================================================ */
(function () {
  'use strict';

  const CFG = window.DASHBOARD_CONFIG || {};

  /* ============================================================
   * A. 内置演示数据（接口未配置 / 拉取失败时的兜底）
   *    真实接口接通后会用 transformApiResponse() 覆盖这些数据
   * ============================================================ */
  const MOCK = {
    indexData: {
      sse:    { name: '上证指数',   code: '000001', price: 3244.38, change: +1.52,  pct: +0.05 },
      ndx:    { name: '纳斯达克100', code: 'NDX',   price: 20841.50, change: -125.30, pct: -0.60 },
      hstech: { name: '恒生科技',   code: 'HSTECH', price: 4231.67, change: +87.44, pct: +2.11 },
    },
    heatmapData: [
      { name: '芯片',       ore: 105, dif: 92,  wov: 112, dbu: 35, cro: 90, total: 91, chg: +12 },
      { name: '半导体',     ore: 90,  dif: 92,  wov: 92,  dbu: 60, cro: 90, total: 88, chg: 0 },
      { name: '细分化工',   ore: 55,  dif: 60,  wov: 40,  dbu: 45, cro: 35, total: 50, chg: 0 },
      { name: '科创创业AI', ore: 88,  dif: 85,  wov: 88,  dbu: 55, cro: 80, total: 82, chg: +8 },
      { name: '机器人',     ore: 90,  dif: 113, wov: 10,  dbu: 53, cro: 44, total: 67, chg: +12 },
      { name: '新能源电池', ore: 65,  dif: 55,  wov: 50,  dbu: 40, cro: 50, total: 55, chg: -5 },
      { name: '恒生科技',   ore: 70,  dif: 75,  wov: 65,  dbu: 72, cro: 65, total: 70, chg: +15 },
      { name: '创新药',     ore: 50,  dif: 70,  wov: 45,  dbu: 55, cro: 40, total: 58, chg: +5 },
      { name: '锂矿',       ore: 60,  dif: 65,  wov: 55,  dbu: 48, cro: 55, total: 60, chg: -3 },
      { name: 'CPO',        ore: 65,  dif: 82,  wov: 77,  dbu: 52, cro: 85, total: 77, chg: +11 },
      { name: 'PCB',        ore: 80,  dif: 78,  wov: 70,  dbu: 60, cro: 75, total: 75, chg: +6 },
    ],
    valuationData: [
      { name: '半导体设备',  pe: 166.96, pePct: 96.36, pbPct: 99.36, peChg: -7.5 },
      { name: '存储器/芯片', pe: 141.01, pePct: 95.48, pbPct: 99.48, peChg: -6.8 },
      { name: '半导体产业',  pe: 124.23, pePct: 94.56, pbPct: 97.54, peChg: -7.2 },
      { name: '光模块CPO',   pe: 71.92,  pePct: 86.58, pbPct: 99.32, peChg: -9.6 },
      { name: '机器人概念',  pe: 58.40,  pePct: 72.30, pbPct: 78.50, peChg: +2.1 },
      { name: '恒生科技',    pe: 32.50,  pePct: 45.20, pbPct: 55.80, peChg: -3.4 },
      { name: '创新药',      pe: 38.70,  pePct: 38.50, pbPct: 42.10, peChg: +1.2 },
      { name: '新能源电池',  pe: 28.90,  pePct: 35.60, pbPct: 48.20, peChg: -1.8 },
    ],
    navHistory: [
      { date: '2026-02-11', nav: 1.15 }, { date: '2026-02-28', nav: 1.25 },
      { date: '2026-03-15', nav: 1.18 }, { date: '2026-03-31', nav: 1.12 },
      { date: '2026-04-15', nav: 1.30 }, { date: '2026-04-30', nav: 1.45 },
      { date: '2026-05-15', nav: 1.62 }, { date: '2026-05-31', nav: 1.88 },
      { date: '2026-06-10', nav: 2.20 }, { date: '2026-06-20', nav: 2.80 },
      { date: '2026-06-25', nav: 3.10 }, { date: '2026-06-30', nav: 3.3724 },
      { date: '2026-07-01', nav: 3.29 }, { date: '2026-07-02', nav: 3.01 },
      { date: '2026-07-03', nav: 2.98 }, { date: '2026-07-07', nav: 2.50 },
      { date: '2026-07-08', nav: 2.20 }, { date: '2026-07-09', nav: 1.62 },
      { date: '2026-07-10', nav: 1.51 }, { date: '2026-07-13', nav: 1.45 },
      { date: '2026-07-14', nav: 1.48 }, { date: '2026-07-15', nav: 1.40 },
      { date: '2026-07-16', nav: 1.32 }, { date: '2026-07-19', nav: 1.28 },
    ],
    sectorBreakdown: [
      { label: 'AI芯片',        value: 17.43, color: '#f85149' },
      { label: '半导体设备',    value: 19.90, color: '#d29922' },
      { label: '晶圆制造',      value: 8.50,  color: '#a371f7' },
      { label: '存储芯片',      value: 15.29, color: '#3fb950' },
      { label: '图像传感器',    value: 4.20,  color: '#58a6ff' },
      { label: '芯片IP/Chiplet',value: 3.55,  color: '#79c0ff' },
      { label: '其他',          value: 31.13, color: '#484f58' },
    ],
  };

  /* ============================================================
   * B. API 适配层（拿到接口绑定方式后，主要改这里）
   * ------------------------------------------------------------
   * raw = 接口返回的原始 JSON（结构取决于你的接口）。
   * 下面函数负责把它映射成页面内部统一模型。
   * 只要返回的对象包含 indexData / heatmapData / valuationData /
   * navHistory / sectorBreakdown 五个字段即可，缺哪个页面就留空。
   * ============================================================ */
  function transformApiResponse(raw) {
    // TODO(接接口): 按真实 JSON 结构改写映射，例如：
    // return {
    //   indexData: {
    //     sse:    { name: '上证指数', code: raw.sse.code, price: raw.sse.price, change: raw.sse.change, pct: raw.sse.pct },
    //     ndx:    { ... },
    //     hstech: { ... },
    //   },
    //   heatmapData:    raw.heatmap.map(x => ({ name: x.name, ore: x.ore, ... })),
    //   valuationData:  raw.valuation,
    //   navHistory:     raw.nav,
    //   sectorBreakdown:raw.sectors,
    // };
    return raw; // 占位：若接口已直接返回标准结构，可保持原样
  }

  /* ============================================================
   * C. 取数
   * ============================================================ */
  const isApiConfigured = () =>
    CFG.API && CFG.API.baseUrl && !CFG.API.baseUrl.includes('YOUR-API-HOST');

  async function fetchJson(url, headers, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
    try {
      const res = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function loadDashboardData() {
    if (!isApiConfigured()) {
      if (CFG.mockFallback) return { data: MOCK, source: 'mock' };
      throw new Error('API 未配置且未开启 mock 兜底');
    }

    const { baseUrl, headers, combinedEndpoint, endpoints, timeoutMs } = CFG.API;
    const h = headers || {};

    // 单一聚合接口
    if (combinedEndpoint) {
      const raw = await fetchJson(baseUrl.replace(/\/$/, '') + combinedEndpoint, h, timeoutMs);
      return { data: transformApiResponse(raw), source: 'api' };
    }

    // 分接口并发拉取
    const [indexR, heatR, valR, navR, secR] = await Promise.allSettled([
      fetchJson(baseUrl.replace(/\/$/, '') + endpoints.index, h, timeoutMs),
      fetchJson(baseUrl.replace(/\/$/, '') + endpoints.heatmap, h, timeoutMs),
      fetchJson(baseUrl.replace(/\/$/, '') + endpoints.valuation, h, timeoutMs),
      fetchJson(baseUrl.replace(/\/$/, '') + endpoints.nav, h, timeoutMs),
      fetchJson(baseUrl.replace(/\/$/, '') + endpoints.sectors, h, timeoutMs),
    ]);

    const pick = (r, fallback) => (r.status === 'fulfilled' ? r.value : fallback);
    const raw = {
      indexData: pick(indexR),
      heatmapData: pick(heatR),
      valuationData: pick(valR),
      navHistory: pick(navR),
      sectorBreakdown: pick(secR),
    };
    return { data: transformApiResponse(raw), source: 'api' };
  }

  /* ============================================================
   * D. 配色
   * ============================================================ */
  const COLORS = { red: '#da3633', yel: '#d29922', green: '#238636', blue: '#1f6feb', purple: '#a371f7' };
  const heatColor = (v) => (v > 100 ? COLORS.red : v >= 80 ? COLORS.yel : COLORS.green);
  const pctColor = (v) => (v >= 95 ? COLORS.red : v >= 80 ? COLORS.yel : COLORS.green);

  /* ============================================================
   * E. 渲染
   * ============================================================ */
  let charts = {};
  function destroyCharts() {
    Object.values(charts).forEach((c) => { try { c.destroy(); } catch (e) {} });
    charts = {};
  }
  function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function renderIndexCards(d) {
    const map = [
      ['sse', 'idx-sse'], ['ndx', 'idx-ndx'], ['hstech', 'idx-hstech'],
    ];
    map.forEach(([key, pre]) => {
      const it = d[key]; if (!it) return;
      const up = it.change >= 0;
      document.getElementById(pre + '-price').textContent =
        Number(it.price).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      document.getElementById(pre + '-change').innerHTML =
        `<span class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(it.change).toFixed(2)} (${up ? '+' : ''}${it.pct.toFixed(2)}%)</span>`;
    });
  }

  function renderHeatmap(d) {
    const container = document.getElementById('heatmap-container');
    clearEl(container);
    const headers = ['板块', 'ORE<br>拥挤度', '扩散力', '动摇度', 'D回补', '有拥挤度', '总分'];
    const cols = ['name', 'ore', 'dif', 'wov', 'dbu', 'cro', 'total'];
    container.style.gridTemplateColumns = '100px repeat(6, 1fr)';
    headers.forEach((htext) => {
      const th = document.createElement('div');
      th.className = 'heatmap-header';
      th.innerHTML = htext;
      container.appendChild(th);
    });
    (d || []).forEach((row) => {
      cols.forEach((col, ci) => {
        const div = document.createElement('div');
        if (ci === 0) {
          div.className = 'heatmap-sector';
          div.textContent = row.name;
        } else {
          const v = row[col];
          if (col === 'total') {
            div.className = 'heatmap-total';
            div.style.background = heatColor(v);
            div.innerHTML = `${v}<span class="chg">${row.chg > 0 ? ` ↑${row.chg}` : row.chg < 0 ? ` ↓${Math.abs(row.chg)}` : ''}</span>`;
          } else {
            div.className = 'heatmap-cell';
            div.style.background = heatColor(v);
            div.style.color = v > 80 ? '#fff' : '#0d1117';
            div.textContent = v;
          }
        }
        container.appendChild(div);
      });
    });
  }

  function renderValuationTable(d) {
    const tbody = document.querySelector('#valuation-table tbody');
    clearEl(tbody);
    (d || []).forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row.name}</td>
        <td>${Number(row.pe).toFixed(1)}</td>
        <td style="color:${pctColor(row.pePct)};font-weight:700">${Number(row.pePct).toFixed(1)}%</td>
        <td style="color:${pctColor(row.pbPct)};font-weight:700">${Number(row.pbPct).toFixed(1)}%</td>
        <td style="color:${row.peChg < 0 ? COLORS.green : COLORS.red}">${row.peChg > 0 ? '+' : ''}${Number(row.peChg).toFixed(1)}%</td>`;
      tbody.appendChild(tr);
    });
  }

  function renderBarChart(d) {
    const sorted = [...(d || [])].sort((a, b) => b.total - a.total);
    charts.bar = new Chart(document.getElementById('barChart'), {
      type: 'bar',
      data: {
        labels: sorted.map((x) => x.name),
        datasets: [{
          label: '宝妈指数总分',
          data: sorted.map((x) => x.total),
          backgroundColor: sorted.map((x) => (x.total >= 90 ? COLORS.red : x.total >= 70 ? COLORS.yel : COLORS.green)),
          borderRadius: 6, borderSkipped: false,
        }],
      },
      options: {
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { afterLabel: (ctx) => { const r = sorted[ctx.dataIndex]; return `环比: ${r.chg > 0 ? '+' : ''}${r.chg}`; } } },
        },
        scales: {
          x: { max: 120, grid: { color: '#21262d' }, ticks: { stepSize: 20 } },
          y: { grid: { display: false }, ticks: { font: { size: 12 } } },
        },
      },
    });
  }

  function renderNavChart(d) {
    charts.nav = new Chart(document.getElementById('navChart'), {
      type: 'line',
      data: {
        labels: (d || []).map((x) => x.date),
        datasets: [{
          label: '159995 净值',
          data: (d || []).map((x) => x.nav),
          borderColor: COLORS.blue,
          backgroundColor: 'rgba(31,111,235,0.08)',
          borderWidth: 2, fill: true, tension: 0.4, pointRadius: 3,
          pointBackgroundColor: (d || []).map((x) => (x.nav >= 3.0 ? COLORS.red : x.nav >= 2.0 ? COLORS.yel : COLORS.blue)),
          pointBorderColor: 'transparent',
        }],
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `净值: ${ctx.parsed.y.toFixed(4)}` } },
        },
        scales: {
          x: { grid: { color: '#21262d' }, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
          y: { grid: { color: '#21262d' }, ticks: { font: { size: 10 } } },
        },
      },
    });
  }

  function renderPieChart(d) {
    charts.pie = new Chart(document.getElementById('pieChart'), {
      type: 'doughnut',
      data: {
        labels: (d || []).map((x) => x.label),
        datasets: [{ data: (d || []).map((x) => x.value), backgroundColor: (d || []).map((x) => x.color), borderWidth: 2, borderColor: '#0d1117' }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              font: { size: 11 }, padding: 10, color: '#e6edf3',
              generateLabels: (chart) => {
                const data = chart.data;
                return data.labels.map((label, i) => ({
                  text: `${label}  ${Number(data.datasets[0].data[i]).toFixed(1)}%`,
                  fillStyle: data.datasets[0].backgroundColor[i], hidden: false, index: i,
                }));
              },
            },
          },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${Number(ctx.parsed).toFixed(2)}%` } },
        },
        cutout: '50%',
      },
    });
  }

  function setStatus(text, isError) {
    const el = document.getElementById('update-time');
    if (el) el.innerHTML = text;
    const dot = document.getElementById('status-dot');
    if (dot) dot.style.background = isError ? COLORS.red : COLORS.green;
  }

  function renderAll(data) {
    destroyCharts();
    renderIndexCards(data.indexData);
    renderHeatmap(data.heatmapData);
    renderValuationTable(data.valuationData);
    renderBarChart(data.heatmapData);
    renderNavChart(data.navHistory);
    renderPieChart(data.sectorBreakdown);
  }

  /* ============================================================
   * F. 刷新控制
   * ============================================================ */
  let lastRefreshDate = '';
  let refreshing = false;

  async function doRefresh() {
    if (refreshing) return;
    refreshing = true;
    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
    setStatus('正在拉取数据…', false);
    try {
      const { data, source } = await loadDashboardData();
      renderAll(data);
      const now = new Date();
      lastRefreshDate = now.toISOString().slice(0, 10);
      const stamp = now.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const srcTxt = source === 'api' ? '数据来源：API 实时' : '数据来源：内置演示数据（API 未配置）';
      setStatus(`数据更新时间：${stamp} &nbsp;|&nbsp; ${srcTxt}`, false);
    } catch (err) {
      setStatus('数据拉取失败：' + err.message + '（已保留上次数据）', true);
    } finally {
      refreshing = false;
      if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
    }
  }

  function checkAutoAfterClose() {
    if (!CFG.refresh || !CFG.refresh.autoAfterClose) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() >= (CFG.refresh.closeHour || 15) && lastRefreshDate !== today) {
      doRefresh();
    }
  }

  function init() {
    // Chart.js 全局样式
    if (window.Chart) {
      Chart.defaults.color = '#8b949e';
      Chart.defaults.font.family = "-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
      Chart.defaults.plugins.tooltip.backgroundColor = '#1c2128';
      Chart.defaults.plugins.tooltip.borderColor = '#30363d';
      Chart.defaults.plugins.tooltip.borderWidth = 1;
    }
    if (CFG.refresh && CFG.refresh.manualButton) {
      const btn = document.getElementById('refresh-btn');
      if (btn) btn.addEventListener('click', doRefresh);
    }
    doRefresh(); // 首次加载
    // 每分钟检查一次是否需要"收盘后自动刷新"
    setInterval(checkAutoAfterClose, 60 * 1000);
    // 可选：持续轮询
    const poll = (CFG.refresh && CFG.refresh.pollIntervalMs) || 0;
    if (poll > 0) setInterval(doRefresh, poll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
