# Arkor への貢献

ご興味を持っていただきありがとうございます！ Arkor は **alpha** 段階にあり、私たちは速く動き、意図的に物事を壊しながら開発を進めています。コアアイデア (プロダクトエンジニアのための TypeScript ネイティブなファインチューニング) は、実際に使うであろう人たちと*一緒に*設計したいものです。Issue、議論、PR のいずれも歓迎します。

## 貢献の方法

| 労力                     | 特に役立つこと                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------ |
| **5 分**                 | [クイックスタート](README.md#quickstart) を試して、混乱した点・壊れた点・TypeScript らしくないと感じた点について [Issue を立てる](https://github.com/arkorlab/arkor/issues/new)。 |
| **半日**                 | [`good first issue`](https://github.com/arkorlab/arkor/labels/good%20first%20issue) をピックアップするか、小さな PR (ドキュメント修正、テンプレート調整、エラーメッセージの改善) を送る。 |
| **継続的に**             | [Discord](https://discord.gg/YujCZYGrEZ) に参加して、動いてほしいモデル + データセット + ワークフローを教えてください。優先順位付けに使います。 |

非自明な変更 (新しい SDK ファクトリ、CLI コマンド、Studio のビュー) のアイデアがある場合は、コードを書く前に API の形について合意できるよう、まず Issue を開いてください。

## リポジトリ構成

```
arkor/
├── packages/
│   ├── arkor/              # SDK + CLI + バンドル済みローカル Studio (npm 公開)
│   ├── create-arkor/       # `pnpm create arkor` スキャフォルダー (npm 公開)
│   ├── cli-internal/       # arkor + create-arkor が共有するプライベートヘルパー
│   └── studio-app/         # `arkor` にバンドルされる Vite + React SPA
├── e2e/cli/                # スキャフォルダー & ビルドの vitest ベース E2E スイート
├── e2e/studio/             # Studio SPA 用の Playwright E2E スイート
├── assets/                 # README / OG 画像
└── turbo.json              # ビルド / テストのオーケストレーション
```

`cli-internal`、`studio-app`、`e2e/cli`、`e2e/studio` はプライベートで、公開されることはありません。

## 開発セットアップ

**Node.js 24 (できれば最新版)** と **pnpm 10.21+** を使用してください。

```bash
git clone https://github.com/arkorlab/arkor.git
cd arkor
pnpm install
pnpm build         # turbo run build (全パッケージをカバー)
pnpm test          # モノレポ全体のユニットテスト
pnpm typecheck     # モノレポ全体の tsc
```

特定のパッケージで作業するには:

```bash
pnpm --filter arkor dev               # SDK/CLI を tsdown --watch
pnpm --filter @arkor/studio-app dev   # Studio SPA の vite 開発サーバー
pnpm --filter create-arkor dev        # スキャフォルダーを tsdown --watch
```

## E2E スイート

スコープが異なる 2 つのプライベート E2E スイートがあります:

| スイート | スコープ | ツール |
| --- | --- | --- |
| [`e2e/cli`](e2e/cli) | `arkor` / `create-arkor` CLI 表面 — spawn・スキャフォルド・ビルド・終了コード・stdout/stderr | ビルド済み `dist/bin.mjs` を vitest で起動 |
| [`e2e/studio`](e2e/studio) | `arkor dev` が配信する Studio SPA — `<meta>` トークン注入、`/api/*` 認可契約、ページレベル描画、SSE ストリーミング | 実 `arkor dev` + 同一プロセス内 fake cloud-api に対し Playwright で Chromium を駆動 |

CLI スイート (遅い。一時ディレクトリで実 CLI を起動) を実行するには:

```bash
pnpm --filter @arkor/e2e-cli test
# フィクスチャ内の `<pm> install` ステップをスキップ:
SKIP_E2E_INSTALL=1 pnpm --filter @arkor/e2e-cli test
```

Studio スイート (初回のみブラウザインストールが必要) を実行するには:

```bash
pnpm build  # arkor の dist/bin.mjs と Studio バンドルが必要
pnpm --filter @arkor/e2e-studio exec playwright install chromium
pnpm --filter @arkor/e2e-studio test
# デバッグ:
pnpm --filter @arkor/e2e-studio exec playwright test --ui   # GUI ランナー
pnpm --filter @arkor/e2e-studio exec playwright show-report # 直近の HTML レポート
```

## ローカルビルドを試す

最速のループは、ワークスペースのビルドを指す新規プロジェクトをスキャフォールドすることです:

```bash
pnpm build
cd /tmp && node /path/to/arkor/packages/create-arkor/dist/bin.mjs my-arkor-app
cd my-arkor-app && pnpm dev
```

Studio は起動ごとに注入される CSRF トークン付きで `http://127.0.0.1:4000` で動作します。

## プルリクエストのガイドライン

PR は粗くてもまず受け入れる方針です。タイポ修正、言い回しの微調整、エラーメッセージの磨き込みといった小さな貢献も心から歓迎しており、「小さすぎて送るほどじゃない」ということは決してありません。**以下のいずれも PR を出さない理由にはしないでください:**

- **大きさは気にしないでください。** 巨大な差分でも構いません。「大きくなりすぎたから」と PR を抱え込むよりも、まず送ってもらえる方がずっと助かります。必要ならこちらで分割します。
- **説明が雑でも OK。** 説明が乱雑だったり薄かったりしても、PR が無いよりはずっと良いです。不明点はレビューで質問するので、それで PR を差し戻すことはしません。
- **テストは必須ではありません。** SDK / CLI / スキャフォルダーのロジックには vitest のケース、Studio コンポーネントには jsdom + Testing Library ベースのケース (`pnpm --filter @arkor/studio-app test` で実行)、見た目の変更にはスクリーンショットや短いクリップがあると助かりますが、いずれもブロッカーではありません。マージの一環としてこちらでテストを足すこともあります。
- **alpha の間は破壊的変更も問題ありません。** `0.0.x` の間に互換性シムは出さないので、PR の説明にメモするだけで十分です。[リリースノート](https://github.com/arkorlab/arkor/releases) は誠実に保たれます。

## バグとセキュリティ問題の報告

- **バグ**: [GitHub Issues](https://github.com/arkorlab/arkor/issues/new) で報告してください。再現手順、期待される動作と実際の動作、Node と pnpm のバージョンが添えられているとかなり助かりますが、「これが壊れている」という一行だけでも、報告しないよりはずっと良いです。こちらで再現できなかった場合は Issue 上で追加の質問をするので、できる範囲で返信をお願いします。停滞しているバグの多くは無視されているわけではなく、報告者しか持っていない情報を待っている状態です。
- **セキュリティ**: 公開 Issue を立てる代わりに、security@arkor.ai までメールしてください。48 時間以内に確認の返信をします。

## 行動規範

親切に、誠実だと仮定し、技術的な意見の相違は技術的なまま保ちましょう。それ以外 (ハラスメント、人格攻撃、排他的な振る舞い) は退場をお願いする理由になります。メンテナーの判断が最終です。

## ライセンス

貢献することにより、あなたの貢献が [MIT ライセンス](LICENSE.md) のもとでライセンスされることに同意したものとみなされます。
