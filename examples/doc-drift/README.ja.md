# ドキュメントドリフト検知

[English](./README.md)

Arkor デプロイメントの上に作れるものの一例です。プルリクエストのコード変更が
README などのドキュメントを陳腐化させた瞬間に検知する、
**ドキュメントドリフト**チェックを示します。

例は依存ゼロの TypeScript スクリプト 1 ファイルです。ドキュメントと unified
diff を、Arkor がホストする Gemma 4 デプロイメントに OpenAI 互換の
chat-completions API で送り、構造化された判定を受け取ります:

```json
{ "drifted": true, "severity": "warning", "explanation": "...", "suggestion": "..." }
```

## いちばん簡単な方法: GitHub App を入れる

自分で動かす必要はありません。
[drift-check GitHub App](https://github.com/apps/drift-check) をインストール
すると、選んだリポジトリのすべてのプルリクエストで、この例と同じこと
(加えてコメント/コード乖離チェック) が実行され、レビュー要約として投稿され
ます。ワークフローも secrets もコードも不要です。

この例は、そのようなチェックが内部でどう動くか、Arkor デプロイメントがあれば
どれほど少ないコードで済むかを示すためのものです。

## GitHub ワークフローとして使う

2 ファイルをコピーするだけで PR チェックになります:

1. [`workflow.yaml`](./workflow.yaml) を `.github/workflows/doc-drift.yaml` にコピー。
2. [`src/check.ts`](./src/check.ts) を `scripts/doc-drift-check.ts` にコピー。
3. Settings > Secrets and variables > Actions で次を設定:
   - `ARKOR_BASE_URL` (variable): デプロイメントの URL。例
     `https://your-model.arkor.app/v1`
   - `ARKOR_API_KEY` (secret): デプロイメントが `fixed_api_key` 認証の場合のみ
   - `ARKOR_MODEL` (variable、任意): 既定は `gemma-4-31b-it`

PR ごとに、ドキュメント別の判定表がジョブ要約に表示されます。ドリフト検知時は
step が失敗します。advisory (非ブロッキング) にしたい場合は
`continue-on-error: true` を付けてください。

## ローカルで動かす

```sh
pnpm install

ARKOR_BASE_URL=https://your-model.arkor.app/v1 \
pnpm --filter @arkor/example-doc-drift check
```

引数なしで実行すると同梱サンプルをチェックします。架空 CLI の README
([`samples/doc.md`](./samples/doc.md)) と、ドキュメントに載っている
`--max-retries` フラグを改名する diff
([`samples/changes.diff`](./samples/changes.diff)) の組なので、ドリフトが報告
され exit 1 になります。自分のファイルは
`node src/check.ts <diff-file> <doc-file...>` のように渡します。

Node.js 24+ が必要です (Node 22.7+ は `--experimental-strip-types` で動作)。
自分のモデルのデプロイメント作成は [Arkor docs](https://docs.arkor.ai) を参照
してください。

## 仕組み

チェック全体がリクエスト 1 回です。構造化出力
(`response_format: json_schema`) で厳密な JSON 判定を要求するため、応答は常に
パースできます:

- `drifted`: この diff がドキュメントを不正確にするか
- `severity`: `info`、`warning`、`error` のいずれか
- `explanation`: diff と矛盾するドキュメント記述の指摘
- `suggestion`: 具体的なドキュメント修正案

プロンプトは意図的に保守的です。diff が**明確に**もたらす不整合だけを対象に
するため、ドキュメント自体の編集や無関係な変更でノイズは出ません。この
アイデアの製品版 (大きな PR の diff チャンク分割、コメント/コード乖離
チェック、レビューコメント投稿) は
[drift-check GitHub App](https://github.com/apps/drift-check) として提供
されています。
