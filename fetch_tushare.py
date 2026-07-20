"""
fetch_tushare.py
从 Tushare 获取数据，支持回退到东方财富（eastmoney）备源
用法: python3 fetch_tushare.py
输出: etf_data.json + index_data.json
"""

import json
import time
import datetime
import urllib.request
import urllib.error

# ── Tushare 配置 ──────────────────────────────────────────────
TUSHARE_TOKEN = "0cdd5c099fd79ce5b598c77d97dd1ad1ec86aedeb22c77756222c4d2"
TUSHARE_API   = "http://api.tushare.pro"

# ── 东方财富备源 ETF API ───────────────────────────────────────
EM_ETF_LIST = [
    ("芯片ETF", "159995"),
    ("化工ETF", "159870"),
    ("科创50ETF", "588050"),
    ("科技50ETF", "515750"),
    ("恒生科技ETF", "513180"),
]


def tushare_api(func: str, params: dict, fields: str) -> list | None:
    """调用 Tushare API（需要 token），失败返回 None"""
    payload = json.dumps({
        "api_name": func,
        "token": TUSHARE_TOKEN,
        "params": params,
        "fields": fields,
    }).encode("utf-8")
    req = urllib.request.Request(
        TUSHARE_API,
        data=payload,
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
        if data.get("code") == 0:
            cols = fields.split(",")
            return [dict(zip(cols, row)) for row in data["data"]["items"]]
        else:
            print(f"  [Tushare] {func} 失败: {data.get('msg')}")
            return None
    except Exception as e:
        print(f"  [Tushare] {func} 请求异常: {e}")
        return None


def eastmoney_etf(name: str, code: str) -> dict | None:
    """从东方财富抓 ETF 最新净值（备源）"""
    url = (
        f"https://fundgz.1234567.com.cn/js/{code}.js?rt="
        + str(int(time.time() * 1000))
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            text = resp.read().decode("utf-8")
        # 格式: jsonpgz({...});
        json_str = text[text.index("(") + 1 : text.rindex(")")]
        d = json.loads(json_str)
        return {
            "name": name,
            "code": code,
            "date": d.get("gztime", "")[:10],
            "nav": d.get("gsz", "N/A"),
            "change": d.get("gszzl", "0") + "%",
        }
    except Exception as e:
        print(f"  [EastMoney] {code} 失败: {e}")
        return None


def eastmoney_index(name: str, code: str) -> dict | None:
    """从东方财富抓指数实时行情（备源）"""
    try:
        url = f"https://push2.eastmoney.com/api/qt/stock/get?secid={
            '1.' if code.startswith('0') or code.startswith('3') else '0.'
        }{code}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f169,f170"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            d = json.loads(resp.read())
        item = d.get("data", {})
        price = float(item.get("f43", 0)) / 100
        change = float(item.get("f169", 0)) / 100
        pct = float(item.get("f170", 0)) / 100
        return {
            "name": name,
            "code": code,
            "price": round(price, 2),
            "change": round(change, 2),
            "pct": round(pct, 2),
        }
    except Exception as e:
        print(f"  [EastMoney] 指数 {code} 失败: {e}")
        return None


def fetch_etf() -> dict:
    """获取 ETF 数据（主Tushare → 备东方财富）"""
    today = datetime.date.today().strftime("%Y-%m-%d")

    # ── 尝试 Tushare ──────────────────────────────────────────
    ts_data = tushare_api(
        "fund_nav",
        {"tsCode": "159995.OF", "endDate": today},
        "tsCode,secNav,navDate,unitNav,accNav,navRate",
    )
    if ts_data:
        print(f"  [Tushare] 成功获取 ETF 数据，共 {len(ts_data)} 条")
        return {
            "date": today,
            "source": "tushare",
            "etfs": [],  # TODO: 批量查
        }

    # ── 回退东方财富 ─────────────────────────────────────────
    print("  回退东方财富 ETF 数据...")
    etfs = []
    for name, code in EM_ETF_LIST:
        row = eastmoney_etf(name, code)
        if row:
            etfs.append(row)
    return {
        "date": etfs[0]["date"] if etfs else today,
        "source": "eastmoney",
        "etfs": etfs,
    }


def fetch_index() -> dict:
    """获取三大指数数据（主Tushare → 备东方财富）"""
    today = datetime.date.today().strftime("%Y-%m-%d")

    # 上证指数 000001，深证成指 399001，纳斯达克/恒生通过 eastmoney 间接
    # 这里直接用东方财富（更快更稳）
    indices = [
        ("上证指数", "000001", "1"),
        ("纳斯达克100", "NDX", "100"),
        ("恒生科技", "HSTECH", "116"),
    ]

    result = {}
    for name, code, mkt in indices:
        row = eastmoney_index(name, code)
        if row:
            key = {"上证指数": "sse", "纳斯达克100": "ndx", "恒生科技": "hstech"}[name]
            result[key] = row

    # 纳斯达克/恒生用 eastmoney 代理接口
    # 如果上面失败，用备源
    if "ndx" not in result:
        result["ndx"] = eastmoney_index("纳斯达克100", "NDX")
    if "hstech" not in result:
        result["hstech"] = eastmoney_index("恒生科技", "HSTECH")

    return {
        "date": today,
        "source": "eastmoney",
        "indices": result,
    }


def main():
    print("=" * 40)
    print("开始获取数据")
    print("=" * 40)

    print("\n[1/2] 获取 ETF 净值数据...")
    etf_data = fetch_etf()
    print(f"  ETF数据日期: {etf_data['date']}")
    for e in etf_data.get("etfs", []):
        print(f"  - {e['name']}({e['code']}): {e['nav']} ({e['change']})")

    print("\n[2/2] 获取三大指数数据...")
    idx_data = fetch_index()
    print(f"  指数数据日期: {idx_data['date']}")
    for k, v in idx_data.get("indices", {}).items():
        print(f"  - {k}: {v.get('price')} ({v.get('change')} / {v.get('pct')}%)")

    # 写入 JSON
    with open("etf_data.json", "w", encoding="utf-8") as f:
        json.dump(etf_data, f, ensure_ascii=False, indent=2)
    print("\n✅ etf_data.json 已写入")

    with open("index_data.json", "w", encoding="utf-8") as f:
        json.dump(idx_data, f, ensure_ascii=False, indent=2)
    print("✅ index_data.json 已写入")

    print("\n" + "=" * 40)
    print("数据获取完成！")
    print("=" * 40)


if __name__ == "__main__":
    main()
