---
doc: creator-kit/director/2026-11-08/review-codex-1
title: Codex 對抗審查第 1 輪（SPEC＋schemas＋validator @ c7d3491）
created: 2026-11-08T10:05:00+09:00
author: codex-cli 0.167.0（FG 帳號），原文未改
follows: SPEC.md
followed_by: REVIEW-response-1.md
schema_version: 1
---

> 指令：`codex exec --skip-git-repo-check -C ~/Projects/creator-kit "<只含 AC 與產物路徑的審查指示>"`，exit 0。以下為 stdout 原文。

指定指令 `node scripts/validate-schemas.mjs` 實跑 exit 0：7 個正例通過、8 個反例遭拒。以下反例均只在記憶體內建立，未修改任何檔案。「驗證通過」指 `validate()` 回傳 `[]`，不代表已驗證未納入本次範圍的執行模組。

## blocker

### B1．本機 ledger 可偽造伺服端採用結果，receipt 無法證明驗收來源

- **位置：** `docs/director/SPEC.md:19、145、157–159`；`schemas/gacha-ledger.schema.json:59–155`；`schemas/qa-receipt.schema.json:39–64`。
- **問題：** assemble 依本機 ledger 的 `status:"adopted"` 放行；重跑亦讀既有 take。但 ledger 沒有伺服端簽章、驗收證明或媒體 sha256 欄位，receipt 的 `verdict:"passed"` 只是可自行填寫的常數。實測將所有 take 改成 `failed`，保留 adopted，仍通過；清空 `takes` 並令 `adopted.take=999` 亦通過。自行修改媒體及所有雜湊，仍能滿足文字定義的自洽檢查，無法保證「客戶端永不採用未通過 take」。
- **建議修法：** 由伺服端簽發綁定 workspace、plan hash、shot、run、take、媒體 hash、accept 規格版本與 verdict 的證明；離線 assemble 驗簽，或連線重新查證。另加 ledger 關聯驗證，要求 adopted 精確指向第一個 passed take。

### B2．`additionalProperties:false` 可被原型鏈欄位繞過

- **位置：** `director/jsonschema.mjs:37–40`；`schemas/plan.schema.json:409–410`。
- **問題：** `s.properties?.[k]` 會取得繼承屬性，將 `constructor`、`__proto__`、`toString` 等誤認為已宣告欄位。實測在正例加入 `shots[0].constructor={provider:"external",model:"x"}`，驗證仍通過。這已破壞封閉 schema；下游若直接傳送或合併該物件，禁止額外參數的保障即失效。
- **建議修法：** 以 `Object.hasOwn(s.properties,k)` 判斷；同樣檢查 `$ref` 路徑的 own property。加入上述欄位在各層被拒的反例。

### B3．預算只有可修改的本機累計，沒有可落實的伺服端總額上限

- **位置：** `docs/director/SPEC.md:144–153、223–224`；`schemas/gacha-ledger.schema.json:24–39、104–153`。
- **問題：** 契約未要求 run 綁定特定 quote、有效期、輸入 hash 或 recipe 版本；亦未規定跨程序、CLI／MCP 的原子預留。兩個程序可同時讀到相同餘額，各自通過檢查而超支。ledger 只有可改寫的 `quoted_total`，每 take 沒有報價／預留金額，無法重建累計。逐次 `max_credits` 不能證明整個 project 的上限。
- **建議修法：** 由伺服端提供具範圍的 budget reservation，原子檢查總額；run 必須引用不可變 quote。ledger 記錄每筆 quote、reservation 與結算，重啟時向伺服端對帳；加入並行提交及崩潰恢復測試。

### B4．AC6／AC10 缺少完整驗收路徑，不能宣告全部 AC 已滿足

- **位置：** `docs/director/SPEC.md:20–21、140、240–241、255–262、275`。
- **問題：** 真 API 的 acceptance／route 尚不存在；AC6 被縮成「把 mock 回傳字串寫入 ledger」，不能證明伺服端確實判級、路由且不可降級。AC10 只有依賴及手冊占位，沒有一句驗收指令、輸入或成功判準，§9.1 亦缺 AC10。
- **建議修法：** 保留為未通過驗收項；補 staging 指令及可機器判斷的結果，驗證 general 宣告遭伺服端判為 explicit、實際路由與驗收結果。P1.1 的 schema 指令成功不能代替這些證據。

## major

### M1．「未知關鍵字載入時拒絕」實際是依資料路徑才檢查

- **位置：** `director/jsonschema.mjs:4–5、13–17、33、39、46`；`scripts/validate-schemas.mjs:12、19`。
- **問題：** 沒有 schema 載入檢查；空陣列、缺少的選填欄位、未走到的 `$defs` 都不會檢查。實測在真實 plan schema 的 `accept.checks[].note` 加入未支援的 `format`，令 accept 全為 null，仍通過。拼錯或新增的安全約束可以靜默失效。
- **建議修法：** 在讀取 schema 後，獨立遞迴檢查所有 schema 節點、關鍵字參數、正則及引用，不依賴範例是否走到。

### M2．遇到 `$ref` 即 return，忽略同層限制

- **位置：** `director/jsonschema.mjs:16`；所有 schema 的 `$schema` 欄位。
- **問題：** schema 宣告 draft 2020-12，但 `{$ref:"#/$defs/x",maxLength:1}` 只驗引用目標。實測引用 string 後輸入 `"long"` 通過。往引用欄位加額外限制，會呈現「寫了但不執行」。
- **建議修法：** 引用目標與同層約束都必須執行；若刻意採較小子集，載入時明確拒絕 `$ref` 搭配約束。

### M3．範例驗證沒有涵蓋 `examples/**`

- **位置：** `scripts/validate-schemas.mjs:15–16`；`docs/director/SPEC.md:86`。
- **問題：** 只掃 `examples/` 和 `examples/invalid/` 兩層的直接 `.json` 檔。任何更深層正反例皆被靜默忽略，不能支撐「全部 schema 範例已驗過」。
- **建議修法：** 遞迴列舉全部 JSON，明確定義 invalid 子樹；輸出完整相對路徑及覆蓋數量。

### M4．授權狀態與 `usable_for` 沒有契約約束，往下游亦無法追溯

- **位置：** `docs/director/SPEC.md:49、93、104`；`schemas/source.schema.json:70–109`；`schemas/breakdown.schema.json:7–15`；`schemas/plan.schema.json:44–78`。
- **問題：** 實測 `rights.status:"unlicensed_reference"` 配 `usable_for:"generation"` 通過。breakdown 不帶 rights 或 source manifest hash；`plan` 又只接 breakdown，規格未交代如何可靠取得所稱的 `usable_for`。下游無法重建或驗證授權狀態。
- **建議修法：** 增加跨欄位語意驗證；breakdown 綁定 source manifest，plan 保存可追溯引用，拒絕降級或遺失 provenance。

### M5．AC4 的抄襲檢查可跳過，短台詞的判準亦未定義

- **位置：** `docs/director/SPEC.md:109、117、124、143–144、162`。
- **問題：** lint 的原片輸入是選填；`shoot` 未要求先 lint，只有 `run` 要求。即使執行 lint，少於三個字元／詞的逐字抄錄沒有 3-gram，包含率分母與判定未定義；`--threshold` 亦無有效範圍。不能保證所述「擋台詞抄襲」。
- **建議修法：** 對來源缺失明確報「未檢查」，不得報通過；生成入口要求與 plan/source hash 綁定的檢查結果。補短句完全相同、Unicode 正規化及門檻邊界規則。

### M6．重啟與 idempotency 缺少可恢復狀態

- **位置：** `docs/director/SPEC.md:144–145、153`；`schemas/gacha-ledger.schema.json:59–67、104–123`。
- **問題：** 沒有 defined 的 write-ahead／原子寫入流程；run 成功後、ledger 寫入前崩潰，如何找回未明。take 強制已有 `job_id`，shot 卻沒有 in-flight 狀態；無法清楚表達「已預留、已送出、尚未取得 job」。idempotency key 也不含 workspace、recipe 或後端範圍，這些變更的行為未定義。
- **建議修法：** 定義持久化狀態機、伺服端查回機制及冪等鍵作用域；測試提交前後各崩潰點、workspace 切換和並行重跑。

### M7．輪詢遇到失敗終態或延遲驗收，沒有確定停止規則

- **位置：** `docs/director/SPEC.md:144、150–151、241`；`schemas/gacha-ledger.schema.json:125–145`。
- **問題：** 一處要求輪詢到「終態且 verdict 為 passed／failed」，另一處要求快照沒 acceptance 就立即停。排隊快照尚無 acceptance 時應等或停不明；取消、執行失敗、unknown verdict、永久 pending、缺 route 亦無時限與行為。`failed` 可以配 null／空 `failure_class`，三次同類失敗如何計數未定義。
- **建議修法：** 列出 run／acceptance 的完整狀態轉移、timeout、未知值 fail-closed 規則及穩定 failure code；區分暫缺與終態不支援。

### M8．主機白名單未定義 redirect 與憑證的信任邊界

- **位置：** `docs/director/SPEC.md:47、201–202、270`。
- **問題：** 任意 https `NIKUNIKU_API_BASE` 都可能成為允許主機；下載亦接受整個 `*.nikuniku.ai`。未規定逐次 redirect 驗證、跨 origin 是否轉送 API key、簽名 URL 是否需要認證，以及 loopback 例外的限制。只測最終輸出 URL 指向外站不足以覆蓋這些洩漏路徑。
- **建議修法：** 明定可信 API origin 與下載 origin；每跳重新驗證，下載不攜帶 API key，禁止跨 origin 憑證轉送，補 redirect 鏈與自訂 base 測試。

### M9．explicit 請求的欄位投影沒有定義

- **位置：** `docs/director/SPEC.md:50、105、139、144`；`schemas/plan.schema.json` 的 `shots[].action`、`dialogue`、`accept.checks[].note`、`recipe_id`。
- **問題：** 「只送鏡頭代號與結構欄位」沒有具體 allowlist，傳輸契約卻只寫 `shot_json`。哪些文字剔除、伺服端起草結果如何引用均未定義。general 宣告經伺服端改判 explicit 時，原文字已送出，又該如何處理也未交代；客戶端可選 recipe 是否受伺服端分級覆核亦不明。
- **建議修法：** 定義獨立請求 schema 與明確欄位投影；由伺服端強制 recipe／route 相容性，補所有自由文字欄位與重新判級的反例。

### M10．ID、順序及依賴沒有唯一性與圖約束

- **位置：** `schemas/plan.schema.json` 的 `sources[].role`、各 `id`、`shots[].order`、`continue_from`、`dependencies`；`docs/director/SPEC.md:114–122、145`。
- **問題：** 實測重複 shot ID 與 order 通過。重複 shot ID 會共用冪等鍵及下載檔名；L009 只檢查目標存在，未禁止循環、自我依賴或指向未生成的後續鏡。兩個 A role 也使 `source_revision` 排序不唯一。
- **建議修法：** 增加 plan 語意驗證：ID／role／order 唯一、引用存在、依賴圖無環，並定義生成與剪輯的排序規則。

### M11．時間與幾何欄位允許不可執行資料

- **位置：** `schemas/breakdown.schema.json:56–59、92–105`；`schemas/edl.schema.json:20–22、55–65`；`schemas/plan.schema.json:478–502`。
- **問題：** 實測 breakdown 的 `start_s=100,end_s=0` 通過；EDL 的 `in_ms=999999,out_ms=1,total_ms=0` 也通過。未要求鏡段落在來源時長內、record timeline 連續、total 等於加總。相機亦允許 position 等於 look_at，前向單位向量無法定義。
- **建議修法：** schema 後加語意檢查，拒絕反向／越界區間、錯誤加總及退化相機，並加入反例。

### M12．receipt 沒有足夠的定位資訊，verify 範圍亦小於宣稱

- **位置：** `docs/director/SPEC.md:156–159`；`schemas/qa-receipt.schema.json:7–15、36–64`。
- **問題：** `--verify` 只收 receipt，但 receipt 沒有 EDL 路徑；搬動目錄後如何找 EDL 未定義。文字只要求重算成片與 EDL，沒有要求檢查 take 檔、`output_bytes` 或 receipt 的 takes 與 EDL 一致；修改 receipt 中的 job／take 敘述不影響上述兩個 hash。
- **建議修法：** 定義相對路徑基準，加入 EDL 定位欄位或必填參數；verify 檢查大小、全部關聯、take hash 與 B1 的驗收證明。

### M13．AC5「缺 accept」的錯誤碼與 schema 流程衝突

- **位置：** `docs/director/SPEC.md:136、199、203、274`；`schemas/plan.schema.json:411–424`；`schemas/examples/invalid/plan.accept-key-absent.json:1`。
- **問題：** AC5 要求缺少 accept 回 `ACCEPT_REQUIRED`，但 schema 已將缺 key 判為無效；一般先驗 schema 的實作會回 `SCHEMA_INVALID`。只有 null 能走到 accept 守衛，缺 key 的要求沒有明定優先序。
- **建議修法：** 明定缺 key／null 的統一 preflight 與錯誤優先序；CLI、run、MCP 都測相同結果及零請求。

### M14．AC11 的一句驗收指令會把任何失敗當成功

- **位置：** `docs/director/SPEC.md:259、279`。
- **問題：** `NIKUNIKU_API_KEY= ... run plan.json; test $? -ne 0` 只能證明非零退出。檔案不存在、語法錯誤、程式崩潰都能通過，亦不能證明 `API_KEY_REQUIRED`、零網路請求或其他有／無 key 指令的行為。
- **建議修法：** 改為完整測試入口，使用有效 fixture，精確斷言 exit、JSON error code、請求數，涵蓋 §9.1 列出的全部指令。

### M15．retention 是未定義、未傳送也未驗證的隱私設定

- **位置：** `schemas/plan.schema.json:745–759`；`docs/director/SPEC.md:144、153、158`。
- **問題：** `keep_takes_days` 可填 null，卻沒有 null 的意義、起算點、刪除對象或責任方。S9 請求只列 shot_json／plan hash／take，未說 retention 如何送往伺服端；亦未涵蓋失敗 take、上傳素材、衍生檔及本機副本。
- **建議修法：** 明定保存範圍與 null 語意，讓伺服端回傳實際採用的 retention／expires_at，並提供可驗證的清除流程。

## minor

### m1．JSON Schema 相等及 `$ref` 路徑解析有錯誤

- **位置：** `director/jsonschema.mjs:11、18–19`。
- **問題：** `JSON.stringify` 比較使物件鍵序影響 const／enum；實測 `{a:1,b:2}` 與 `{b:2,a:1}` 被判不同。引用亦未解碼 JSON Pointer 的 `~1`／`~0`，合法 `#/$defs/a~1b` 被判 unresolved。目前範例未覆蓋。
- **建議修法：** 實作 JSON 值深度相等及正確 JSON Pointer 解碼，補獨立驗證器測例。

### m2．布林 schema `false` 被視為允許所有值

- **位置：** `director/jsonschema.mjs:13–17、46`。
- **問題：** 實測 `validate(false,"anything")` 回 `[]`。即使布林 schema 不屬預定子集，也應拒絕載入，不能讓明確的拒絕規則變成允許。
- **建議修法：** 正確處理 true／false，或在 schema 載入階段拒絕。

### m3．角色名字語言不受十四語清單約束

- **位置：** `schemas/plan.schema.json:153–160`；`docs/director/SPEC.md:84、121`。
- **問題：** `names:{}`、`names:{xx:"x"}` 均合法；實測後者通過。缺少 plan／台詞語言的名字時，L008 的一致性判準沒有定義。
- **建議修法：** 限制 names 的鍵，要求必要語言的名字，並定義缺少譯名的錯誤行為。

### m4．時間戳與來源輸入的基本形狀過寬

- **位置：** `schemas/source.schema.json:27–50、110–112`；`schemas/qa-receipt.schema.json:68–70`。
- **問題：** 日期正則接受 `2026-99-99Tgarbage`；URL 正則接受僅有 `https://`。source 的 url／local_file 可同時為 null，亦可同時存在，與 S1 的二選一輸入不一致；本機檔存在時也不強制 sha256。
- **建議修法：** 嚴格解析時間與 URL；加入來源二選一及本機檔 hash 的語意驗證。

### m5．lint report 的 `passed` 可與 findings 矛盾

- **位置：** `schemas/lint-report.schema.json:21–23、48–113`。
- **問題：** 實測保留 `passed:true` 並加入 severity error，仍通過。讀取 passed 的工具與讀取 findings 的工具可得到相反結論。
- **建議修法：** 將 passed 定義為衍生值，驗證它必須等於「沒有 error finding」，並補矛盾反例。
