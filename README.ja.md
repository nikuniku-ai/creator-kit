# nikuniku.ai クリエイターキット

[English](README.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md)

[nikuniku.ai](https://studio.nikuniku.ai) の `/v1` API で、手元の環境から動画を作るためのツールです。

| パス | 内容 |
|---|---|
| `cli/nikuniku.mjs` | コマンドライン：`nikuniku generate` でアップロード・チェック・下書き・見積もり・送信・待機・ダウンロードを一度に |
| `mcp/nikuniku-mcp.mjs` | MCP サーバー（stdio）。Claude や Codex などから見積もり・送信・取得ができます |
| `python/nikuniku_api.py` | 標準ライブラリだけで動く Python クライアント |
| `skill/nikuniku-video/` | 同じ流れを説明する Claude スキル |

## はじめかた

1. https://studio.nikuniku.ai/signin でサインインし、API キーを作成してワークスペース ID をコピーします。
2. https://studio.nikuniku.ai/billing でクレジットを追加します（1 クレジット = US$0.01、見積もりは無料）。
3. 実行：

```bash
npm install
export NIKUNIKU_API_KEY=...            # チャットに貼らないでください
node cli/nikuniku.mjs pricing
node cli/nikuniku.mjs generate --image ref.png --prompt examples/prompt.txt --max-credits 60 --wait --out shot.mp4
```

## 現在提供している機能

`GET https://api.nikuniku.ai/v1/capabilities` が正です。2026-11-05 時点では `h3`（画像から動画、参照画像 1 枚、5083 ms）です。
クライアントは複数の `--image`、`--audio`、`--continue-from` に対応済みですが、表に対応リリースがある場合だけ使われます。ない場合 CLI は exit 2 で不足を示します。

## テスト

`npm test` はローカルの `/v1` モックに対して実行します（キー・クレジット不要）。API リファレンス：https://studio.nikuniku.ai/docs

コードの出所は [SOURCE.md](SOURCE.md) を参照してください。ライセンスファイルはまだありません。
