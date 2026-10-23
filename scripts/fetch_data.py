#!/usr/bin/env python3
"""Fetch market data for the simulator (run by GitHub Actions).

  python scripts/fetch_data.py history   # weekly (from daily) adjusted closes since 2000 -> data/history/<id>.json
  python scripts/fetch_data.py live      # latest delayed quotes            -> data/live.json

Only the standard library is used. Sources: Yahoo Finance chart API, with the
TWSE MIS API as the first choice for Taiwan live quotes.
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
UA = {"User-Agent": "Mozilla/5.0 (kids-trader simulator)"}


def get_json(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            print(f"  retry {url}: {e}", file=sys.stderr)
            time.sleep(2 * (i + 1))


def yahoo_chart(sym, params):
    hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
    last = None
    for h in hosts:
        try:
            d = get_json(f"https://{h}/v8/finance/chart/{urllib.request.quote(sym)}?{params}")
            return d["chart"]["result"][0]
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


def load_symbols():
    with open(os.path.join(DATA, "symbols.json"), encoding="utf-8") as f:
        return json.load(f)


def history():
    cfg = load_symbols()
    out_dir = os.path.join(DATA, "history")
    os.makedirs(out_dir, exist_ok=True)
    now = int(time.time())
    items = [(s["id"], s["yahoo"]) for s in cfg["symbols"]] + [("USDTWD", cfg["fx"]["yahoo"])]
    ok = 0
    for sid, ysym in items:
        try:
            # 抓日線再自己合成週線：每週取最後一個交易日收盤，日期標在該週週一，
            # 這樣台股、美股、匯率的每一週都會對齊（Yahoo 的週線起始日各不相同）
            r = yahoo_chart(ysym, f"period1=946684800&period2={now}&interval=1d&events=div%2Csplit&includeAdjustedClose=true")
            ts = r.get("timestamp") or []
            q = r["indicators"]["quote"][0]
            adj = (r["indicators"].get("adjclose") or [{}])[0].get("adjclose") or q["close"]
            off = r.get("meta", {}).get("gmtoffset") or 0
            dates, closes, raw = [], [], []
            for t, a, c in zip(ts, adj, q["close"]):
                if a is None or c is None:
                    continue
                day = datetime.fromtimestamp(t + off, tz=timezone.utc).date()
                d = (day - timedelta(days=day.weekday())).isoformat()
                if dates and dates[-1] == d:
                    dates.pop(); closes.pop(); raw.pop()
                dates.append(d)
                closes.append(round(a, 4))
                raw.append(round(c, 4))
            if len(dates) < 10:
                raise ValueError("too few rows")
            with open(os.path.join(out_dir, f"{sid}.json"), "w", encoding="utf-8") as f:
                json.dump({"id": sid, "d": dates, "c": closes, "raw": raw}, f, separators=(",", ":"))
            ok += 1
            print(f"history {sid}: {len(dates)} weeks {dates[0]}..{dates[-1]}")
        except Exception as e:  # noqa: BLE001
            print(f"history {sid} FAILED: {e}", file=sys.stderr)
        time.sleep(0.5)
    if ok == 0:
        sys.exit("no history fetched")


def twse_live(ids):
    chans = "|".join(f"tse_{i}.tw" for i in ids)
    d = get_json(f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={chans}&json=1&delay=0")
    out = {}
    for m in d.get("msgArray", []):
        sid = m.get("c")
        prev = float(m["y"]) if m.get("y") not in (None, "-", "") else None
        price = None
        for k in ("z", "pz", "b", "a"):
            v = (m.get(k) or "").split("_")[0]
            if v and v != "-":
                try:
                    price = float(v)
                    break
                except ValueError:
                    pass
        if price is None:
            price = prev
        if sid and price:
            ms = int(m.get("tlong") or 0)
            out[sid] = {"p": price, "prev": prev, "t": ms // 1000 if ms else int(time.time())}
    return out


def live():
    cfg = load_symbols()
    quotes = {}
    tw_ids = [s["id"] for s in cfg["symbols"] if s["market"] == "TW" and not s.get("hidden")]
    try:
        quotes.update(twse_live(tw_ids))
        print(f"twse: {len(quotes)} quotes")
    except Exception as e:  # noqa: BLE001
        print(f"twse FAILED: {e}", file=sys.stderr)
    todo = [(s["id"], s["yahoo"]) for s in cfg["symbols"] if s["id"] not in quotes] + [("USDTWD", cfg["fx"]["yahoo"])]
    for sid, ysym in todo:
        try:
            m = yahoo_chart(ysym, "range=1d&interval=5m")["meta"]
            quotes[sid] = {"p": m["regularMarketPrice"], "prev": m.get("chartPreviousClose") or m.get("previousClose"),
                           "t": m.get("regularMarketTime") or int(time.time())}
        except Exception as e:  # noqa: BLE001
            print(f"yahoo {sid} FAILED: {e}", file=sys.stderr)
        time.sleep(0.3)
    if not quotes:
        sys.exit("no live quotes fetched")
    path = os.path.join(DATA, "live.json")
    # keep the last good quote for anything that failed this round
    try:
        with open(path, encoding="utf-8") as f:
            old = json.load(f).get("quotes", {})
        for k, v in old.items():
            quotes.setdefault(k, v)
    except (OSError, ValueError):
        pass
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"updated": int(time.time()), "quotes": quotes}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"live: {len(quotes)} quotes")


if __name__ == "__main__":
    {"history": history, "live": live}[sys.argv[1] if len(sys.argv) > 1 else "live"]()
