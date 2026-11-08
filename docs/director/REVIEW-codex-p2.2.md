---
doc: creator-kit/director/2026-11-08/review-codex-p2.2
title: Codex 對抗審查 P2.2（diff ee380b5..a446251）
author: codex-cli 0.167.0（FG 帳號），原文未改
followed_by: REVIEW-response-p2.2.md
schema_version: 1
---

> 指令：`codex exec --skip-git-repo-check -C ~/Projects/creator-kit "<只含 AC3/AC4、附加宣稱與產物路徑>"`，exit 0。以下為 stdout 原文。

審查結論：**1 blocker、5 major、1 minor**。未修改任何檔案；反例均在記憶體建立，輸入皆通過對應 schema 與 semantics。下述 exit 為實際 `runDirector()` 回傳值，CLI 直接將其設為程序退出碼。

**blocker**

1. **L004 可用單一中文字繞過完整英文抄句檢查。**  
   位置：[lint.mjs:16](/Users/FG/Projects/creator-kit/director/lint.mjs:16)  
   實測反例：原片台詞為 `I finally found you at the station tonight`，改編只在尾端加 ` 中`。提供正確 source 與 sha256 後，仍回報 `similarity:{max:0,checked:true}`、無 L004、exit 0。任一中文字會使整句從英文詞級切換成字元級，兩邊無法比對。  
   建議修法：以一致的混合語言分詞處理雙方，避免整句模式被單一字元切換；補上英文抄句附加 CJK 的拒絕測試。

**major**

2. **L002 漏查提前說話的人物。**  
   位置：[lint.mjs:37](/Users/FG/Projects/creator-kit/director/lint.mjs:37)  
   實測反例：沿用 A＋B example，將 `s1.dialogue[0].speaker` 改為 `jun`；其 `first_scene` 仍為 `sc2`，且不加入 `s1.characters`。結果 L002 為 **0 次**、exit 0。  
   建議修法：每鏡合併 `characters` 與非 null 的 `dialogue[].speaker` 後去重，再檢查入場；同一角色同鏡只報一次。

3. **L005 跳過曾出現的場景，漏報時間倒退。**  
   位置：[lint.mjs:59](/Users/FG/Projects/creator-kit/director/lint.mjs:59)  
   實測反例：在 example 後追加 `s3`，複製 `s1` 並設定唯一 id/order，形成 `sc1(0) → sc2(30) → sc1(0)`，全部 `flashback:false`。結果 L005 為 **0 次**、exit 0。  
   建議修法：按鏡頭順序檢查每次場景切換；移除跨全片的 `seen` 排除，保留連續同場景的去重。

4. **骨架透過 action／hook 搬入原片人物、道具與台詞。**  
   位置：[plan.mjs:32](/Users/FG/Projects/creator-kit/director/plan.mjs:32)、[plan.mjs:36](/Users/FG/Projects/creator-kit/director/plan.mjs:36)  
   實測反例：合法 breakdown 的 description 設為 `原角阿明拿原道具銀鑰匙說「你終於來了。」`，hook 設為 `你終於來了。`。產出 plan 原樣保留於 action 與 `bible.hooks[].text`，且 lint 無 L004。空的角色／道具／台詞陣列無法保證「不搬內容」。  
   建議修法：骨架使用中性 action 與 hook 佔位文字，只保留位置及結構；補測原片內容出現在 description／hook 的情況。

5. **公開 `lint()` 未驗證 hash 仍宣告 checked。**  
   位置：[lint.mjs:73](/Users/FG/Projects/creator-kit/director/lint.mjs:73)、[lint-fixtures.test.mjs:100](/Users/FG/Projects/creator-kit/tests/lint-fixtures.test.mjs:100)  
   實測反例：`lint(base(), {sources:[source,{...source,source_id:'src-b'}]})` 未傳 `sourceSha256s`；兩份實際 hash 均不等於 plan 的佔位 hash，卻得到 `checked:true`。目前測試甚至要求此結果。  
   建議修法：缺少可驗證 hash 時維持 false；讓呼叫者提供原始 bytes，由 lint 計算 hash。**CLI 路徑有核對 hash，本項限公開函式與附加宣稱。**

6. **合法 plan 可產生不符合 lint-report schema 的報告。**  
   位置：[lint.mjs:97](/Users/FG/Projects/creator-kit/director/lint.mjs:97)、[lint.mjs:108](/Users/FG/Projects/creator-kit/director/lint.mjs:108)  
   實測反例：合法 plan 含 313 鏡，每鏡 32 筆台詞均使用未定義 speaker `ghost`。結果 exit 3，但共產生 **10,017 findings**，報告驗證失敗：`$.findings — more than 10000 items`。  
   建議修法：定義可符合 schema 的彙整／截斷機制並明示省略數量，或調整報告 schema；輸出前驗證報告。

**minor**

7. **hook 使用原始時長累加，與產出 plan 時間軸不一致。**  
   位置：[plan.mjs:31](/Users/FG/Projects/creator-kit/director/plan.mjs:31)  
   實測反例：第一鏡為 0.1 秒，下一鏡帶 hook。第一鏡輸出被 clamp 成 `duration_ms:500`，hook 卻仍為 `at_s:0.1`，應為 `0.5`。  
   建議修法：用實際輸出的 `duration_ms / 1000` 累加 hook 時間。

驗收狀態：

- 記憶體重驗：兩種 A＋B merge 均通過 schema；原有三錯誤 fixture 各報一次、exit 3；en／ja／zh-Hant 的 stdout 與 stderr 第一行完全一致。L003 未找到獨立反例。
- `node --test tests/lint-fixtures.test.mjs`：16 通過、4 因暫存目錄 `EPERM` 失敗。
- `npm test`：schema 階段通過；測試階段出現相同權限失敗，約 92 秒未結束後中止，未完成全套驗收。
