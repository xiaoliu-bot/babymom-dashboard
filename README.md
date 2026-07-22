# 宝妈指数看板 · 大盘数据监控（在线版）

基于原 `babymom-dashboard.html` 改造的可上线版本。每日收盘后自动计算「宝妈指数」（情绪化散户活跃度），推送到 GitHub Pages 展示。

## 数据源策略（Tushare 免费档为主 + 东财备份）

> 关键结论：**GitHub Actions 美国 runner 现在就能跑通**（无需大陆 IP、无需注册新 API）。

| 角色 | 数据源 | 说明 | 是否需要大陆 IP |
|---|---|---|---|
| **主力** | **Tushare 免费档** | `stock_basic`(行业篮子) + `daily`(全市场批量) + `index_daily`(上证) → 自聚合成板块，算出**全部宝妈指数维度** | ❌ 不需要（从海外/GitHub 直连） |
| 备份增强 | 东方财富 | 纳斯达克100 / 恒生科技 日线 + 股吧人气榜（增强「讨论度」） | ✅ 仅大陆 IP 可取（海外被墙） |

- 宝妈指数的 **6 个维度全部由 Tushare 免费档实时算出**，GitHub 全自动。
- 东财只在「大陆网络」下生效：补充纳指/恒生 这两块 Tushare 免费档拿不到的行情，并用股吧人气榜增强讨论度。GitHub 跑不到东财时，**自动保留上一次真实值**，讨论度回退为「行为代理」（换手+涨停密度）。
- 任何一部分失败都**保留上一次真实数据**，绝不用静态基线覆盖。

### 在 GitHub Actions 自动跑（推荐，无需大陆 IP）
仓库已配 `.github/workflows/refresh.yml`：每天北京时间 15:30（收盘后）触发，跑 `node scripts/fetch_data.js` 生成 `data.json` 并提交。`TUSHARE_TOKEN` 已内置兜底（可直接跑）；如仓库为公开仓，建议到 Settings → Secrets 添加 `TUSHARE_TOKEN` 并将脚本里的兜底常量移除/轮换，避免 token 泄露。

### 在你自己的电脑上跑（可选，能拿到东财增强）
大陆网络下东财畅通，可额外刷新纳指/恒生/ETF + 股吧讨论度：
```bash
# Windows：双击 fetch-data.bat
# Mac/Linux：bash fetch-data.sh
```
脚本会 `node scripts/fetch_data.js` 拉数 → 计算 → `git commit & push`。可加系统定时任务无人值守（每日 15:35）。

### GitHub 自托管 Runner（可选）
若想让东财增强也全自动：Settings → Actions → Runners 安装自托管 runner，把 `refresh.yml` 的 `runs-on: ubuntu-latest` 改为 `runs-on: self-hosted`，定时任务即在你大陆机器上跑。

## 宝妈指数（情绪化散户活跃度）计算方法
对每个**行业板块**（由 Tushare `stock_basic` 的 `industry` 字段聚合，成分股 ≥ 8 只）算 6 个原始维度 → **跨板块分位排名（0–100）** → 加权合成总分：

| 维度 | 含义 | 计算（来自 Tushare） |
|---|---|---|
| 拥挤度 | 板块成交额相对自身历史均值的异动（钱往一处挤） | `daily` 全市场 `amount` 按行业汇总，÷ 回看窗口均值 |
| 扩散力 | 板块内上涨家数占比（普涨/情绪一致） | `daily` 的 `pct_chg>0` 家数占比 |
| 动摇度 | 板块等权日收益近窗年化波动率（上蹿下跳） | 行业等权日收益序列 std ×√252 |
| D回补 | 从近期低点回补的强度（一跌就有人抄） | 行业指数（累乘日收益）相对区间最低点涨幅 |
| 涨停密度 | 板块内涨停个股占比（散户追板） | `pct_chg` 超涨跌停阈值（主板10%/创业板·科创板20%/北交所30%）占比 |
| 换手度 | 板块自由流通换手率（频繁倒手=散户特征） | Σ(`vol`×100) ÷ Σ(`float_share`×10000) |

**讨论度**（单列，不参与总分）= 行为代理（0.5×换手 + 0.5×涨停密度）为主；大陆 IP 下若东财股吧人气榜可取，则叠加人气排名增强（0.6×行为 + 0.4×股吧）。
**总分权重**：拥挤 0.25 / 扩散 0.15 / 动摇 0.15 / D回补 0.10 / 换手 0.15 / 涨停 0.10。
**读分**：<40 冷静（机构主导）、40–70 温和、>70 过热（宝妈扎堆，回撤风险高）。

> 代理变量说明：真实的"散户 vs 机构"资金拆分无法免费获取，以上用换手率、涨停密度、成交额异动等**最贴近情绪化交易行为**的市场信号逼近。

## 目录结构
```
index.html            页面（深色专业风），顶部「刷新」按钮 + 状态灯
config.js             页面配置（数据文件路径、刷新策略）
app.js                读 data.json → 渲染 + 刷新控制（无 data.json 时回退演示数据）
custom-data.json      ★ 估值/持仓 自定义数据（免费源算不了，手动维护或接你自己的接口）
scripts/fetch_data.js 取数+计算脚本：Tushare 免费档(主力) + 东财(备份) → 宝妈指数 → data.json
cache/                本地缓存（已提交）：stock_basic.json(行业篮子) + sector_history.json(波动/回补回看)
fetch-data.bat / .sh  本地一键刷新（大陆网络，可拿东财增强）
test_engine.js        计算引擎合成测试（node test_engine.js，无需联网）
.github/workflows/refresh.yml  定时/手动刷新（ubuntu-latest，GitHub 直连 Tushare）
.nojekyll             GitHub Pages 跳过 Jekyll
```

## 本地预览
```bash
python -m http.server 8000   # 访问 http://localhost:8000
```
本地无 `data.json` 时自动用内置演示数据渲染；有 `data.json` 则显示实时（收盘快照）。

## 部署到 GitHub Pages（首次）
1. 推送到 GitHub 仓库（分支 `main`）。
2. 仓库 → Settings → Pages → Source: Deploy from a branch → Branch `main` / `(root)`。
3. 约 1 分钟后访问 `https://<用户名>.github.io/<仓库名>/`。
4. 工作流每日自动刷新；也可在 Actions 页面手动 `Run workflow` 立即生成 `data.json`。
