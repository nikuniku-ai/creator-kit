---
doc: creator-kit/director/2026-11-08/review-verifier-p2.5
title: 獨立 verifier 驗收 P2.4＋P2.5（shoot，commit b682ae0）與處置
author: claude-opus-5-5（FG 開發線）；verifier 為獨立子 agent（只拿 AC 與產物，effort xhigh）
schema_version: 1
---

# 獨立 verifier 驗收 b682ae0 與處置

**TL;DR**：verifier 回報 7 項 AC 中 5 PASS／2 FAIL，另列 7 個缺陷。以下「verifier 聲稱」欄是它的報告摘要（它的原始輸出在它的暫存目錄，未全文覆核）；兩個 FAIL 我已在本機第一手重現（`repro.mjs`：預算重送 `exit 0 runs 2 quoted_total 40 max 0`；65 字 route 記成 `null`），其餘每條都先寫成會紅的測試再修（`tests/gacha.test.mjs` V1–V7、`tests/network.test.mjs`），修後全綠，每個修正做突變（14＋1 個全紅）。

| # | verifier 聲稱 | 我的重現 | 處置 | 測試 |
|---|---|---|---|---|
| FAIL1 | 預算：重啟調低 `--max-credits`，run_id 為 null 的 take 重送不檢查上限，exit 0 | 重現 | 修：resend 也受上限約束 → `budget_stopped` exit 4 | V1 |
| FAIL2 | AC6：route > 64 UTF-16 單位被換成 null、無提示；33 個 emoji（合法）也被丟 | 重現 | 修：以 code point 計；超長 route 令該 take `unavailable`（fail closed，不靜默改寫） | V2 |
| 缺陷 2 | `judge` 無 sha 的 pass、net.mjs 主機／sha／轉址守衛沒有測試守 | 測試補上後原本就綠（行為正確、只是沒人守） | 補測試；突變全紅 | V3、network |
| 缺陷 3 | ledger 未綁 recipe：重啟換 `--recipe`，舊 take 被送到新配方 | 測試先紅 | 修：每個既有 take 的冪等鍵必須等於以目前 workspace／recipe 重算者，否則 `LEDGER_MISMATCH` | V4 |
| 缺陷 4 | Ctrl-C 後殘留鎖，重啟被擋 | 測試先紅 | 修：鎖內 pid 已不存在 → 接手；SIGINT／SIGTERM 時清鎖（exit 130／143） | V5 ×2 |
| 缺陷 5 | 伺服端回壞 job_id／null 快照 → exit 2（違反「exit 2＝沒送請求」）並卡死 | 測試先紅 | 修：伺服端給的 id／快照不合法 → `INVALID_RESPONSE` exit 1，ledger 不寫壞值 | V6 |
| 缺陷 6 | 錯誤互相遮蔽；預算訊息只說單次報價 | 測試先紅 | 修：exit 依最嚴重者，訊息列出全部（`also <CODE>: …`）；預算訊息寫「已報價 + 本次 > 上限」 | V7 |
| 缺陷 7 | ledger 在取鎖前讀入（競態窗口，verifier 未重現） | 未重現（只讀程式） | 改為取鎖後才讀；**沒有能證明它生效的測試**，不宣稱已防住競態 | — |
| 連接埠 | `linkAllowed` 只比 hostname | 測試先紅 | 修：同主機＝hostname＋port；`*.nikuniku.ai` 只收預設埠 | network |
