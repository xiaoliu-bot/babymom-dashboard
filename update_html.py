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

rows = ""
for etf in data["etfs"]:
    change = etf["change"]
    color = "green" if change.startswith("+") else "red" if change.startswith("-") else "gray"
    sign = "+" if not change.startswith(("+", "-")) else ""
    rows += "<tr><td>" + etf["name"] + "</td><td>" + etf["code"] + "</td><td>" + etf["date"] + "</td><td>" + etf["nav"] + "</td><td style=color:" + color + ";font-weight:bold>" + sign + change + "</td></tr>\n"

marker = "<!-- AUTO_UPDATE " + data["date"] + " -->\n<script>window.AUTO_ETF=" + json.dumps(data, ensure_ascii=False) + ";</script>"

if "AUTO_ETF" in html:
    html = re.sub(r"<!-- AUTO_UPDATE.*?-->\s*<script>window\.AUTO_ETF.*?</script>", marker, html, flags=re.DOTALL)
    print("替换 AUTO_ETF 标记")
else:
    html = html.replace("</body>", marker + "\n</body>")
    print("追加 AUTO_ETF 标记")

if "数据更新时间" in html:
    now_str = data["date"] + " " + datetime.datetime.now().strftime("%H:%M")
    html = re.sub(r"数据更新时间：[0-9-]+ [0-9:]+", "数据更新时间：" + now_str, html)
    print("更新静态时间文字")

with open("index.html", "w", encoding="utf-8") as f:
    f.write(html)
print("index.html written OK")
