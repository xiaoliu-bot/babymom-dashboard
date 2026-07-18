import urllib.request, json, datetime, os

today = datetime.date.today().strftime('%Y-%m-%d')
print("今日: " + today)

def get_etf_data(code):
    url = "https://api.fund.eastmoney.com/f10/lsjz?fundCode=" + code + "&pageIndex=1&pageSize=5"
    req = urllib.request.Request(url, headers={"Referer": "https://fund.eastmoney.com/"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())

codes = {"159995":"芯片ETF","159870":"化工ETF","588050":"科创50ETF","515750":"科技50ETF","513180":"恒生科技ETF"}

results = []
ok_count = 0
for code, name in codes.items():
    try:
        d = get_etf_data(code)
        items = d.get("Data",{}).get("LSJZList",[])
        if items:
            item = items[0]
            results.append({"name":name,"code":code,"date":item["FSRQ"],"nav":item["DWJZ"],"change":str(item["JZZZL"])+"%"})
            ok_count += 1
            print("OK " + name + ": " + item["FSRQ"] + " nav=" + item["DWJZ"] + " change=" + str(item["JZZZL"]) + "%")
        else:
            results.append({"name":name,"code":code,"date":"N/A","nav":"N/A","change":"N/A"})
            print("EMPTY " + name)
    except Exception as e:
        results.append({"name":name,"code":code,"date":"N/A","nav":"N/A","change":"N/A"})
        print("FAIL " + name + ": " + str(e))

print("成功: " + str(ok_count) + "/" + str(len(codes)))
etf_data = {"date": today, "etfs": results}
with open("etf_data.json", "w", encoding="utf-8") as f:
    json.dump(etf_data, f, ensure_ascii=False, indent=2)
print("etf_data.json written OK")
