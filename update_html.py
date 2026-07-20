"""
update_html.py
读取 etf_data.json + index_data.json
更新 babymom-dashboard.html 中的动态数据块
用法: python3 update_html.py
"""

import json
import re
import datetime
import os

# ── 数据文件 ──────────────────────────────────────────────────
ETF_FILE   = "etf_data.json"
IDX_FILE   = "index_data.json"
HTML_FILE  = "babymom-dashboard.html"


def load_json(path: str) -> dict:
    if not os.path.exists(path):
        print(f"  ⚠️ {path} 不存在，跳过")
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def update_index_block(html: str, idx_data: dict) -> tuple[str, bool]:
    """更新 JavaScript indexData 对象"""
    indices = idx_data.get("indices", {})
    if not indices:
        return html, False

    updated = False
    for key, info in indices.items():
        price  = info.get("price", 0)
        change = info.get("change", 0)
        pct    = info.get("pct", 0)

        # 替换 price
        html, n1 = re.subn(
            rf"(?<='{key}':\s*\{{\s*name:\s*'[^']*',\s*code:\s*'[^']*',\s*price:\s*)[0-9.]+",
            str(price), html
        )
        # 替换 change
        html, n2 = re.subn(
            rf"(?<='{key}':\s*\{{[^}}]*change:\s*)[-+0-9.]+",
            str(change), html
        )
        # 替换 pct
        html, n3 = re.subn(
            rf"(?<='{key}':\s*\{{[^}}]*pct:\s*)[-+0-9.]+",
            str(pct), html
        )
        if n1 or n2 or n3:
            updated = True
            print(f"  ✓ 更新指数 {key}: {price} ({pct:+.2f}%)")

    return html, updated


def update_nav_history(html: str, etf_data: dict) -> tuple[str, bool]:
    """更新 navHistory 数组末尾追加今日净值"""
    etfs = etf_data.get("etfs", [])
    chip = next((e for e in etfs if e["code"] == "159995"), None)
    if not chip or chip.get("nav") in (None, "N/A", ""):
        print("  ⚠️ 芯片ETF净值缺失，跳过navHistory更新")
        return html, False

    today = etf_data.get("date", datetime.date.today().strftime("%Y-%m-%d"))
    nav   = float(chip["nav"])

    # 找到 navHistory 数组末尾的 ] 位置
    # 格式: { date: 'YYYY-MM-DD', nav: X.XXXX },
    pattern = r"(\{ date: ')(\d{4}-\d{2}-\d{2})(', nav: )([0-9.]+)(\},)\n(\s*)(\];)"
    m = re.search(pattern, html)
    if not m:
        print("  ⚠️ navHistory 格式未找到")
        return html, False

    last_date = m.group(2)
    last_nav  = float(m.group(4))
    indent    = m.group(6)

    # 比较：如果今天的净值和最后一条相同则跳过
    if last_date == today:
        print(f"  ℹ navHistory 今日已有记录 {today}，跳过")
        return html, False

    new_entry = f"  {{ date: '{today}', nav: {nav} }},\n{indent}"

    # 在倒数第二个 } 和最后的 ]; 之间插入
    # 替换：最后一条记录 末尾换行 → 加新条目
    old_last = f"  {{ date: '{last_date}', nav: {last_nav} }},\n{indent}];"
    new_last = f"  {{ date: '{last_date}', nav: {last_nav} }},\n{new_entry}];"

    if old_last in html:
        html = html.replace(old_last, new_last)
        print(f"  ✓ navHistory 新增: {today} nav={nav} (前值: {last_date} nav={last_nav})")
        return html, True
    else:
        # 兜底：在最后一个 }, 和 ]; 之间插入
        old_tail = f"{{ date: '{last_date}', nav: {last_nav} }},\n{indent}];"
        new_tail = f"{{ date: '{last_date}', nav: {last_nav} }},\n{indent}  {{ date: '{today}', nav: {nav} }},\n{indent}];"
        html = html.replace(old_tail, new_tail)
        print(f"  ✓ navHistory 备用插入: {today} nav={nav}")
        return html, True


def update_etf_colors(html: str, etf_data: dict) -> str:
    """更新页面顶部ETF区域的涨跌颜色"""
    # 东方财富 API 返回的 change 格式: "-7.14%" (字符串含%)
    return html


def update_timestamp(html: str, etf_data: dict) -> tuple[str, bool]:
    """更新页面底部数据更新时间"""
    idx_data = load_json(IDX_FILE)

    if idx_data.get("date"):
        ts = idx_data["date"]
    elif etf_data.get("date"):
        ts = etf_data["date"]
    else:
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    # 兼容不同时间格式
    if "T" in ts:
        ts = ts.replace("T", " ")[:16]

    old_ts_pattern = r"数据更新时间：[0-9\-]+[T ]?[0-9:]*"
    new_ts = f"数据更新时间：{ts}"
    html, n = re.subn(old_ts_pattern, new_ts, html)
    if n:
        print(f"  ✓ 更新时间戳: {new_ts}")
    return html, bool(n)


def update_chip_nav_display(html: str, etf_data: dict) -> tuple[str, bool]:
    """更新芯片ETF净值显示（如果HTML里有单独的显示区域）"""
    etfs = etf_data.get("etfs", [])
    chip = next((e for e in etfs if e["code"] == "159995"), None)
    if not chip or chip.get("nav") in (None, "N/A", ""):
        return html, False

    today  = chip.get("date", etf_data.get("date", ""))
    nav    = chip["nav"]
    change = chip.get("change", "0%")

    # 尝试更新标题时间
    m = re.search(r"<title>([^|]+)\| ([0-9\-]+)</title>", html)
    if m:
        old_title = m.group(0)
        new_title = f"<title>{m.group(1).strip()}| {today}</title>"
        html = html.replace(old_title, new_title)
        print(f"  ✓ 页面标题日期更新: {today}")

    return html, True


def main():
    print("=" * 50)
    print("开始更新 HTML")
    print("=" * 50)

    # ── 读取数据 ─────────────────────────────────────────────
    print(f"\n[1] 读取 {HTML_FILE} ...")
    if not os.path.exists(HTML_FILE):
        print(f"  ❌ {HTML_FILE} 不存在！请先下载到本地")
        return

    with open(HTML_FILE, encoding="utf-8") as f:
        html = f.read()
    print(f"  文件大小: {len(html):,} bytes")

    print(f"\n[2] 读取 {ETF_FILE} ...")
    etf_data = load_json(ETF_FILE)
    print(f"  日期: {etf_data.get('date','?')} | ETF数量: {len(etf_data.get('etfs',[]))}")

    print(f"\n[3] 读取 {IDX_FILE} ...")
    idx_data = load_json(IDX_FILE)
    print(f"  日期: {idx_data.get('date','?')} | 指数数量: {len(idx_data.get('indices',{}))}")

    original_html = html
    changes = []

    # ── 执行各项更新 ─────────────────────────────────────────
    print("\n[4] 执行更新...")

    html, ok = update_index_block(html, idx_data)
    if ok: changes.append("三大指数数据")

    html, ok = update_nav_history(html, etf_data)
    if ok: changes.append("NAV历史走势")

    html, ok = update_timestamp(html, etf_data)
    if ok: changes.append("时间戳")

    html, ok = update_chip_nav_display(html, etf_data)
    if ok: changes.append("页面标题")

    # ── 保存 ─────────────────────────────────────────────────
    if html == original_html:
        print("\n  ℹ 未检测到变化（数据已是最新）")
        print("  如需强制刷新，请删除本地文件后重新 fetch_etf.py")
        return

    with open(HTML_FILE, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"\n  ✅ 更新完成！已修改 {len(html) - len(original_html):+d} bytes")
    print(f"  已更新: {', '.join(changes) if changes else '无变化'}")
    print(f"\n  请 git add → commit → push 部署到 GitHub Pages")


if __name__ == "__main__":
    main()
