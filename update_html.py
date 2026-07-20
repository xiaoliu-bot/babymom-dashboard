import json, os, re, datetime

with open("etf_data.json", encoding="utf-8") as f:
    data = json.load(f)
print("读取到 " + str(len(data["etfs"])) + " 条ETF数据")

os.makedirs("api", exist_ok=True)
with open("api/etf.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print("api/etf.json written")

with open("index.html", encoding="utf-8") as f:
    html = f.read()

# ── 1. AUTO_ETF 块更新 ──────────────────────────────────────────
marker = "<!-- AUTO_UPDATE " + data["date"] + " -->\n<script>window.AUTO_ETF=" + json.dumps(data, ensure_ascii=False) + ";</script>"

if "AUTO_ETF" in html:
    html = re.sub(r"<!-- AUTO_UPDATE.*?-->\s*<script>window\.AUTO_ETF.*?</script>", marker, html, flags=re.DOTALL)
    print("替换 AUTO_ETF 标记")
else:
    html = html.replace("</body>", marker + "\n</body>")
    print("追加 AUTO_ETF 标记")

# ── 2. 更新时间戳 ───────────────────────────────────────────────
if "数据更新时间" in html:
    now_str = data["date"] + " " + datetime.datetime.now().strftime("%H:%M")
    html = re.sub(r"数据更新时间：[0-9-]+ [0-9:]+", "数据更新时间：" + now_str, html)
    print("更新静态时间文字")

# ── 3. navHistory 末尾插入新净值点 ──────────────────────────────
chip = next((e for e in data["etfs"] if e["code"] == "159995"), None)
nav = float(chip["nav"]) if chip and chip["nav"] != "N/A" else None
if nav:
    today = data["date"]
    old = "  { date: '2026-07-16', nav: 1.32 },\n];"
    new = f"  {{ date: '2026-07-16', nav: 1.32 }},\n  {{ date: '{today}', nav: {nav} }},\n];"
    if old in html:
        html = html.replace(old, new)
        print(f"插入 navHistory: {today} nav={nav}")
    else:
        # 兼容：直接在 ] 前插入（通用方式）
        idx = html.rindex("\n];")
        insert = f"\n  {{ date: '{today}', nav: {nav} }},"
        html = html[:idx] + insert + html[idx:]
        print(f"备用插入 navHistory: {today} nav={nav}")

# ── 4. 动态计算雷达图总分 ───────────────────────────────────────
# 基准：净值1.32 → 总分91（对应最后一个维度）
if nav:
    baseline_nav = 1.32
    baseline_total = 91
    dynamic_total = max(60, min(120, round(baseline_total * nav / baseline_nav)))
    html = re.sub(
        r"values: \[95, 85, 40, 92, 94, \d+\]",
        f"values: [95, 85, 40, 92, 94, {dynamic_total}]",
        html
    )
    print(f"雷达图总分: {dynamic_total} (净值={nav})")

with open("index.html", "w", encoding="utf-8") as f:
    f.write(html)
print("index.html written OK")
