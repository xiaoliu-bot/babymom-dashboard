# 宝妈指数看板 · 大盘数据监控（在线版）

基于原 `babymom-dashboard.html` 改造的可上线版本。数据改为**从 API 拉取**（未配置时回退内置演示数据），支持手动刷新 + 每日 15:00 收盘后自动刷新。

## 目录结构
```
index.html    页面结构 + 样式（深色专业风）
config.js     ★ 数据源配置（接口地址 / 鉴权 / 刷新策略）—— 接接口只改这里
app.js        数据层 + API适配 + 渲染 + 刷新控制（一般不用动）
.nojekyll     GitHub Pages 跳过 Jekyll 处理
```

## 一、接入你的数据源
打开 `config.js`：
1. `API.baseUrl` 改成你的接口域名（保留 `YOUR-API-HOST` 占位符时自动用演示数据）。
2. `API.headers` 填鉴权（Bearer Token 或自定义 Header）。
3. 二选一填接口路径：
   - 单一聚合接口 → 填 `combinedEndpoint`（一次性返回全部看板数据）；
   - 分接口 → 填 `endpoints` 下 5 个路径。
4. 字段映射：返回 JSON 结构与页面内部模型不一致时，改 `app.js` 里的 `transformApiResponse()`。

内部模型字段：`indexData`（sse/ndx/hstech，每项含 price/change/pct）、`heatmapData`（name/ore/dif/wov/dbu/cro/total/chg）、`valuationData`（name/pe/pePct/pbPct/peChg）、`navHistory`（date/nav）、`sectorBreakdown`（label/value/color）。

## 二、部署到 GitHub Pages
1. 把本目录推送到 GitHub 仓库（见下方"推送命令"）。
2. 仓库 → Settings → Pages → Source 选 **Deploy from a branch** → Branch 选 `main` / `master`，目录 `/ (root)`。
3. 等待约 1 分钟，访问 `https://<用户名>.github.io/<仓库名>/`。

> 纯静态站点，无构建步骤。Chart.js 走 CDN，需公网可访问。

## 三、本地预览
直接双击 `index.html` 即可（或 `python -m http.server` 后访问 `localhost:8000`）。

## 四、推送命令（本机无 gh 时，用 git 直接推）
```bash
git init
git add .
git commit -m "宝妈指数看板 v3.0 在线版"
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```
若已安装 GitHub CLI，也可：`gh repo create <仓库名> --public --source=. --push`。
