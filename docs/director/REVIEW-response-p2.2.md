---
doc: creator-kit/director/2026-11-08/review-response-p2.2
title: REVIEW-codex-p2.2 逐條處置
author: claude-opus-5-5（FG 開發線）
follows: REVIEW-codex-p2.2.md
schema_version: 1
---

# REVIEW-codex-p2.2 逐條處置

**TL;DR**：7 條全部採納並修。每條先把審查者的反例寫成測試（`tests/lint-fixtures.test.mjs` 的 `R-p2.2 #n`，修前 6 紅），修後全綠；每個新守衛做了突變（刪掉即紅）。審查者回報的 `EPERM`／92 秒未結束是 Codex 沙箱無法寫暫存目錄，本機 `npm test` 正常結束（見下）。

| # | 嚴重度 | 處置 | 測試／突變 |
|---|---|---|---|
| 1 | blocker | 採納：分詞改為逐片段（CJK 每字、其餘為詞），英文抄句加一個漢字仍判 L004 | `R-p2.2 #1`；突變：回到整句切換 → 紅 |
| 2 | major | 採納：L002 同時看 `characters` 與 `dialogue[].speaker`，同鏡同角色一次 | `R-p2.2 #2`；刪 speaker 分支 → 1 紅 |
| 3 | major | 採納：L005 檢查每次切換場景（含回到舊場景） | `R-p2.2 #3`；改回 `seen` → 紅 |
| 4 | major | 採納：骨架 action／hook 改中性佔位，不帶 description／hook 原文 | `R-p2.2 #4 #7`；hook 改回原文 → 2 紅 |
| 5 | major | 採納：`lint()` 沒有 `sourceSha256s` 一律 `checked:false`；改了兩個把舊行為寫死的測試 | `R-p2.2 #5`；放寬回去 → 1 紅 |
| 6 | major | 採納：findings 上限 10000，error 優先、`L011_FINDINGS_TRUNCATED` 註明省略數；CLI 輸出前以 schema＋語意層驗報告 | `R-p2.2 #6`；拿掉 cap → 1 紅、拿掉 error 優先 → 1 紅 |
| 7 | minor | 採納：hook 時間以 clamp 後的 `duration_ms` 累加 | `R-p2.2 #4 #7`；改回原始時長 → 1 紅 |
