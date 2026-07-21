#!/usr/bin/env bash
# 本地刷新看板数据（Mac / Linux，需大陆网络）
# 用法：bash fetch-data.sh   或加入 crontab 每日 15:35
set -e
cd "$(dirname "$0")"
echo "[1/2] 拉取东财数据并计算宝妈指数 ..."
node scripts/fetch_data.js
echo "[2/2] 提交并推送到 GitHub ..."
git add data.json
if git diff --cached --quiet; then
  echo "数据无变化，跳过提交"
else
  git commit -m "chore(data): 本地刷新看板数据"
  git push
fi
echo "完成。打开 https://xiaoliu-bot.github.io/babymom-dashboard/ 查看。"
