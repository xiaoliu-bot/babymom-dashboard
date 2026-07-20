#!/usr/bin/env python3
"""
update_dashboard.py — 宝妈指数看板一键更新脚本
功能：获取数据 → 注入HTML → 推送到GitHub
用法：
  python update_dashboard.py                  # 手动运行
  python update_dashboard.py --check-only     # 仅获取数据，不推送
"""

import json
import re
import sys
import time
import subprocess
import argparse
from datetime import datetime
from pathlib import Path

# ── 配置 ─────────────────────────────────────────────────────────────────────
TUSHARE_TOKEN = "0cdd5c…c4d2"
REPO_DIR = Path(__file__).parent.resolve()      # 脚本所在目录 = 仓库根目录
HTML_FILE = REPO_DIR / "index.html"
DATA_FILE = REPO_DIR / "babymom_data.json"
GIT_EMAIL = "babymom-bot@openclaw.ai"
GIT_NAME  = "Babymom Bot"
COMMIT_MSG_PREFIX = "📊 Auto-update"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"

# ── 工具函数 ─────────────────────────────────────────────────────────────────
def http_get(url, headers=None, params=None, timeout=8):
    import requests
    h = dict(headers) if headers else {}
    h.setdefault("User-Agent", UA)
    try:
        r = requests.get(url, headers=h, params=params, timeout=timeout)
        r.raise_for_status()
        return r.text
    except Exception as e:
        print(f"    ⚠️ HTTP失败 [{url[:55]}]: {e}")
        return None


def git_run(*args, cwd=None):
    """运行git命令"""
    cwd = cwd or REPO_DIR
    result = subprocess.run(["git"] + list(args), cwd=cwd,
                            capture_output=True, text=True, timeout=30)
    if result.returncode != 0 and result.stderr:
        print(f"    ⚠️ git {' '.join(args)}: {result.stderr.strip()}")
    return result


# ── 1. 数据获取 ────────────────────────────────────────────────────────────────
def get_trade_dates(n=3):
    import tushare as ts
    pro = ts.pro_api(TUSHARE_TOKEN)
    dates, d = [], datetime.now()
    while len(dates) < n:
        d -= __import__("datetime").timedelta(days=1)
        if d.weekday() >= 5:
            continue
        ds = d.strftime("%Y%m%d")
        try:
            if not pro.daily(trade_date=ds).empty:
                dates.append(ds)
        except Exception:
            pass
    return dates


def fetch_index_data():
    """三大指数：上证 / 纳指ETF / 恒生科技"""
    result = {}

    # 上证 — 腾讯行情
    text = http_get("https://qt.gtimg.cn/q=sh000001",
                    headers={"User-Agent": UA, "Referer": "https://finance.qq.com/"})
    if text:
        m = re.search(r'="([^"]+)"', text)
        if m:
            p = m.group(1).split("~")
            if len(p) > 4 and p[3]:
                price = float(p[3]); pre = float(p[4])
                chg = round(price - pre, 2)
                pct = round(chg / pre * 100, 2) if pre else 0
                result["sse"] = {"price": price, "change": chg, "pct": pct}
                print(f"  ✅ 上证: {price:.2f} ({pct:+.2f}%)")

    # 纳指ETF(513300)换算NDX
    text = http_get("https://hq.sinajs.cn/list=sh513300",
                    headers={"User-Agent": UA, "Referer": "https://finance.sina.com.cn/"})
    if text:
        m = re.search(r'="([^"]+)"', text)
        if m:
            p = m.group(1).split(",")
            if len(p) > 5 and p[0]:
                price = float(p[1]); pre = float(p[2])
                chg = round(price - pre, 4); pct = round(chg / pre * 100, 2) if pre else 0
                result["ndx"] = {
                    "price": round(price * 8150, 2),
                    "change": round(chg * 8150, 2),
                    "pct": pct,
                    "etf_price": price,
                }
                print(f"  ✅ 纳指100: {round(price*8150,2):.2f} ({pct:+.2f}%)")

    # 恒生科技 — 新浪港股
    text = http_get("https://hq.sinajs.cn/list=hkHSTECH",
                    headers={"User-Agent": UA, "Referer": "https://finance.sina.com.cn/"})
    if text:
        m = re.search(r'="([^"]+)"', text)
        if m:
            p = m.group(1).split(",")
            if len(p) > 4:
                price = float(p[3]); pre = float(p[4])
                chg = round(price - pre, 2); pct = round(chg / pre * 100, 2) if pre else 0
                result["hstech"] = {"price": price, "change": chg, "pct": pct}
                print(f"  ✅ 恒生科技: {price:.2f} ({pct:+.2f}%)")

    return result


def fetch_etf_nav(n=60):
    """芯片ETF(159995)净值走势 — 新浪日K"""
    text = http_get(
        "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData",
        params={"symbol": "sz159995", "scale": "240", "ma": "5", "datalen": str(n)},
        headers={"User-Agent": UA, "Referer": "https://finance.sina.com.cn/"}
    )
    result = []
    if text:
        try:
            for item in json.loads(text):
                result.append({
                    "date": item.get("day", ""),
                    "nav": round(float(item.get("close", 0)), 4)
                })
        except Exception:
            pass
    print(f"  ✅ ETF净值: {len(result)}条 (最新: {result[-1]['date'] if result else 'N/A'})")
    return result


def fetch_sector_data():
    """板块成分股涨跌 — Tushare"""
    import tushare as ts
    pro = ts.pro_api(TUSHARE_TOKEN)

    SECTOR_STOCKS = {
        "芯片":       ["688256.SH","688041.SH","002371.SZ","688008.SH","688012.SH"],
        "半导体":     ["002371.SZ","688012.SH","688036.SH","688082.SH","603501.SH"],
        "细分化工":   ["600309.SH","600486.SH","002064.SZ","002601.SZ","601216.SH"],
        "科创创业AI": ["688041.SH","688008.SH","002230.SZ","300024.SZ","000977.SZ"],
        "机器人":     ["300024.SZ","002009.SZ","688777.SH","002097.SZ","300124.SZ"],
        "新能源电池": ["300750.SZ","002594.SZ","688005.SH","002074.SZ","300014.SZ"],
        "恒生科技":   [],
        "创新药":     ["300760.SZ","000661.SZ","600276.SH","002007.SZ","300347.SZ"],
        "锂矿":       ["002466.SZ","002460.SZ","000400.SZ","600111.SH","002709.SZ"],
        "CPO":        ["002281.SZ","300308.SZ","688498.SH","603083.SH","002463.SZ"],
        "PCB":        ["002916.SZ","002384.SZ","603228.SH","002938.SZ","002436.SZ"],
    }

    result = {}
    trade_dates = get_trade_dates(1)
    today = trade_dates[0] if trade_dates else ""

    for name, codes in SECTOR_STOCKS.items():
        if not codes:
            result[name] = {"pct_chg": 0, "up_ratio": 0}
            continue
        try:
            df = pro.daily(ts_code=",".join(codes), trade_date=today)
            if df.empty:
                df = pro.daily(ts_code=",".join(codes), start_date=today, end_date=today)
            if not df.empty:
                avg_pct = round(df["pct_chg"].mean(), 2)
                up_cnt = (df["pct_chg"] > 0).sum()
                result[name] = {"pct_chg": avg_pct, "up_ratio": round(up_cnt/len(df)*100, 1)}
                print(f"  {name}: 均涨跌幅={avg_pct:+.2f}%, 上涨={up_cnt}/{len(df)}")
            else:
                result[name] = {"pct_chg": 0, "up_ratio": 0}
        except Exception as e:
            result[name] = {"pct_chg": 0, "up_ratio": 0}
        time.sleep(0.3)

    print(f"  ✅ 板块数据: {len(result)}个")
    return result


def calc_crowding(sector_data):
    """计算拥挤度五维数据"""
    result = []
    for name, d in sector_data.items():
        pct = d.get("pct_chg", 0)
        # 扩散力: 涨跌幅映射 0-100
        dif = max(0, min(100, 50 + pct * 6))
        # 动摇度: 振幅估算
        amp = abs(pct) * 2
        wov = min(100, max(20, 50 + amp * 5))
        # D回补力: 资金（暂无，用涨跌代理）
        dbu = max(0, min(100, 50 + pct * 3))
        # 有拥挤度
        cro = min(100, max(20, dif * 0.8 + 10))
        # ORE
        ore = 60
        total = round(ore*0.30 + dif*0.15 + wov*0.15 + dbu*0.20 + cro*0.10 + 50*0.10, 1)
        result.append({
            "name": name, "ore": round(ore,1), "dif": round(dif,1),
            "wov": round(wov,1), "dbu": round(dbu,1), "cro": round(cro,1),
            "total": total, "chg": 0
        })
    return result


# ── 2. 注入HTML ────────────────────────────────────────────────────────────────
def color_pct(v):
    return "#da3633" if v >= 95 else "#d29922" if v >= 80 else "#238636"

def heat_color(v):
    return "#da3633" if v > 100 else "#d29922" if v >= 80 else "#238636"


def update_html(html_path, data):
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()

    update_time = data.get("update_time", datetime.now().strftime("%Y-%m-%d %H:%M"))
    index_data = data.get("index_data", {})
    nav_history = data.get("nav_history", [])
    heatmap_data = data.get("heatmap_data", [])

    # 更新时间
    html = re.sub(r'数据更新时间：([^&]+)(&nbsp;\|&nbsp;)',
                  f'数据更新时间：{update_time}\\2', html)
    html = re.sub(r'<title>[^<]*</title>',
                  f'<title>宝妈指数看板 v2.0 | {datetime.now().strftime("%Y-%m-%d")}</title>', html)

    # 三大指数
    id_map = {"sse": "idx-sse", "ndx": "idx-ndx", "hstech": "idx-hstech"}
    for key, pid in id_map.items():
        if key not in index_data:
            continue
        d = index_data[key]
        price = d.get("price", 0); chg = d.get("change", 0); pct = d.get("pct", 0)
        up = chg >= 0; cls = "up" if up else "down"
        arrow = "▲" if up else "▼"; sign = "+" if up else ""
        price_str = f"{price:,.2f}"
        change_str = f"{arrow} {abs(chg):,.2f} ({sign}{pct:,.2f}%)"
        html = re.sub(rf'(id="{pid}-price"[^>]*>)([^<]*)(</div>)',
                      rf'\g<1>{price_str}\g<3>', html)
        html = re.sub(rf'(id="{pid}-change"[^>]*>)(<span[^>]*>)?[^<]*(</span>)?(</div>)',
                      rf'\g<1><span class="{cls}">{change_str}</span>\g<4>', html)

    # 热力图
    cs = html.find('id="heatmap-container"')
    if cs > 0:
        depth, pos, div_start = 0, cs, html.find('>', cs) + 1
        pos = div_start
        while pos < len(html):
            if html[pos:pos+5] in ('<div ', '<div>'):
                depth += 1; pos += 5
            elif html[pos:pos+6] == '</div>':
                depth -= 1; pos += 6
                if depth == 0: break
            else: pos += 1
        container_end = pos

        headers = ('<div class="heatmap-header">板块<br>拥挤度</div>'
                   '<div class="heatmap-header">ORE<br>拥挤度</div>'
                   '<div class="heatmap-header">扩散力</div>'
                   '<div class="heatmap-header">动摇度</div>'
                   '<div class="heatmap-header">D回补</div>'
                   '<div class="heatmap-header">有拥挤度</div>'
                   '<div class="heatmap-header">总分</div>')
        cols = ["name","ore","dif","wov","dbu","cro","total"]
        cells = ""
        for row in heatmap_data:
            for ci, col in enumerate(cols):
                v = row.get(col, 0); chg = row.get("chg", 0)
                if ci == 0:
                    cells += f'<div class="heatmap-sector">{v}</div>'
                elif col == "total":
                    bg = heat_color(v)
                    cs2 = f" ↑{chg}" if chg > 0 else (f" ↓{abs(chg)}" if chg < 0 else "")
                    cells += f'<div class="heatmap-total" style="background:{bg}">{v}<span class="chg">{cs2}</span></div>'
                else:
                    bg = heat_color(v)
                    tc = "#fff" if v > 80 else "#0d1117"
                    cells += f'<div class="heatmap-cell" style="background:{bg};color:{tc}">{v}</div>'
        new_block = f'<div id="heatmap-container">{headers}\n{cells}</div>'
        html = html[:cs] + new_block + html[container_end:]

    # NAV历史
    if nav_history:
        nav_str = json.dumps(nav_history, ensure_ascii=False)
        html = re.sub(r'const navHistory = \[.*?\];', f'const navHistory = {nav_str};', html, flags=re.DOTALL)

    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"\n✅ HTML已更新: {html_path}")
    print(f"   净值: {len(nav_history)}条  拥挤度: {len(heatmap_data)}个板块")


# ── 3. Git提交推送 ─────────────────────────────────────────────────────────────
def git_push():
    # 配置git
    git_run("config", "user.email", GIT_EMAIL, cwd=REPO_DIR)
    git_run("config", "user.name", GIT_NAME, cwd=REPO_DIR)

    # 检查是否有变化
    status = git_run("status", "--porcelain", cwd=REPO_DIR)
    if not status.stdout.strip():
        print("ℹ️ 无变化，跳过推送")
        return False

    changed_files = [l.strip() for l in status.stdout.strip().splitlines() if l.strip()]
    print(f"📦 变更文件: {changed_files}")

    git_run("add", *changed_files, cwd=REPO_DIR)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    result = git_run("commit", "-m", f"{COMMIT_MSG_PREFIX} {ts}", cwd=REPO_DIR)
    if result.returncode != 0:
        print(f"❌ 提交失败: {result.stderr}")
        return False

    # 获取当前分支
    branch_result = git_run("branch", "--show-current", cwd=REPO_DIR)
    branch = branch_result.stdout.strip() or "main"

    # 推送（使用 HTTPS + token）
    # GitHub PAT 通过环境变量 GITHUB_TOKEN 注入
    token = __import__("os").environ.get("GITHUB_TOKEN", "")
    remote = git_run("remote", "get-url", "origin", cwd=REPO_DIR)
    origin_url = remote.stdout.strip() if remote.returncode == 0 else ""

    if token and origin_url.startswith("https://"):
        # 替换为带token的URL
        secure_url = re.sub(r'https://', f'https://x-access-token:{token}@', origin_url, 1)
        git_run("remote", "set-url", "origin", secure_url, cwd=REPO_DIR)

    push = git_run("push", "origin", branch, cwd=REPO_DIR)
    if push.returncode != 0:
        print(f"❌ 推送失败: {push.stderr}")
        # 恢复原始origin URL
        if token and origin_url.startswith("https://"):
            git_run("remote", "set-url", "origin", origin_url, cwd=REPO_DIR)
        return False

    print(f"✅ 推送成功！({datetime.now().strftime('%H:%M:%S')})")
    return True


# ── 主程序 ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="宝妈指数看板更新")
    parser.add_argument("--check-only", action="store_true", help="仅获取数据，不推送")
    parser.add_argument("--html", default=str(HTML_FILE), help="HTML文件路径")
    parser.add_argument("--data", default=str(DATA_FILE), help="数据JSON路径")
    args = parser.parse_args()

    print(f"\n{'='*50}")
    print(f"  宝妈指数看板 自动更新  {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"{'='*50}\n")

    # 1. 获取数据
    print("📊 三大指数...")
    index_data = fetch_index_data()

    print("📈 ETF净值...")
    nav_history = fetch_etf_nav(n=60)

    print("💰 板块数据...")
    sector_data = fetch_sector_data()

    print("🔥 拥挤度计算...")
    heatmap_data = calc_crowding(sector_data)

    # 组装
    data = {
        "update_time": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "index_data": index_data,
        "nav_history": nav_history,
        "heatmap_data": heatmap_data,
    }

    # 保存JSON
    with open(args.data, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"✅ 数据已保存: {args.data}")

    # 2. 注入HTML
    print("\n🖥️  注入HTML...")
    update_html(args.html, data)

    if args.check_only:
        print("\nℹ️ --check-only 模式，跳过Git推送")
        return

    # 3. Git推送
    print("\n🚀 推送到GitHub...")
    ok = git_push()
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
