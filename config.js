/* ============================================================
 * 宝妈指数看板 — 数据源配置
 * ------------------------------------------------------------
 * 这里是唯一需要你（或我，拿到绑定方式后）改动的文件。
 * 把下面占位符替换成真实接口即可，页面其余部分不用动。
 * ============================================================ */

window.DASHBOARD_CONFIG = {
  /* ---------- 1. 数据源 API ---------- */
  API: {
    // 接口域名，例如 https://api.example.com
    // 保持占位符时，页面会自动使用内置演示数据（mockFallback）
    baseUrl: 'https://YOUR-API-HOST',

    // 鉴权方式（按你接口的要求填）：
    //   方式A：Bearer Token  → { 'Authorization': 'Bearer ' + token }
    //   方式B：自定义 Header   → { 'X-API-Key': '你的key' }
    //   方式C：无需鉴权        → {}
    headers: {
      // 'Authorization': 'Bearer YOUR_TOKEN',
    },

    // 接口路径（与 baseUrl 拼接）。
    // 两种用法二选一：
    //   (a) 单一聚合接口：把所有看板数据一次性返回，填 combinedEndpoint，其余留空
    //   (b) 分接口：分别填下面 5 个 endpoint
    combinedEndpoint: '',          // 例：'/api/dashboard'
    endpoints: {
      index:     '/api/index',     // 三大指数
      heatmap:   '/api/heatmap',   // 拥挤度热力图
      valuation: '/api/valuation', // 板块估值
      nav:       '/api/nav',       // ETF净值走势
      sectors:   '/api/sectors',   // 持仓细分
    },

    // 请求超时（毫秒）
    timeoutMs: 10000,
  },

  /* ---------- 2. 刷新策略 ---------- */
  refresh: {
    manualButton: true,     // 顶部手动刷新按钮（建议保持 true）
    autoAfterClose: true,   // 每日 15:00 收盘后自动拉取一次
    closeHour: 15,          // 收盘小时（24h制，A股 15 点）
    pollIntervalMs: 0,      // 0 = 不轮询；需要盯盘实时刷新可设 30000(30s)/60000(1m)/300000(5m)
  },

  /* ---------- 3. 兜底 ---------- */
  mockFallback: true,   // 接口未配置 / 拉取失败时，使用内置演示数据，保证页面始终能渲染
};
