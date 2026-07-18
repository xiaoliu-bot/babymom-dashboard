import json
import re

# 读取数据
with open('etf_data.json', encoding='utf-8') as f:
    data = json.load(f)

# 读取 HTML 模板
with open('index.html', encoding='utf-8') as f:
    html = f.read()

rows = ''
for etf in data['etfs']:
    change = etf['change']
    color = 'green' if change.startswith('+') else 'red' if change.startswith('-') else 'gray'
    sign = '+' if not change.startswith(('+', '-')) else ''
    rows += f"{etf['name']}{etf['code']}{etf['date']}{etf['nav']}<td style='color:{color};font-weight:bold'>{sign}{change}"

marker = f"<!-- AUTO_UPDATE {data['date']} -->"
script = f"<script>window.AUTO_ETF={json.dumps(data, ensure_ascii=False)};</script>"

if 'AUTO_ETF' in html:
    html = re.sub(
        r'<!-- AUTO_UPDATE.*?-->\s*<script>window\.AUTO_ETF.*?</script>',
        marker + script,
        html,
        flags=re.DOTALL
    )
else:
    html = html.replace('</body>', marker + '\n' + script + '\n</body>')

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print('index.html updated with', len(data['etfs']), 'ETFs')
