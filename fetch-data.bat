@echo off
REM ============================================================
REM 本地刷新看板数据（在你自己的电脑上跑，需大陆网络）
REM 前置：已 npm 安装好 node，且 git 已登录 GitHub
REM 用法：双击本文件，或加入 Windows 任务计划程序 每日 15:35 执行
REM ============================================================
cd /d %~dp0
echo [1/2] 拉取东财数据并计算宝妈指数 ...
node scripts/fetch_data.js
if %errorlevel% neq 0 (
  echo 取数失败（可能被东财限流），保留上一次数据，稍后重试。
  exit /b 1
)
echo [2/2] 提交并推送到 GitHub ...
git add data.json
git diff --cached --quiet && (echo 数据无变化，跳过提交) || (git commit -m "chore(data): 本地刷新看板数据" && git push)
echo 完成。打开 https://xiaoliu-bot.github.io/babymom-dashboard/ 查看。
pause
