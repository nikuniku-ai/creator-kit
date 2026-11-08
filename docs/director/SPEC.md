---
doc: creator-kit/director/2026-11-08/spec
title: nikuniku director kit — 爆款／短劇復刻導演工作台 規格（S1–S10、CLI、MCP、錯誤碼、十四語、AC 對應）
created: 2026-11-08T10:05:00+09:00
updated: 2026-11-08T10:40:00+09:00（依 REVIEW-codex-1 修訂，見 REVIEW-response-1.md）
author: claude-opus-5-5（FG 開發線，kkdeMac-mini / FG）
follows: fg-lane-docs/viral-remake/REQUIREMENTS.md（Studio 分支 claude/fg-recipe-test-lane @ 2bf8fdeb 副本）
followed_by: docs/director/REVIEW-codex-1.md
trigger: PLAN P1.1
language: zh-Hant primary, code/keywords in English
schema_version: 1
---

# 導演工作台規格（director kit）

**TL;DR**
1. 公開客戶端只做「準備」：拆片（本機 ffmpeg）、改編計畫骨架、邏輯 lint、白膜 SVG、EDL 拼接、QaReceipt。**產出媒體與驗收判定一律經 nikuniku `/v1`**；沒有 API key 只能準備，不能出片。
2. 一個 project 一份 `plan.json`（欄位沿用 `11-agent-engineering-and-integrations.md` §6），bible／screenplay／gaps／layout／shot list 都是它的分段，不另立平行格式。
3. 每鏡在生成前就寫好 `accept`；`shoot` 沒有 `accept` 的鏡**不送出**；採用與否只看伺服端回的 `acceptance.verdict`，本客戶端的程式不採用未通過的 take（`tests/gacha.test.mjs` 守）。**但 ledger 與 QaReceipt 是本機紀錄，使用者可以改；它們不是伺服端驗收的證明**。能防偽的只有伺服端：只對通過的 take 發下載連結、並簽發驗收證明（§8 ★提案）。
4. 伺服端驗收欄位（`acceptance`、`route`）是**對核心的提案**（CORE-ASKS C2/C4），目前只在 mock `/v1` 存在；真 API 沒有這兩欄時，`shoot` 一律停在 `ACCEPTANCE_UNAVAILABLE`（不採用、不猜）。
5. 驗收：`npm test`（AC1–AC5、AC7–AC9、AC11–AC13，AC6 只含客戶端半）＋ `node scripts/validate-schemas.mjs`。**AC6、AC10：等待核心**（C1–C4 未上線、無 staging key），本客戶端無法驗，不列為通過；上線後在 staging 重跑（§9）。

## 0. 狀態表

| ID | severity | status | owner | blocker_for | summary |
|---|---|---|---|---|---|
| [DK-S1](#s1-找爆款) | p1 | spec | claude | — | source.json＋授權狀態 |
| [DK-S2](#s2-看片拆解) | p1 | spec | claude | AC2 | ffmpeg 切鏡＋關鍵幀＋SRT 匯入 |
| [DK-S3](#s3-改編計畫) | p1 | spec | claude | AC3 | A(+B) 合併成 plan 骨架 |
| [DK-S4](#s4-邏輯自檢) | p1 | spec | claude | AC3 AC4 | lint L001–L008 |
| [DK-S6](#s6-白膜) | p2 | spec | claude | — | SVG 投影 |
| [DK-S7](#s7-分鏡與每鏡驗收規格) | blocker | spec | claude | AC5 | accept 必填才送 |
| [DK-S8](#s8-分流) | blocker | needs_core | studio | AC6 | 伺服端判級（C2） |
| [DK-S9](#s9-生成與抽卡) | blocker | spec+needs_core | claude/studio | AC7 | 抽卡規則（判定需 C4） |
| [DK-S10](#s10-拼接) | p1 | spec | claude | AC8 | EDL＋QaReceipt |

```bash
grep -hE "^\| \[DK-" docs/director/SPEC.md | grep -E "spec|needs_core"
```

## 1. 邊界：開放客戶端、封閉引擎

| 在 creator-kit（公開） | 只在 nikuniku 伺服端 |
|---|---|
| `director/*.mjs`、`schemas/*.schema.json`、CLI 子指令、MCP 工具、locale 檔 | 影片模型、配方參數、**每鏡驗收判定**、分級與路由、起草、帳本與計費 |

- 客戶端唯一的對外主機是 `NIKUNIKU_API_BASE`（預設 `https://api.nikuniku.ai`；https，只有 loopback 可用 http，沿用既有 `apiBase()`）。成片下載的簽名連結只接受：與 API 同主機且同連接埠，或 API 為 `*.nikuniku.ai` 時的 `*.nikuniku.ai`（https、預設埠）。其他主機一律 `HOST_REFUSED`，什麼都不寫（AC1）。
- 所有請求 `redirect:'manual'`：任何 3xx 都不跟隨、當錯誤處理（不會把 key 帶到別處）；下載簽名連結**不帶** API key。
- 不送任何 provider 參數；`plan.provider_constraints.via` 只能是 `nikuniku_v1`（schema `const`）。
- 參考片：只做結構復刻（節奏、鏡頭語法、鉤子位置），不重用原片畫面與台詞。`source.rights.status ∈ {unlicensed_reference, unknown}` 的來源 `usable_for` 必為 `analysis_only`；lint L004 擋台詞抄襲。**著作權判斷需律師覆核／Yves 決定（REQUIREMENTS D4）**，本工具不宣稱合規。
- 成人內容：一般套件不含成人主機或成人工具（AC13）。`rating:"explicit"` 的鏡，客戶端只送鏡頭代號與結構欄位，露骨描述由伺服端起草（REQUIREMENTS §1.4）；客戶端宣告的 `rating` 只是建議，伺服端判定為準（C2）。

### 1.1 檔案配置

```
director/          實作（node 標準庫；唯一外部依賴仍是既有 @modelcontextprotocol/server）
  jsonschema.mjs   schema 子集驗證器
  source.mjs S1   breakdown.mjs S2   plan.mjs S3   lint.mjs S4   whitebox.mjs S6
  shoot.mjs        S7–S9（含純函式 decide／judge／projectShot）   assemble.mjs S10   run.mjs   mv.mjs  MV 打包
  net.mjs          take 下載主機白名單   semantics.mjs 語意層   i18n.mjs  訊息   cli.mjs  子指令進入點   mcp-tools.mjs  MCP 工具＋成人守衛
schemas/           *.schema.json、examples/、examples/invalid/
scripts/validate-schemas.mjs
locales/director/<lang>.json   十四語
tests/*.test.mjs   tests/mock-api.mjs（擴充）
```

`cli/nikuniku.mjs` 與 `mcp/nikuniku-mcp.mjs` 是從核心 `integrations/` 匯出的檔案（`SOURCE.md`）。本工作只在兩檔各加**最小掛載點**（把 director 子指令／工具轉給 `director/`），其餘邏輯全在 `director/`，以便核心同步（CORE-ASKS C6）時衝突最小。

## 2. 資料契約（每階段一份 JSON；`schema_version:1`；上游以 sha256 綁定）

| 檔案 | schema | 階段 | 上游綁定 |
|---|---|---|---|
| `source.json` | `schemas/source.schema.json` | S1 | 本機檔 sha256（有檔時） |
| `breakdown.json` | `schemas/breakdown.schema.json` | S2 | `source_sha256` |
| `plan.json` | `schemas/plan.schema.json` | S3/S5/S6/S7 | `source_revision`＝各 breakdown sha256 依 role 排序後的 sha256；`sources[].breakdown_sha256` |
| `lint-report.json` | `schemas/lint-report.schema.json` | S4 | `plan_sha256` |
| `gacha-ledger.json` | `schemas/gacha-ledger.schema.json` | S9 | `plan_sha256` |
| `edl.json` | `schemas/edl.schema.json` | S10 | `plan_sha256`、每段 `sha256` |
| `qa-receipt.json` | `schemas/qa-receipt.schema.json` | S10 | `output_sha256`、`edl_sha256` |

`plan_sha256` 一律是檔案原始 bytes 的 sha256（不做正規化，改一個 byte 就換一個值）。

**plan 最小欄位**（§6 沿用）：`schema_version, project_id, revision, source_revision, characters, scenes, audio_refs, shots, dependencies, provider_constraints, budget, retention`；本規格加 `lang, sources, bible, props, gaps`。

**語言**：`plan.lang` 是劇本語言；每句台詞自帶 `lang`；角色名以 `names:{<lang>:<name>}` 存多語。其餘自由文字欄位跟 `plan.lang`。`lang` 只能是 `apps/site/locale-registry.json` 的十四語。

**語意層**（`director/semantics.mjs`，schema 子集表達不了的跨欄位規則；任何讀入點都在 schema 之後執行，違反即 `SCHEMA_INVALID`）：source 的 url／local_file 恰一個、本機檔必有 sha256、未授權只能 analysis_only；breakdown 鏡段遞增不重疊且不超出片長；plan 的各類 id、`order`、source role 唯一，A 在 B 前，角色必有 plan 語言的名字（`names` 鍵只能是十四語），相機 position≠look_at，依賴與 `continue_from` 無環；lint-report 的 `passed`＝沒有 error；gacha-ledger 的 `adopted` 必指向第一個 passed take、其後無 take、`quoted_total`＝各 take `quoted_units` 之和；EDL 區間正向、`record_in_ms` 連續、`total_ms`＝總和。

驗證器（`director/jsonschema.mjs`）在檢查任何值之前先走完整份 schema：未知關鍵字、壞參數、壞正則、找不到的 `$ref` 一律拋錯；`$ref` 與同層約束都執行；只認物件自身屬性（`constructor`／`__proto__` 不算已宣告欄位）；const／enum 用與鍵序無關的 JSON 相等。

驗法：`node scripts/validate-schemas.mjs` → `examples/` 下（遞迴）全部正例通過 schema＋語意層、`examples/invalid/` 下全部被拒、每個 schema 至少一個正例、每份 schema 本身合法；exit 0。

## 3. 各階段

### S1 找爆款
- 輸入：網址或本機檔（創作者自備，下載與授權是創作者的責任；本工具**不下載**任何平台影片）。IDE agent 可代搜，結果仍要創作者確認。
- 指令：`nikuniku source (--url <https> | --file <video>) --rights <status> [--rights-ref <id>] --source-lang <lang> --out source.json`（url 與 file 恰給一個；給 file 時記 sha256）
- 規則：`--rights` 為 `unlicensed_reference|unknown` → `usable_for:"analysis_only"`；其餘 → `generation`。

### S2 看片拆解
- 指令：`nikuniku breakdown <video> --out breakdown.json [--threshold 0.3] [--min-shot 0.4] [--frames <dir>] [--srt <file>] [--source source.json]`
- 實作：`ffmpeg -vf "select='gt(scene,T)',showinfo"` 取切點 → 去掉距前一切點 < `min-shot` 的切點 → 每鏡 `[start_s,end_s)`；`--frames` 時每鏡中點抽一張 PNG（給 IDE agent 看圖描述）；`--srt` 時依時間把字幕句放進對應鏡的 `dialogue`（`transcript_source:"srt"`）。
- 景別、運鏡、人物、光線、道具、鉤子、描述由 IDE agent 視覺能力填寫（`filled_by:"agent"`）；偵測器填 `unknown`／`null`，不假裝看懂畫面。
- breakdown 帶 `usable_for` 與 `source_manifest_sha256`（`--source` 的 source.json bytes 的 sha256；沒給時為 null 且 `usable_for:"analysis_only"`，寧可保守）。`--source` 有 sha256 時，影片 sha256 不符即拒。
- 驗收（AC2）：合成 fixture 的鏡數與人工標註差 ≤1、每個切點誤差 ≤0.5 s。
- 錯誤：`FFMPEG_UNAVAILABLE`（exit 2）、`FFMPEG_FAILED`（exit 1）、`USAGE`。

### S3 改編計畫
- 指令：`nikuniku plan --a <breakdown.json> [--b <breakdown.json>] --brief <brief.txt> --plan-lang <lang> --project <id> --out plan.json`（`--lang` 保留給訊息語言）
- 產出 plan **骨架**：A 的鏡（與 B 的鏡，A＋B 時依 `--merge a_then_b|interleave`，預設 `a_then_b`）轉成 `shots[]`，`source_shot:"A:<i>"`；每鏡 `action` 預填「待改編：來源 <A|B>:<i>，<秒數>」（不帶原鏡描述）、`accept:null`、`rating:"general"`；`sources[]` 記兩份 breakdown 的 sha256 與 `usable_for`。
- 真正的改編文字（新人物、新台詞、補景）由創作者的 IDE agent 改寫 plan，**不經我們的伺服器、不收費**；需要我們起草（例如 explicit 鏡）時走既有 `nikuniku compose`（`/v1/prompts/draft`，收費，先報價）。
- 骨架**不搬**原片台詞、人物、道具（`dialogue/characters/props_*` 皆空），只帶結構：鏡序、時長、景別、運鏡、鉤子位置（`bible.hooks[].at_s` 依合併後、clamp 過的時長累加；`text` 為中性佔位，不搬原 hook 文字）。breakdown 的 description／hook 可能引用原片人物、道具與台詞，所以一律不進 plan（REVIEW-codex-p2.2 #4）。`budget.max_credits` 預設 0（`--max-credits` 改），未設就無法 `shoot`。
- A＋B 合併的劇情一致性由 S4 lint 把關。
- lint 的 `similarity.checked`：plan 的每個 `sources[]` 都有對應 `--source`（`source_id` 相同，且檔案 sha256＝`breakdown_sha256`；程式呼叫 `lint()` 沒給 `sourceSha256s` 一律 false）才為 true；plan 無 sources 時視為 true（沒有可比對的原片）。

### S4 邏輯自檢
- 指令：`nikuniku lint <plan.json> [--source <breakdown.json> ...] [--threshold 0.35] [--out lint-report.json]`；有 `error` 時 exit 3，只有 warning 時 exit 0。
- 規則（code 穩定，機器據此處理，不解析翻譯句）：

| code | severity | 觸發 |
|---|---|---|
| `L001_CHARACTER_UNDEFINED` | error | 鏡頭或台詞用到 `characters[]` 沒有的角色 id |
| `L002_CHARACTER_BEFORE_INTRO` | error | 角色（列在 `characters` 或作為台詞 `speaker`）在其 `first_scene` 之前的場景出現（「人物憑空出現」）；同鏡同角色只報一次 |
| `L003_PROP_NOT_ENTERED` | error | `props_used` 的道具在此鏡（含）之前沒有任何 `props_enter`（「道具未入場就使用」） |
| `L004_SIMILARITY_TOO_HIGH` | error | 改編台詞（NFKC 正規化、去標點）對原片台詞的 3-gram 包含率 > 門檻（預設 0.35，`--threshold` 限 0–1）；分詞以**字串片段**決定（不是整句）：CJK／假名／諺文每字一個 token，其餘連續字母數字為一個詞，所以英文句尾加一個漢字不會讓整句改用字元模式（REVIEW-codex-p2.2 #1）。太短而不足三個 3-gram 的台詞，改以「正規化後與任一原片台詞完全相同且至少 2 個 token」判定 |
| `L005_TIMELINE_REGRESSION` | error | 依鏡頭順序**每次切換場景**（含回到已出現的場景），該場 `story_time_min` 比已演到的最晚時間早且 `flashback:false`（「時間線倒退」）；連續同場景的鏡只算一次 |
| `L006_ACCEPT_MISSING` | warning | 鏡頭 `accept` 為 null（S9 會拒送） |
| `L007_GAP_UNFILLED` | warning | `gaps[].filled:false` |
| `L008_NAME_INCONSISTENT` | warning | 台詞語言為 X，但台詞含某角色在其他語言的名字、且不含該角色 X 語言的名字（跨語言改編的人名一致） |
| `L009_REFERENCE_UNDEFINED` | error | 鏡頭指向不存在的 scene／prop／dependency 目標 |
| `L010_SIMILARITY_NOT_CHECKED` | warning | plan 有 `sources[]` 但沒給原片 breakdown；報告 `similarity.checked:false`，**不算檢查過** |
| `L011_FINDINGS_TRUNCATED` | warning | findings 超過 10000（報告 schema 上限）：error 優先保留，最後一筆寫明省略幾筆；`passed` 依完整清單判定 |

- `shoot`／`run` 在送出前**自己跑一次 lint**：plan 有 `sources[]` 時必須以 `--source` 給齊對應 breakdown（sha256 要等於 `sources[].breakdown_sha256`），否則 exit 2 `SOURCES_REQUIRED`；lint 有 error 即 exit 3 `LINT_FAILED`，0 請求。

- 驗收（AC3）：A＋B 合併 fixture 通過 schema；三種植入錯誤（L002、L003、L005）各報**恰好一次**。（AC4）：抄原片台詞的 fixture 報 L004。

### S5 補景與素材
- `plan.gaps[]`：IDE agent 列出原片沒有、改編需要的景／道具／人物／音樂；補上描述或素材（附 `rights_ref`）後 `filled:true`。素材上傳走既有 `nikuniku upload`（`/v1/assets`）。不另做素材搜尋服務（REQUIREMENTS §2 列為真缺口，留待後續）。

### S6 白膜
- 指令：`nikuniku whitebox <plan.json> --shot <id> --out <shot.svg>`（或 `--dir <dir>` 輸出全部有 `layout` 與 `camera` 的鏡）。
- 實作：場景 `layout.boxes`（軸對齊長方體）＋鏡頭 `camera{position, look_at, fov_deg}` → 針孔透視投影、背面剔除、由遠到近畫（painter）。SVG 根元素帶 `data-faces`（畫出的面數）與 `data-forward`（相機前向單位向量，三位小數），每個面 `<polygon data-box data-face>`。
- `--dir` 回 `{files, skipped:[{shot_id, reason: no_camera|no_scene|no_layout}]}`；`--shot` 指到畫不了的鏡 → exit 2 `USAGE`，不寫檔。
- 限制（照實寫）：任一角落在近平面（0.01）之後的面整面略過、不裁切；互相穿插的方塊不分割（painter 的已知限制）。
- 不搬 Blender 依賴；需要 HED／ControlNet 的線稿由伺服端配方處理。

### S7 分鏡與每鏡驗收規格
- `shots[].accept = {checks:[{id, kind, threshold?, note?}], max_takes}`；`kind` 列舉見 schema（identity_match、framing、action_completed、dialogue_visible、continuity_tail…）。客戶端**只宣告**，判定在伺服端（§1）。
- 規則（AC5）：schema 要求每鏡都有 `accept` 鍵（規劃期可為 null）。缺鍵 → 讀檔即 `SCHEMA_INVALID`；為 null → `shoot` 在任何網路請求之前 exit 2 `ACCEPT_REQUIRED` 並列出鏡 id。兩者都是 exit 2、**送出 0 個請求**；CLI、`run`、MCP `nikuniku_director_take_submit` 行為相同。

### S8 分流
- 客戶端在 `inputs.shot_json` 帶 `rating`（建議值）；不帶 provider／route／model。伺服端回 `route`（提案欄位，C2）；客戶端照實寫進 ledger，不覆寫、不降級。
- **欄位投影**（`director/shoot.mjs#projectShot`，白名單）：一律只送 `id, order, duration_ms, framing, camera_move, camera, characters, props_enter, props_used, rating, continue_from, accept.checks[].{id,kind,threshold}, accept.max_takes`；`rating:"general"|"mature"` 另送 `action` 與 `dialogue`。`rating:"explicit"` **不送任何自由文字**（action、dialogue、check note），由伺服端依鏡頭代號起草。客戶端宣告 general、伺服端改判 explicit 時，文字已送到 nikuniku（我們自己的伺服端），不外流；是否重起草由伺服端決定。recipe 與 route 是否相容由伺服端判（C2）。
- AC6 的「伺服端標回 explicit」需要 C2；本次只驗客戶端那一半：請求裡沒有 `provider`／`route`／`model` 鍵，且伺服端回的 `route` 原樣入帳。

### S9 生成與抽卡
- 指令：`nikuniku shoot <plan.json> --ledger gacha-ledger.json [--shot <id> …] [--source <breakdown.json> …] [--max-credits <n>] [--workspace <id>] [--takes <dir>] [--timeout <s>] [--recipe <id>]`
- 配方：`shot.recipe_id` > `--recipe` > `director_shot`。**`director_shot` 與下列 inputs 是對核心的提案**：核心現有配方（如 `white_studio_single`）的 inputs 是 `{image, prompt}`，核心的配方 input 驗證只收字串值（`apps/api/src/modules/generation/recipe-runs.ts:14-30`，nikuniku `ba6014bf`），所以 `take` 以字串送出；要真的跑，核心需新增吃 `shot_json／plan_sha256／take` 的配方定義（CORE-ASKS C4）。
- 每個 take：`POST /v1/recipes/{recipe_id}/quotes {workspace_id, inputs:{shot_json, plan_sha256, take:"<n>"}}`（body 鍵集合與核心 `v1.ts` 的 `exact()` 相同） → 預算檢查 → `POST /v1/recipes/{recipe_id}/runs {…, max_credits, dry_run:false, idempotency_key}` → 輪詢 `GET /v1/recipe-runs/{run_id}` 直到 `state` 終態且 `acceptance.verdict ∈ {passed, failed}`。
- `idempotency_key = "dk-" + sha256(workspace_id|recipe_id|plan_sha256|shot_id|take)[:40]`：換 workspace、recipe、plan 任何一個 byte 都是新鍵。
- **持久化狀態機**（每一步後以「寫暫存檔＋rename」原子覆寫 ledger；ledger 旁 `<ledger>.lock` 以 O_EXCL 建立，存在即 exit 1 `LEDGER_LOCKED`，同機兩個程序不會同時拍同一份 ledger）：
  1. 報價成功 → 寫入 take `{idempotency_key, quote_id, quoted_units, run_id:null, job_id:null, verdict:"pending"}`；
  2. run 回來 → 填 `run_id／job_id`；
  3. 輪詢到判定 → 填 `verdict／failure_class／route／charged_units／output_sha256`。
  重啟時：`run_id` 為 null 的 take 以**同一把** idempotency_key 再送 run（伺服端依既有合約回原 job，不會多扣），但重送前同樣檢查預算上限；有 `run_id` 的只讀快照，不重送。既有 take 的冪等鍵必須等於以目前 workspace／recipe 重算的值，否則 `LEDGER_MISMATCH`（換 recipe 不會把舊 take 送去新配方）。
  鎖：鎖檔記 pid；該 pid 已不存在（崩潰、Ctrl-C）即接手；SIGINT／SIGTERM 會清鎖。ledger 在取得鎖之後才讀。
  伺服端回的 id 或快照不合法 → `INVALID_RESPONSE` exit 1（已送過請求，所以不是 exit 2），ledger 不寫入壞值。
  結束碼依最嚴重的問題，錯誤訊息列出全部問題（`also <CODE>: …`），`data.problems` 為 code 清單。
- **輪詢**：每 `NIKUNIKU_POLL_MS`（預設 5000）讀一次，總時限 `--timeout`（預設 1800 秒）。終態對應：`succeeded`＋`acceptance.verdict∈{passed,failed}` → 照判定；`failed`／`cancelled` → `verdict:"failed"`、`failure_class:"run_failed"`／`"run_cancelled"`；`succeeded` 而沒有 `acceptance` 欄位，或 verdict 不在 `{passed,failed,pending}`，或 `passed` 卻沒有合法 `output_sha256`（無法綁定成片 bytes），或 `route` 不是字串／超過 64 個 code point（ledger 無法原樣記錄） → `unavailable`（fail closed）；`acceptance.verdict:"pending"` 或非終態 → 繼續等，逾時 → 鏡 `acceptance_timeout`、exit 1 `ACCEPTANCE_TIMEOUT`，不採用。伺服端 `failed` 而 `failure_class` 為空或不合 `^[a-z][a-z0-9_]{0,63}$` → 記為 `unspecified`（同樣計入同類失敗）；run 本身 `failed`／`cancelled` 記 `run_failed`／`run_cancelled`。
- 抽卡規則（純函式 `director/gacha.mjs#decide`，AC7）：
  1. 依 take 順序，**第一個** `verdict:"passed"` 的 take 採用；之後不再拍。
  2. 同一 `failure_class` 累計失敗達 `budget.max_same_failure`（預設且上限 3）→ `stopped_same_failure`，停。
  3. take 數達 `accept.max_takes` → `exhausted`，停。
  4. `failed`／`pending`／`unavailable` **永不採用**；沒有「全失敗就挑分數最高」。
  5. 伺服端快照沒有 `acceptance` 欄位 → 該 take `verdict:"unavailable"`、鏡 `acceptance_unavailable`、停（不猜、不採用），exit 1 `ACCEPTANCE_UNAVAILABLE`。
  6. 預算：ledger 已報價總額（各 take `quoted_units` 之和）＋本次 `max_units` > 上限（`--max-credits` 與 `plan.budget.max_credits` 取小）→ 不送 run，`budget_stopped`，exit 4 `ABOVE_MAX_CREDITS`。每次 run 帶 `max_credits`＝該次報價，伺服端以報價綁定輸入（既有 recipe 合約）。**限制**：這是單一 ledger 的本機上限，不防同一 workspace 的其他程序或其他 ledger；跨程序的專案總額需要伺服端預留（§8 ★提案）。
- 每個 take（含失敗類別）寫進 `gacha-ledger.json`＝失敗帳。失敗 take 誰付錢由伺服端規則決定（CORE-ASKS C4／Yves），客戶端只記錄伺服端回的 `charged_units`。

### S10 拼接
- 指令：`nikuniku assemble <plan.json> --ledger gacha-ledger.json --takes <dir> --out final.mp4`；`nikuniku assemble --verify qa-receipt.json [--takes <dir>]`
- `edl.json`、`qa-receipt.json` 預設寫在 `--out` 同目錄（`--edl`／`--receipt` 可改）；EDL 的 `file` 相對於 EDL 所在目錄。
- 只接受 ledger 中 `status:"adopted"` 的鏡，檔案為 `<takes>/<shot_id>.mp4`（`shoot --download` 或 `run` 下載；下載時比對伺服端 sha256）。任一鏡未採用 → exit 3 `TAKE_NOT_ACCEPTED`。
- `edl.json`（依 `order`）→ `ffmpeg -f concat -c copy`（只做硬切，不溶接、不補幀；REQUIREMENTS 與 preflight §3 步驟六）→ `qa-receipt.json`：`output_sha256` 為成片 sha256、`edl_sha256` 為 edl.json bytes 的 sha256、每段 take sha256。
- 每段 take 檔的 sha256 必須等於 ledger 中伺服端回的 `output_sha256`（下載時已比對），否則 exit 3 `TAKE_FILE_MISMATCH`。
- assemble 需要有效 key（AC11，2026-11-08 Studio 裁定；ACCEPT-ae8c4ef 以自洽偽造 ledger 證實離線無法分辨）。本機檢查（ledger 語意、take 檔 sha256）通過後、寫任何檔之前，對每個採用的鏡呼叫 `GET /v1/recipe-runs/{run_id}?workspace_id=<ledger.workspace_id>`（與 shoot 輪詢同一支）：查無此 run → `SERVER_RUN_NOT_FOUND`；伺服器未判 passed（失敗、待判、無判定）→ `SERVER_NOT_PASSED`；伺服器 output sha256 與檔案不符 → `SERVER_SHA_MISMATCH`；無 key → `API_KEY_REQUIRED`（0 請求）。run 必須就是這個 take：伺服器回的 `run_id`／`job_id` 與 ledger 相同、`recipe_id` 等於該鏡的 `recipe_id`（沒有時用 `--recipe`，再沒有用 `director_shot`），且同一個 run 不得被兩個鏡採用 → 否則 `SERVER_RUN_MISMATCH`。多個鏡各有問題時，訊息逐一列出（exit／code 取第一類）。剪進成片的是「被雜湊、被伺服器確認的那份 bytes」的私有暫存拷貝（0700 暫存目錄、固定檔名），不是 `--takes` 裡的檔案本身；檢查後換檔（TOCTOU）或在 `--takes` 路徑裡藏換行都無法把別的內容剪進去（獨立 verifier 對 2cee4a8 的反例）。全過才出片，輸出 `server_acceptance:"checked_at_assemble"`、`server_accepted:true`、`checked_by:<API origin>`。**限制**：`NIKUNIKU_API_BASE` 指向哪台伺服器，就由那台背書；run 與鏡頭內容（shot_json）的綁定要等伺服端在快照裡回傳輸入或簽章（C4／C7）。`--verify` 離線、只證明拼接完整性，永遠回 `server_acceptance:"unverified"`、`server_accepted:false` 並在 stderr 加「未經 nikuniku 驗收」；qa-receipt 本身沒有伺服器簽章（C7），檔內 `server_acceptance` 仍為 `"unverified"`（schema `const`）。
- receipt 帶 `edl_file`（相對於 receipt 所在目錄）、`output_file`（同）、`plan_sha256`。
- `--verify`：重算成片 sha256 與 bytes、EDL sha256；EDL 的每段 shot／job／sha256 與 receipt.takes 一一相符；給 `--takes` 時再重算每段 take 檔 sha256。任一不符 → exit 3 `RECEIPT_MISMATCH`（AC8）。**receipt 證明的是「這支成片由這些檔案依此 EDL 拼成」，不證明伺服端驗收**（見 TL;DR 3）。

### run（S7→S10 一次走完）
- `nikuniku run <plan.json> --out final.mp4 [--max-credits n] [--source …] [--ledger <f>] [--takes <dir>]`：先檢查 API key（AC11），再 shoot（其送出前檢查含 accept、sources、lint）→ 下載 → assemble；ledger 與 takes 預設在 `--out` 同目錄；該目錄不存在時，shoot 在本機檢查全部通過後、取 ledger 鎖之前建立它（ACCEPT-deb8cc0 D1）。任一步非 0 即停並回該步的錯誤。

### MV（AC9）
- `nikuniku mv --image <png> [--image …≤4] --audio <wav|mp3> --prompt <txt> [--max-credits n] [--wait --out f]`：沿用既有 `generate` 的 E1 路徑（多圖＋歌），差別只在「歌必填、至少一張圖、有 prompt」在任何請求前先檢查；草稿欄位名 `reference_audio_id`。`mv` 掛在核心 CLI 的 `generate` 路徑上，錯誤輸出是核心格式（stderr 單行 JSON，沒有第二行本地化訊息）。mock 的 MV 模式名 `multi_image_song` 是 mock 專用：真實模式名由 release manifest 決定，客戶端依 `audio:'external'` 從 `/v1/capabilities` 選。
- MCP `nikuniku_mv_draft`：上傳圖與歌、依能力表選模式、存草稿並報價，**不送出**（送出仍用既有 `nikuniku_submit`，先報價後花錢）。

## 4. CLI 子指令總表

| 指令 | 需要 key | 網路 | 產出 |
|---|---|---|---|
| `source` | 否 | 無 | source.json |
| `breakdown` | 否 | 無 | breakdown.json、frames/ |
| `plan` | 否 | 無 | plan.json |
| `lint` | 否 | 無 | lint-report.json |
| `whitebox` | 否 | 無 | *.svg |
| `shoot` | **是** | `/v1` | gacha-ledger.json、takes/ |
| `assemble` | **是**（出片前逐鏡向伺服器核對；`--verify` 不需要、離線） | `/v1`（只讀 `GET /v1/recipe-runs/{id}`） | edl.json、qa-receipt.json、成片 |
| `run` | **是** | `/v1` | 全部 |
| `mv` | **是** | `/v1` | job |

共同旗標：`--lang <lang>`（或 `NIKUNIKU_LANG`）只影響 stderr 的人類訊息行。

**輸出約定**：stdout 只放一行 JSON 結果；錯誤時 stderr 第一行是不翻譯的 JSON `{ok:false,error:{code,message}}`（`message` 為英文），第二行是本地化訊息（ar 以 U+2067…U+2069 包住）。

## 5. 錯誤碼與 exit code

| exit | 意義 |
|---|---|
| 0 | 成功 |
| 1 | API／網路／執行期錯誤（伺服端錯誤原樣輸出其 envelope） |
| 2 | 用法／設定錯誤，或送出前就拒絕（**沒有送出任何請求**） |
| 3 | 檢查未過（lint error、receipt 不符、仍有鏡未採用） |
| 4 | 超過預算上限（沒有送出 run） |

| code | exit | 何時 |
|---|---|---|
| `USAGE` | 2 | 參數錯 |
| `SCHEMA_INVALID` | 2 | 輸入 JSON 不合 schema（附前 5 個錯誤路徑） |
| `API_KEY_REQUIRED` | 2 | 需要 key 的指令沒有 key |
| `INVALID_BASE` | 2 | `NIKUNIKU_API_BASE` 不是 https（loopback 例外） |
| `HOST_REFUSED` | 1 | 回應要我們去連白名單外的主機 |
| `ACCEPT_REQUIRED` | 2 | 有鏡沒有 `accept` |
| `FFMPEG_UNAVAILABLE` | 2 | 找不到 ffmpeg／ffprobe |
| `FFMPEG_FAILED` | 1 | ffmpeg 非 0 結束 |
| `LINT_FAILED` | 3 | lint 有 error |
| `ACCEPTANCE_UNAVAILABLE` | 1 | 伺服端沒有回驗收判定 |
| `ABOVE_MAX_CREDITS` | 4 | 報價超出上限 |
| `SHOTS_NOT_ADOPTED` | 3 | shoot 結束仍有鏡未採用（停在三敗或用完次數） |
| `TAKE_NOT_ACCEPTED` | 3 | assemble 遇到未採用的鏡 |
| `TAKE_FILE_MISMATCH` | 3 | take 檔 sha256 與 ledger／伺服端不符 |
| `SERVER_RUN_NOT_FOUND` | 3 | assemble 出片前向伺服器核對：查無 ledger 採用的 run（AC11） |
| `SERVER_RUN_MISMATCH` | 3 | assemble 出片前核對：伺服器描述的 run_id／job_id 與 ledger 不同、配方不是該鏡的 `recipe_id`（或 `--recipe`／`director_shot`），或同一個 run 被兩個鏡採用 |
| `SERVER_NOT_PASSED` | 3 | assemble 出片前核對：伺服器未判定該 take 通過（失敗、待判、無判定） |
| `SERVER_SHA_MISMATCH` | 3 | assemble 出片前核對：伺服器回報的 output sha256 與檔案不符 |
| `RECEIPT_MISMATCH` | 3 | QaReceipt 驗證失敗 |
| `SHA256_MISMATCH` | 1 | 下載內容與伺服端 sha256 不符（不寫檔） |
| `UNSUPPORTED` | 2 | 能力表沒有對應模式 |
| `SOURCES_REQUIRED` | 2 | shoot／run 時 plan 有 sources 但沒給齊對應 breakdown |
| `LEDGER_LOCKED` | 1 | 另一個程序正在用同一份 ledger |
| `LEDGER_MISMATCH` | 2 | ledger 的 plan_sha256／workspace 與目前不符 |
| `ACCEPTANCE_TIMEOUT` | 1 | 時限內伺服端沒給出判定 |
| `NETWORK_ERROR` | 1 | 連不到 API |
| `INVALID_RESPONSE` | 1 | API 回應不是預期格式 |
| `DOWNLOAD_FAILED` | 1 | take 下載非 200（含 3xx：不跟隨轉址） |
| `INTERNAL` | 1／2 | 未預期錯誤；或本工具即將寫出不合 schema 的檔案而拒寫 |

## 6. MCP 工具（加在既有 `nikuniku` server，同一份 key）

| 工具 | key | 副作用 | 說明 |
|---|---|---|---|
| `nikuniku_director_validate` | 否 | 無 | 依 schema 名驗證本機 JSON 檔 |
| `nikuniku_director_lint` | 否 | 無 | S4，回 lint-report |
| `nikuniku_director_whitebox` | 否 | 寫一個 SVG 檔 | S6 |
| `nikuniku_director_take_submit` | 是 | **預留點數** | S9 單一 take：檢查 accept／sources／lint→報價→預算（`max_credits` 必填）→run→輪詢一次即返回；一次呼叫最多送 1 個新 take |
| `nikuniku_director_take_status` | 是 | 寫 ledger | 讀快照與判定、套抽卡規則，回每鏡 `next: wait|retry|resend|stop`；**永不送出**（連上次失敗的 run 也不重送，resend 交給 take_submit） |
| `nikuniku_mv_draft` | 是 | 上傳、存草稿 | MV：圖＋歌→草稿＋報價，不送出 |

守衛（AC13）：server 建立時（`createNikunikuMcpServer`／`toolList`）檢查全部工具名稱、描述與 input schema 字串，含成人主機或成人工具字樣（`adult`、`nsfw`、`porn`、`18+`、`r18`、`r-18`、`hentai`、`xxx`、`erotic`）即拋 `ADULT_TOOL_REFUSED`、拒絕啟動。本機工具（validate／lint／whitebox）不需 key、不送任何請求。成人入口屬另一套件（ai-tools 計畫 §2.1，C5）。

## 7. 十四語

- 檔案：`locales/director/<lang>.json`，lang＝`en zh-Hant zh-Hans ja ko vi id th es pt-BR fr de ar hi`；每檔同一組鍵（`error.<CODE>`、`done.<command>`、`dir`）；`ar` 的 `dir` 為 `rtl`，其餘 `ltr`。
- 語言決定：`--lang` > `NIKUNIKU_LANG` > `LC_ALL`／`LANG` 前綴對應 > `en`；不在清單 → `en`。
- 機器輸出（stdout JSON、stderr 第一行 JSON、錯誤 code）不翻譯，任何語言下 byte 相同。成功時 stderr 只有一行本地化 `done.<command>`。
- `tests/locales.test.mjs` 從程式碼抓出所有可能的錯誤碼（`Refusal('X'`、`code:'X'`、SPEC §5 表），每個都必須在十四語都有 `error.X`。
- 翻譯品質：機器起草，**未委託人工審校**（與 locale-registry 的 `human_review: not commissioned` 一致），不宣稱母語審過。

## 8. 伺服端契約（mock `/v1` 實作；★ 為對核心的提案）

| 路由 | 用途 | 現況 |
|---|---|---|
| `POST /v1/recipes/{id}/quotes`、`/runs` | 每個 take | 路由已在核心，worker 未接線（C1） |
| `GET /v1/recipe-runs/{run_id}` | 快照 | 已有；★`acceptance:{verdict, failure_class, checks[]}`、★`route` 需 C4／C2 |
| ★ 驗收證明 | 伺服端對 `{workspace_id, plan_sha256, shot_id, run_id, take, output_sha256, accept 規格 sha256, verdict}` 簽章；並且**只對 passed 的 take 發下載連結** | 提案（REVIEW-codex-1 B1）；上線後 `assemble --verify` 改為驗簽 |
| ★ 專案預算預留 | 對 `project_id` 原子預留總額，run 引用預留 | 提案（REVIEW-codex-1 B3） |
| `GET /v1/jobs/{job_id}/output` | 下載連結＋sha256 | 已有 |
| 既有 assets/audio/drafts/quotes/jobs/capabilities/pricing/me | MV | 已有 |

## 9. 驗收（AC → 測試檔）

| AC | 測試檔 | 一句指令 |
|---|---|---|
| P1.1 | `tests/schemas.test.mjs` | `node scripts/validate-schemas.mjs` |
| AC1 | `tests/network.test.mjs` | `node --test tests/network.test.mjs`（含 2026-11-08 釐清：API 在 `api.nikuniku.ai`、連結在 `media.nikuniku.ai` 的整段 shoot，fetch 攔截不連外） |
| AC2 | `tests/breakdown.test.mjs`、`tests/check-breakdown.mjs` | `node cli/nikuniku.mjs breakdown fixtures/x.mp4 --out b.json && node tests/check-breakdown.mjs b.json fixtures/x.truth.json` |
| AC3 AC4 | `tests/lint-fixtures.test.mjs` | `node --test tests/lint-fixtures.test.mjs` |
| S6 | `tests/whitebox.test.mjs` | `node --test tests/whitebox.test.mjs` |
| AC5 | `tests/shotlist-accept.test.mjs` | `node --test tests/shotlist-accept.test.mjs` |
| AC6（客戶端半） | `tests/gacha.test.mjs` | 同下；**伺服端半：等待核心 C2**，未驗 |
| AC7 | `tests/gacha.test.mjs` | `node --test tests/gacha.test.mjs` |
| AC8 | `tests/assemble.test.mjs` | `node --test tests/assemble.test.mjs` |
| AC11（assemble） | `tests/assemble.test.mjs` | assemble 出片前逐鏡向（mock）伺服器核對：自洽偽造 ledger → `SERVER_RUN_NOT_FOUND`；未通過／待判／無判定 → `SERVER_NOT_PASSED`；sha256 不符 → `SERVER_SHA_MISMATCH`；無 key → `API_KEY_REQUIRED`、0 請求；都不寫檔。偽造「採用未通過 take」的 ledger → `SCHEMA_INVALID`。verify 離線、永遠 `unverified`／`server_accepted:false`；receipt 改稱已驗收 → verify 拒絕。反向：刪掉核對呼叫 → 6 個測試紅 |
| AC9 | `tests/mv.test.mjs` | `node cli/nikuniku.mjs mv --help && node --test tests/mv.test.mjs` |
| AC11 | `tests/no-key.test.mjs` | `node --test tests/no-key.test.mjs`（精確斷言 exit 2、`API_KEY_REQUIRED`、mock 收到 0 個請求；REQUIREMENTS 原指令 `test $? -ne 0` 太寬，任何崩潰都會過） |
| AC12 | `tests/locales.test.mjs` | `node --test tests/locales.test.mjs` |
| AC13 | `tests/mcp-no-adult.test.mjs` | `node --test tests/mcp-no-adult.test.mjs` |
| AC10 | 驗收機手冊（P3） | **等待核心：未通過、未能驗**：需 C1–C4＋驗收機帳號。上線後指令：`NIKUNIKU_API_BASE=<staging> node cli/nikuniku.mjs run plan.json --out final.mp4 && node cli/nikuniku.mjs assemble --verify qa-receipt.json`，並比對 `/v1/recipe-runs/*` 的 `charged_units` 總和與帳單 |

**AC6 與 AC10 在本次都不算通過（UNVERIFIED，等待核心）**：AC6 只驗了客戶端那一半（不送 provider、照抄伺服端 route），伺服端判級要等 C2；AC10 要 C1–C4 上線、驗收機帳號與 staging key，並以 computer-use 走 S1→S10 再對帳。mock 通過不算這兩條的證據（ACCEPT-deb8cc0 同此判定）。

每項都要有反向驗證：刪掉對應守衛，對應測試變紅（PLAN P2 各項）。

### 9.1 每條 AC 的 happy／edge

| AC | happy | edge／error |
|---|---|---|
| AC1 | mock 全流程只連 mock 主機；API 在 `api.nikuniku.ai` 時每個採用 take 只從該次 run 回傳的 `media.nikuniku.ai` 連結下載、不帶 key | 輸出連結指向白名單外主機 → `HOST_REFUSED`、不寫檔；轉址不跟隨；連結 sha256 與 run 不符 → `SHA256_MISMATCH` |
| AC2 | 3 鏡 fixture 偵測 3 鏡、切點誤差 ≤0.5 s | 門檻改壞（>1）→ 只剩 1 鏡 → 檢查失敗；無 ffmpeg → `FFMPEG_UNAVAILABLE` |
| AC3 | 乾淨 A＋B plan 0 個 error | 三種植入錯誤各報恰好一次 |
| AC4 | 改寫過的台詞相似度低於門檻 | 抄原片台詞 → L004 |
| AC5 | 每鏡有 accept → 送出 | 一鏡缺 accept → exit 2、mock 收到 0 個請求 |
| AC6 | 請求不含 provider／route／model | 伺服端回 `route:"explicit"` 原樣入帳，客戶端宣告的 general 不覆寫 |
| AC7 | 前兩敗第三過 → 採用第三 | 同類三敗 → 停並入帳；全失敗 → 不採用任何 take；無判定欄位 → `ACCEPTANCE_UNAVAILABLE` |
| AC8 | receipt 雜湊＝成片 sha256 | 成片改 1 byte → `RECEIPT_MISMATCH`；未採用鏡 → `TAKE_NOT_ACCEPTED` |
| AC9 | `mv` 送出草稿帶 `reference_audio_id` | 沒給 `--audio` → exit 2、0 請求 |
| AC11 | 無 key 時 breakdown／plan／lint／whitebox 正常；有 key 時 assemble 只拼伺服器確認通過、sha256 相符的鏡 | 無 key 跑 `run`／`shoot`／`mv` → `API_KEY_REQUIRED`、0 請求；無 key 跑 assemble → `API_KEY_REQUIRED`；伺服器查無／未通過／sha 不符 → `SERVER_RUN_NOT_FOUND`／`SERVER_NOT_PASSED`／`SERVER_SHA_MISMATCH`；assemble 遇未採用鏡 → `TAKE_NOT_ACCEPTED`、檔案 sha256 不符 → `TAKE_FILE_MISMATCH`、ledger 把未通過 take 標成採用 → `SCHEMA_INVALID`，都不出片 |
| AC12 | 十四語同鍵、ar 為 RTL 並以隔離字元包住 | 任一語言缺鍵即失敗；stdout JSON 在各語言下相同 |
| AC13 | 一般工具清單無成人工具 | 注入成人工具 → server 拒絕啟動 |

## 10. 非目標

- 下載平台影片、繞過浮水印、任何換皮 SOP（REQUIREMENTS R1）。
- 本機轉錄模型、本機視覺模型（16 GB 機器；交給 IDE agent 或匯入 SRT）。
- 客戶端自判合格、自選供應商、自降分級。
- 溶接／補幀／穩像遮蓋接縫。

## 10.1 保存（retention）

`retention.keep_takes_days` 只管**本機** take 副本（`shoot` 下載到 `--takes` 的檔）；null＝留到創作者自己刪。不送到伺服端：伺服端素材與 clip 的保存天數尚未定（`11-agent-…` §7），以伺服端回應為準。本工具不自動刪檔；`nikuniku assemble` 不刪任何 take。

## 11. 推播／召回

N/A：本規格是開發者工具（CLI／MCP／IDE），沒有使用者帳號層的通知通道。生成完成沿用 `/v1` 工作狀態查詢與既有 webhook；網頁端召回屬 nikuniku Studio 範圍（REQUIREMENTS §9）。

## 12. Rollback

所有改動在 `fg/director-kit` 分支；`git revert <sha>` 逐個 commit 回退。對既有匯出檔的改動只有 `cli/nikuniku.mjs`、`mcp/nikuniku-mcp.mjs` 的掛載點與 `tests/mock-api.mjs` 的擴充，`git diff e8a0053 -- cli mcp tests/mock-api.mjs` 可看全貌。
