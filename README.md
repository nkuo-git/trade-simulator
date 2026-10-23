# 小小操盤手 📈

給國中生的模擬股票交易網頁遊戲（台股＋美股，繁體中文）。純靜態網頁，部署在 GitHub Pages，進度存在瀏覽器。

## 功能
- **時光機挑戰**：回到 2000 網路泡沫、2008 金融海嘯、2020 疫情崩盤、2022 升息熊市、AI 熱潮等真實歷史，一週一週往前走
- **新聞事件卡**：重大事件發生時跳出，先預測漲跌，挑戰結束後對答案
- **分階段課程**：股票 → 分散與 ETF → 複利 → 手續費與稅 → 停損 → 泡沫心理，答對測驗才解鎖新功能
- **交易理由必填**：每筆買賣都要寫原因，挑戰結束後到「日記」回顧當初對不對
- **對手是定期定額 0050**：隨時比較自己和「每月固定買 0050」的成績
- **即時模式**：用約延遲 15 分鐘的真實報價練習
- **排行榜、徽章、家長專區**（可設密碼、看孩子的交易理由、匯出匯入進度）

## 家長和小孩用不同手機（Firebase 同步）
1. 在 [Firebase 主控台](https://console.firebase.google.com) 建專案，新增「網頁」應用程式，把 `firebaseConfig` 貼進 `js/firebase-config.js`
2. 建立 Firestore 資料庫（asia-east1），規則貼上 `firestore.rules`
3. 第一次打開 App 會問身分：家長「建立家庭」拿到 6 碼家庭代碼，小孩輸入代碼加入。家長手機可以看全家進度、解鎖功能、改起始資金

`firebase-config.js` 是 `null` 時，App 只在單機使用（家長專區用同一台手機的密碼保護）。

## 資料
`.github/workflows/deploy.yml` 用 GitHub Actions 執行 `scripts/fetch_data.py`：
- 盤中每 15 分鐘抓台股（證交所）與美股（Yahoo Finance）報價 → `data/live.json`
- 每週更新 2000 年以來的週收盤價（含股利還原）→ `data/history/*.json`

要新增股票，編輯 `data/symbols.json`，再到 Actions 手動執行一次並勾選「重新抓歷史資料」。

## 本機測試
```
python3 scripts/fetch_data.py history && python3 scripts/fetch_data.py live
python3 -m http.server
```
