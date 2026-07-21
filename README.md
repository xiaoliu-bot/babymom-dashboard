# 宝妈指数看板 · 大盘数据监控（在线版）

基于原 `babymom-dashboard.html` 改造的可上线版本。每日收盘后自动计算「宝妈指数」（情绪化散户活跃度），推送到 GitHub Pages 展示。

## ⚠️ 关于数据源与部署的重要说明（必读）
看板数据来自**东方财富（东财）公开行情接口**。东财对**海外/云厂商 IP 会限流甚至封锁**——GitHub Actions 的默认美国 runner（`ubuntu-latest`）取不到东财（实测返回 502 / 连接失败）。

因此，**自动刷新必须在「大陆网络环境」下执行**。有两种可靠方式：

### 方式 A：在你自己的电脑上跑（推荐，最省心）
你的电脑在国内，东财接口畅通。每天收盘后运行一次即可：
```bash
# Windows：双击 fetch-data.bat
# Mac/Linux：
bash fetch-data.sh
```
脚本会 `node scripts/fetch_data.js` 拉数 → 计算宝妈指数 → `git commit & push` 到仓库 → Pages 自动重建。
可加入系统定时任务实现无人值守：
- Windows 任务计划程序：每日 15:35 执行 `fetch-data.bat`
- Mac/Linux crontab：`35 15 * * 1-5 bash /path/fetch-data.sh`

### 方式 B：GitHub 自托管 Runner（真·无人值守）
在仓库 → Settings → Actions → Runners → New self-hosted runner，按指引在你大陆机器上安装并运行 runner。
然后把 `.github/workflows/refresh.yml` 里的 `runs-on: ubuntu-latest` 改成 `runs-on: self-hosted`，每日 15:30 的定时任务就会在你的机器上跑，自动刷新。

> 仓库里现有的 `refresh.yml` 默认仍用 `ubuntu-latest`（失败时会安全保留上一次数据、不覆盖），方便你随时手动触发验证；要稳定自动化请切换为 self-hosted。

## 宝妈指数（情绪化散户活跃度）计算方法
对每个板块算 6 个原始维度，再做**跨板块分位排名（0–100）**，加权合成总分：

| 维度 | 含义 | 数据来源 |
|---|---|---|
| 拥挤度 | 板块成交额相对自身历史均值的异动（钱往一处挤） | 板块指数K线成交额 |
| 扩散力 | 板块内上涨家数占比（普涨/情绪一致） | 板块排行涨/跌家数 |
| 动摇度 | 板块指数近 20 日年化波动率（上蹿下跳） | 板块指数K线 |
| D回补 | 从近期低点回补的强度（一跌就有人抄） | 板块指数K线 |
| 涨停密度 | 板块内涨停（≥9.5%）个股占比（散户追板） | 板块成分股 |
| 换手度 | 板块换手率（频繁倒手=散户特征） | 板块排行换手率 |

**讨论度**（单列，不参与总分）= 行为代理（换手+涨停密度）为主；若东财股吧人气榜可取，则叠加人气排名增强。
**总分权重**：拥挤 0.25 / 扩散 0.15 / 动摇 0.15 / D回补 0.10 / 换手 0.15 / 涨停 0.10。
**读分**：<40 冷静（机构主导）、40–70 温和、>70 过热（宝妈扎堆，回撤风险高）。

> 代理变量说明：真实的"散户 vs 机构"资金拆分无法免费获取，以上用换手率、涨停密度、成交额异动等**最贴近情绪化交易行为**的市场信号逼近。

## 目录结构
```
index.html            页面（深色专业风），顶部「刷新」按钮 + 状态灯
config.js             页面配置（数据文件路径、刷新策略）
app.js                读 data.json → 渲染 + 刷新控制（无 data.json 时回退演示数据）
custom-data.json      ★ 估值/持仓 自定义数据（东财算不了，手动维护或接你自己的接口）
scripts/fetch_data.js 取数+计算脚本：东财板块数据 → 宝妈指数 → data.json
fetch-data.bat / .sh  本地一键刷新（大陆网络）
.github/workflows/refresh.yml  定时/手动刷新（默认 ubuntu-latest，建议改 self-hosted）
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
4. 用方式 A 或 B 跑一次取数，生成 `data.json` 即可看到计算的宝妈指数。
