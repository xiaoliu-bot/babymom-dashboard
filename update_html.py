#!/usr/bin/env python3
"""
update_html.py — 用 etf_data.json + index_data.json 更新 babymom-dashboard.html
"""
import json, re, os

HTML_FILE = "babymom-dashboard.html"
ETF_FILE  = "etf_data.json"
IDX_FILE  = "index_data.json"


def load(path):
    if not os.path.exists(path):
        print(f"  ⚠️  {path} 不存在，跳过")
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def update_index(html, idx_data):
    """整块替换 indexData JS 对象"""
    indices = idx_data.get("indices", {})
    if not indices:
        return html, False

    def make_entry(key, info):
        price  = info.get("price", 0)
        change = info.get("change", 0)
        pct    = info.get("pct", 0)
        name   = info.get("name", key)
        code   = info.get("code", key)
        return (f"  {key}: {{\n"
                f"    name: '{name}',\n"
                f"    code: '{code}',\n"
                f"    price: {price},\n"
                f"    change: {change},\n"
                f"    pct: {pct},\n"
                f"  }}")

    new_block = "const indexData = {\n" + ",\n".join(
        make_entry(k, v) for k, v in indices.items()
    ) + "\n};"

    m = re.search(r'const indexData\s*=\s*\{.*?\n\};', html, re.DOTALL)
    if m:
        html = html.replace(m.group(0), new_block)
        print(f"  ✓ 更新 indexData（{len(indices)} 个指数）")
        return html, True
    print("  ⚠️  indexData 块未找到")
    return html, False


def update_nav_history(html, etf_data):
    """navHistory 末尾追加今日净值"""
    chip = next((e for e in etf_data.get("etfs", [])
                 if e["code"] == "159995"), None)
    if not chip or chip.get("nav") in ("N/A", "", None):
        print("  ⚠️  芯片ETF净值缺失")
        return html, False

    today = etf_data.get("date", "")
    nav   = float(chip["nav"])

    # 找 navHistory 末尾，注意 nav: 后面有2个空格
    m = re.search(
        r"(\{ date: ')(\d{4}-\d{2}-\d{2})(', nav: )([0-9.]+)(  },\n)(\s*)(\];)",
        html
    )
    if not m:
        # 备用：任意空格数
        m = re.search(
            r"(\{ date: ')(\d{4}-\d{2}-\d{2})(', nav: )([0-9.]+)( *},\n)(\s*)(\];)",
            html
        )
    if not m:
        print("  ⚠️  navHistory 块未找到")
        return html, False

    last_date = m.group(2)
    last_nav  = float(m.group(4))
    indent    = m.group(7).replace("];", "")  # 获取缩进空格

    if last_date == today:
        print(f"  ℹ  navHistory 今日已有 {today}，跳过")
        return html, False

    # 重新构建替换字符串（保持原格式）
    old_tail = m.group(0)[-60:]  # 取末尾验证
    old = f"{{ date: '{last_date}', nav: {last_nav}  }},\n{indent}];"
    new = f"{{ date: '{last_date}', nav: {last_nav}  }},\n{indent}  {{ date: '{today}', nav: {nav}  }},\n{indent}];"

    if old in html:
        html = html.replace(old, new)
        print(f"  ✓ navHistory: 新增 {today} nav={nav} (前: {last_date} nav={last_nav})")
        return html, True

    # 备用替换：直接用正则匹配结果
    new_tail = m.group(1) + m.group(2) + m.group(3) + str(nav) + "  },\n" + \
               indent + "  { date: '" + today + "', nav: " + str(nav) + "  },\n" + \
               indent + "];"
    html = html[:m.start()] + new_tail + html[m.end():]
    print(f"  ✓ navHistory（备用替换）: 新增 {today} nav={nav}")
    return html, True


def update_timestamp(html, idx_data, etf_data):
    """更新时间戳"""
    ts = idx_data.get("date") or etf_data.get("date", "")
    ts = ts + " " + __import__("datetime").datetime.now().strftime("%H:%M")
    html, n = re.subn(
        r"数据更新时间：[0-9\-]+[T ]?[0-9:]*",
        f"数据更新时间：{ts}", html
    )
    if n:
        print(f"  ✓ 时间戳: {ts}")
    return html, bool(n)


def main():
    print("=" * 50)
    print("读取 HTML...")
    if not os.path.exists(HTML_FILE):
        print(f"  ❌ {HTML_FILE} 不存在！")
        return
    with open(HTML_FILE, encoding="utf-8") as f:
        html = f.read()
    print(f"  大小: {len(html):,} bytes")

    etf = load(ETF_FILE)
    idx = load(IDX_FILE)
    print(f"  ETF日期: {etf.get('date')} | 指数日期: {idx.get('date')}")

    original = html
    changes = []

    print("=" * 50)
    html, ok = update_index(html, idx)
    if ok: changes.append("指数")
    html, ok = update_nav_history(html, etf)
    if ok: changes.append("净值")
    html, ok = update_timestamp(html, idx, etf)
    if ok: changes.append("时间戳")

    if html == original:
        print("  ℹ  无变化（数据已是最新）")
        return

    with open(HTML_FILE, "w", encoding="utf-8") as f:
        f.write(html)

    diff = len(html) - len(original)
    print(f"\n✅ 完成！{diff:+d} bytes")
    print(f"   已更新: {', '.join(c for c in changes if c)}")
    print(f"\n   下一步: git add → commit → push")


if __name__ == "__main__":
    main()
