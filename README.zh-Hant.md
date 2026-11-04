# nikuniku.ai 創作者工具包

[English](README.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md)

在你自己的工作環境裡，用 [nikuniku.ai](https://studio.nikuniku.ai) 的 `/v1` API 做影片：

| 路徑 | 內容 |
|---|---|
| `cli/nikuniku.mjs` | 指令列：`nikuniku generate` 一步完成上傳、檢查、草稿、報價、送出、等待、下載 |
| `mcp/nikuniku-mcp.mjs` | MCP 伺服器（stdio），讓 Claude、Codex 等 MCP 客戶端報價、送出、取回作品 |
| `python/nikuniku_api.py` | Python 客戶端，只用標準函式庫 |
| `skill/nikuniku-video/` | 描述同一流程的 Claude Skill |

## 開始

1. 到 https://studio.nikuniku.ai/signin 登入，建立 API 金鑰，複製工作區 ID。
2. 到 https://studio.nikuniku.ai/billing 儲值（1 點 = US$0.01；報價免費）。
3. 執行：

```bash
npm install
export NIKUNIKU_API_KEY=...            # 不要貼進對話
node cli/nikuniku.mjs pricing
node cli/nikuniku.mjs generate --image ref.png --prompt examples/prompt.txt --max-credits 60 --wait --out shot.mp4
```

## 目前販售的能力

以 `GET https://api.nikuniku.ai/v1/capabilities` 為準。2026-11-05 列出的是 `h3`：圖生影片、一張參考圖、5083 ms。
客戶端已支援多個 `--image`、`--audio`、`--continue-from`，但只有表中有發行版本支援時才會使用；否則 CLI 以 exit 2 結束並說明缺什麼。

## 測試

`npm test` 對本機模擬的 `/v1` 執行（不需金鑰與點數）。完整 API 文件：https://studio.nikuniku.ai/docs

程式來源見 [SOURCE.md](SOURCE.md)。尚未加入授權檔案。
