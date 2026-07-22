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
      { name: '芯片',       ore: 105, dif: 92,  wov: 112, dbu: 35, zt: 60, hs: 80, dis: 85, total: 91, chg: +12 },
      { name: '半导体',     ore: 90,  dif: 92,  wov: 92,  dbu: 60, zt: 55, hs: 75, dis: 80, total: 88, chg: 0 },
      { name: '细分化工',   ore: 55,  dif: 60,  wov: 40,  dbu: 45, zt: 30, hs: 45, dis: 50, total: 50, chg: 0 },
      { name: '科创创业AI', ore: 88,  dif: 85,  wov: 88,  dbu: 55, zt: 65, hs: 78, dis: 82, total: 82, chg: +8 },
      { name: '机器人',     ore: 90,  dif: 113, wov: 10,  dbu: 53, zt: 60, hs: 70, dis: 78, total: 67, chg: +12 },
      { name: '新能源电池', ore: 65,  dif: 55,  wov: 50,  dbu: 40, zt: 35, hs: 55, dis: 55, total: 55, chg: -5 },
      { name: '恒生科技',   ore: 70,  dif: 75,  wov: 65,  dbu: 72, zt: 40, hs: 60, dis: 70, total: 70, chg: +15 },
      { name: '创新药',     ore: 50,  dif: 70,  wov: 45,  dbu: 55, zt: 30, hs: 50, dis: 55, total: 58, chg: +5 },
      { name: '锂矿',       ore: 60,  dif: 65,  wov: 55,  dbu: 48, zt: 35, hs: 55, dis: 55, total: 60, chg: -3 },
      { name: 'CPO',        ore: 65,  dif: 82,  wov: 77,  dbu: 52, zt: 55, hs: 75, dis: 75, total: 77, chg: +11 },
      { name: 'PCB',        ore: 80,  dif: 78,  wov: 70,  dbu: 60, zt: 50, hs: 70, dis: 72, total: 75, chg: +6 },
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
  };

  /* ============================================================
   * B. 取数：读 GitHub Action 生成的 data.json（同源）
   *    data.json 不存在 / 拉取失败 → 回退内置演示数据
   * ============================================================ */
  async function loadDashboardData() {
    const file = (CFG && CFG.dataFile) || 'data.json';
    try {
      const res = await fetch(file + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return { data, source: 'live' };
    } catch (e) {
      if (CFG && CFG.mockFallback) return { data: MOCK, source: 'mock' };
      throw e;
    }
  }

  /* ============================================================
   * B2. 回溯：读归档清单，渲染历史快照
   * ============================================================ */
  async function loadManifest() {
    try {
      const res = await fetch('archive/manifest.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return [];
      const m = await res.json();
      return Array.isArray(m) ? m : [];
    } catch (e) { return []; }
  }

  async function viewArchive(entry) {
    try {
      const res = await fetch(entry.file + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      renderAll(data);
      const lbl = `${entry.date} ${entry.sessionLabel}` + (entry.incomplete ? '（非交易日 / 暂无新数据）' : '');
      setStatus('正在查看回溯快照：' + lbl, false);
    } catch (e) {
      setStatus('回溯快照加载失败：' + e.message, true);
    }
  }

  function setupHistory() {
    const sel = document.getElementById('history-select');
    if (!sel) return;
    sel.addEventListener('change', async () => {
      const v = sel.value;
      if (v === 'latest') { await doRefresh(); return; }
      const entry = (sel._entries || []).find((e) => e.file === v);
      if (entry) await viewArchive(entry);
    });
    loadManifest().then((list) => {
      sel._entries = list;
      list.forEach((e) => {
        const opt = document.createElement('option');
        opt.value = e.file;
        opt.textContent = `${e.date} ${e.sessionLabel}` + (e.incomplete ? ' · 无数据' : '');
        sel.appendChild(opt);
      });
    });
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
    const headers = ['板块', '拥挤度', '扩散力', '动摇度', 'D回补', '涨停密度', '换手度', '讨论度', '总分'];
    const cols = ['name', 'ore', 'dif', 'wov', 'dbu', 'zt', 'hs', 'dis', 'total'];
    container.style.gridTemplateColumns = '88px repeat(8, 1fr)';
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
  }

  /* ============================================================
   * F. 刷新控制
   * ============================================================ */
  let lastRefreshDate = '';
  let refreshing = false;

  async function doRefresh() {
    if (refreshing) return;
    refreshing = true;
    const sel = document.getElementById('history-select');
    if (sel) sel.value = 'latest'; // 刷新即回到最新
    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
    setStatus('正在拉取数据…', false);
    try {
      const { data, source } = await loadDashboardData();
      renderAll(data);
      const now = new Date();
      lastRefreshDate = now.toISOString().slice(0, 10);
      const stamp = now.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const srcTxt = source === 'live' ? '数据来源：收盘快照（data.json）' : '数据来源：内置演示数据（data.json 未生成）';
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
    setupHistory(); // 装载回溯下拉
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
