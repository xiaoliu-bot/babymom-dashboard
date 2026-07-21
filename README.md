# 宝妈指数看板 · 大盘数据监控（在线版）

基于原 `babymom-dashboard.html` 改造的可上线版本。

## 架构
```
GitHub Action（每日 15:30 收盘后自动跑）
   │  ① 东方财富K线接口拉 三大指数 + 芯片ETF（免费、无需token、含海外指数）
   │  ② 合并 custom-data.json（热力图/估值/持仓 = 自定义分析数据）
   └─▶ 生成 data.json 提交回仓库
静态页面（GitHub Pages）─▶ 读取 data.json 渲染（同源、无跨域、无token泄露）
```
- **三大指数/ETF**：东财免费接口（`push2his`），实测可取 上证`1.000001`、纳斯达克100`100.NDX`、恒生科技`124.HSTECH`、芯片ETF`0.159995`。
- **热力图/估值/持仓**：Tushare 与东财均无此自定义数据，由 `custom-data.json` 维护（手动改或接你自己的接口）。
- **Tushare**：免费档取这些指数反而不如东财（取不到纳指/恒生科技、有频率限制），故本工程暂未使用；留作以后做个股财务/估值时再用。
- **无需任何密钥**即可部署：东财接口公开，token 不进仓库。

## 目录结构
```
index.html            页面结构+样式（深色专业风），顶部「刷新」按钮+状态灯
config.js             页面配置（数据文件路径、刷新策略）
app.js                读 data.json → 渲染 + 刷新控制（无 data.json 时回退演示数据）
custom-data.json      ★ 自定义分析数据（热力图/估值/持仓），改这里下次 Action 生效
scripts/fetch_data.js GitHub Action 取数脚本（东财K线 + 合并自定义数据 → data.json）
.github/workflows/refresh.yml  每日 15:30 自动刷新 + 支持手动触发
.nojekyll             GitHub Pages 跳过 Jekyll
```

## 一、部署到 GitHub Pages
1. 推送到 GitHub 仓库（见下"推送"）。
2. 仓库 → Settings → Pages → Source: Deploy from a branch → Branch `main` / `(root)`。
3. 约 1 分钟后访问 `https://<用户名>.github.io/<仓库名>/`。
4. 首次手动触发一次 Action（仓库 → Actions → 刷新看板数据 → Run workflow），生成 `data.json`。

## 二、推送
```bash
git init && git add . && git commit -m "宝妈指数看板 v3.0 在线版"
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```
（也可用 GitHub CLI：`gh repo create <仓库名> --public --source=. --push`）

## 三、更新自定义数据（热力图/估值/持仓）
直接编辑 `custom-data.json` 并推送 → 下次 Action 运行后合并进 `data.json`。
若你有自己的接口能输出这些数据，可改造 `scripts/fetch_data.js` 让 Action 自动拉取覆盖。

## 四、本地预览
```bash
python -m http.server 8000   # 然后访问 http://localhost:8000
```
本地无 `data.json` 时自动用内置演示数据渲染。
