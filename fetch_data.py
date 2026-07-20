#!/usr/bin/env python3
"""
fetch_data.py — 从东方财富抓 ETF 净值 + 三大指数
输出: etf_data.json, index_data.json
"""
import json, time, urllib.request, datetime

EM_ETF = [
    ("芯片ETF",   "159995"),
    ("化工ETF",   "159870"),
    ("科创50ETF", "588050"),
    ("科技50ETF", "515750"),
    ("恒生科技ETF","513180"),
]

EM_INDEX = [
    ("sse",    "上证指数",     "1.000001"),   # 上证
    ("ndx",    "纳斯达克100",  "100.NDX"),    # 纳指
    ("hstech", "恒生科技",     "116.HSTECH"), # 恒生科技
]

def eastmoney(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"  请求失败: {e}")
        return None

def fetch_etf():
    ts = str(int(time.time() * 1000))
    rows = []
    for name, code in EM_ETF:
        url = f"https://fundgz.1234567.com.cn/js/{code}.js?rt={ts}"
        d = eastmoney(url)
        if not d:
            continue
        rows.append({
            "name": name,
            "code": code,
            "date": d.get("gztime", "")[:10],
            "nav": d.get("gsz", "N/A"),
            "change": d.get("gszzl", "0") + "%",
        })
        print(f"  {name}({code}): {d.get('gsz')} ({d.get('gszzl')}%)")
        time.sleep(0.3)
    return rows

def fetch_index():
    rows = {}
    for key, name, secid in EM_INDEX:
        # 东方财富行情接口
        url = (
            f"https://push2.eastmoney.com/api/qt/stock/get"
            f"?secid={secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f169,f170"
        )
        d = eastmoney(url)
        if not d or "data" not in d:
            # 备用：直接用 HTML 里写死的默认数据
            rows[key] = {"name": name, "code": secid.split(".")[1],
                          "price": 0, "change": 0, "pct": 0}
            print(f"  {name}: 获取失败，用默认值")
            continue
        item = d["data"]
        price  = float(item.get("f43", 0)) / 100
        change = float(item.get("f169", 0)) / 100
        pct    = float(item.get("f170", 0)) / 100
        rows[key] = {"name": name, "code": secid.split(".")[1],
                     "price": round(price, 2), "change": round(change, 2),
                     "pct": round(pct, 2)}
        print(f"  {name}: {rows[key]['price']} ({rows[key]['pct']:+.2f}%)")
    return rows

if __name__ == "__main__":
    today = datetime.date.today().strftime("%Y-%m-%d")
    print("=" * 40)
    print("获取 ETF 数据...")
    etfs = fetch_etf()
    with open("etf_data.json", "w", encoding="utf-8") as f:
        json.dump({"date": etfs[0]["date"] if etfs else today,
                   "etfs": etfs}, f, ensure_ascii=False, indent=2)
    print(f"✅ etf_data.json 写入，{len(etfs)} 只ETF")

    print("=" * 40)
    print("获取指数数据...")
    indices = fetch_index()
    with open("index_data.json", "w", encoding="utf-8") as f:
        json.dump({"date": today, "indices": indices}, f, ensure_ascii=False, indent=2)
    print(f"✅ index_data.json 写入，{len(indices)} 个指数")
    print("=" * 40)
