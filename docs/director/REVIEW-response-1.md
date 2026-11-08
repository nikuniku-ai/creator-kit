---
doc: creator-kit/director/2026-11-08/review-response-1
title: REVIEW-codex-1 逐條處置
created: 2026-11-08T10:45:00+09:00
author: claude-opus-5-5（FG 開發線）
follows: REVIEW-codex-1.md
schema_version: 1
---

# REVIEW-codex-1 逐條處置

**TL;DR**：24 條全部處置。採納 21 條（其中 9 條當場修在 P1.2 commit、其餘落在 P2 對應項並各有測試）；部分採納 3 條（B1、B3、M15：客戶端能做的做了，伺服端才做得到的部分降級宣稱並列為 ★核心提案）。沒有「不採納」。

處置欄：**修**＝本 commit 已改且有測試；**P2.x**＝規格已改，實作與測試在該項（未完成前不算處置完）；**降級**＝把宣稱改成實話。

| ID | 處置 | 做了什麼／證據 |
|---|---|---|
| B1 ledger 可偽造 | 部分採納（修＋降級＋核心提案） | 語意層：`adopted` 必指向第一個 passed take、其後無 take、ids 相符（`schemas/examples/invalid/gacha-ledger.sem-adopted-*.json`）；take 存伺服端 `output_sha256`，assemble 比對（P2.6）。SPEC TL;DR 3 與 S10 明寫「ledger／receipt 是本機紀錄，不是驗收證明」。真正的防偽只能在伺服端：只對 passed take 發下載連結＋簽章驗收證明 → SPEC §8 ★提案。客戶端本來就可被改寫，這是事實不是可修的缺陷 |
| B2 原型鏈繞過 | 修 | `Object.hasOwn` 判斷；測試 `B2: inherited names…`、`B2: the real plan schema refuses shots[0].constructor`；反向：改回 `s.properties?.[k]` → 2 紅 |
| B3 預算只在本機 | 部分採納（修＋降級＋核心提案） | 每 take 記 `quoted_units`、`quote_id`，`quoted_total` 須等於總和（語意層）；ledger O_EXCL 鎖（P2.5）；run 帶該次報價為 `max_credits`。SPEC 明寫「單一 ledger 的本機上限，不防其他程序」；專案級原子預留 → §8 ★提案 |
| B4 AC6／AC10 無完整路徑 | 採納（降級） | SPEC §9：AC6、AC10 明列「本次不算通過」；補 AC10 上線後指令。P1.1 的 AC 只宣稱 schema 範例驗證 |
| M1 未知關鍵字只在走到時檢查 | 修 | `checkSchema()` 先走完整份 schema（含未用的 `$defs`）；validate-schemas 也逐份檢查 schema；測試 `M1: unknown keywords anywhere…` |
| M2 `$ref` 同層約束被略過 | 修 | `$ref` 與同層都執行；測試 `M2` |
| M3 範例只掃兩層 | 修 | 遞迴列舉，路徑含 `invalid/` 者必須被拒 |
| M4 授權與 usable_for 無約束 | 修 | 語意層 source 規則（`source.sem-unlicensed-for-generation.json`）；breakdown 新增 `usable_for`、`source_manifest_sha256`，沒給 source 時保守為 analysis_only；`--source` sha256 不符即拒（測試 `M4: …`） |
| M5 抄襲檢查可跳過／短句未定義 | 採納 → P2.2 | SPEC S4：L010 未檢查警告、`similarity.checked`、短句完全相同規則、NFKC；shoot／run 自己跑 lint 且要求 sources（`SOURCES_REQUIRED`）→ P2.4／P2.5 測試 |
| M6 重啟與冪等 | 採納 → P2.5 | SPEC S9 狀態機、原子寫、O_EXCL 鎖、冪等鍵含 workspace／recipe；ledger schema take 欄位 `run_id／job_id` 可為 null。測試：中斷後重跑不重複送出 |
| M7 輪詢停止規則 | 採納 → P2.5 | SPEC S9 完整對應表、`--timeout`、`ACCEPTANCE_TIMEOUT`、`unspecified` 類別；schema 要求 failed 必有 failure_class |
| M8 redirect 與憑證邊界 | 採納 → P2.7 | SPEC §1：一律 `redirect:'manual'`、3xx 當錯誤、下載不帶 key、下載主機規則；測試在 `tests/network.test.mjs` |
| M9 explicit 欄位投影 | 採納 → P2.5 | SPEC S8 白名單；`projectShot()` 測試：explicit 鏡請求不含 action／dialogue／note |
| M10 唯一性與圖約束 | 修 | 語意層：id／order／role 唯一、無自依賴、無環（`plan.sem-duplicate-*`、`plan.sem-dependency-cycle.json`） |
| M11 時間與幾何 | 修 | 語意層：breakdown 區間、EDL 區間／連續／總和、相機退化（`*.sem-reversed-*`、`edl.sem-total.json`、`plan.sem-degenerate-camera.json`） |
| M12 receipt 定位與 verify 範圍 | 採納 → P2.6 | schema 加 `edl_file`、`plan_sha256`；SPEC S10 verify 範圍（bytes、EDL↔takes、take 檔） |
| M13 缺 accept 的錯誤碼 | 修（規格） | SPEC S7：缺鍵＝SCHEMA_INVALID、null＝ACCEPT_REQUIRED，皆 exit 2、0 請求；P2.4 兩者都測 |
| M14 AC11 指令太寬 | 修（規格）→ P2.7 | SPEC §9 AC11 改為 `node --test tests/no-key.test.mjs` 精確斷言 |
| M15 retention 未定義 | 部分採納（降級） | SPEC §10.1：只管本機副本、null 語意、不送伺服端；伺服端保存期限未定（上位文件 §7），不由客戶端宣告 |
| m1 const 鍵序、JSON pointer | 修 | `equal()` 深度比較、`~0`／`~1` 解碼；測試 `m1` |
| m2 布林 schema | 修 | `false` 拒絕一切、`true` 放行；測試 `m2` |
| m3 names 語言不受約束 | 修 | `names` 只允許十四語鍵；語意層要求 plan 語言的名字（`plan.unknown-name-lang.json`、`plan.sem-no-name-in-plan-lang.json`） |
| m4 時間戳與 URL 太寬、url／file 二選一 | 修 | 嚴格 ISO-8601 正則、URL 需主機；語意層 url xor local_file、本機檔需 sha256 |
| m5 passed 與 findings 矛盾 | 修 | 語意層（`lint-report.sem-passed-with-error.json`） |

## 驗證（本 commit）

```bash
node scripts/validate-schemas.mjs        # ok:true，正例 7、反例 23
node --test tests/schemas.test.mjs       # 26 pass
```

反向驗證：分別停用語意規則 cyclic／passed／adopted-first-passed／total_ms 與 B2 的 hasOwn → `tests/schemas.test.mjs` 各 2 紅。
