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
├── assets/                 # README / OG 画像
└── turbo.json              # ビルド / テストのオーケストレーション
```

`cli-internal`、`studio-app`、`e2e/cli` はプライベートで、公開されることはありません。

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

E2E のスキャフォルダー / ビルドスイート (遅い。一時ディレクトリで実 CLI を起動する) を実行するには:

```bash
pnpm --filter @arkor/e2e-cli test
# フィクスチャ内の `<pm> install` ステップをスキップ:
SKIP_E2E_INSTALL=1 pnpm --filter @arkor/e2e-cli test
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

- **PR ごとに関心事は 1 つ。** 差分が小さいほど早くマージされます。
- **テスト可能な表面にはテストを。** SDK / CLI / スキャフォルダーのロジックには vitest のケースが必要です。Studio の UI 変更はスクリーンショットや短いクリップを添えて PR を出せます。
- **alpha の間は破壊的変更も問題ありません。** `0.0.x` の間に互換性シムは出さないので、PR の説明にメモするだけで十分です。CHANGELOG は誠実に保たれます。
- **削除した動詞を再導入しないでください。** `arkor train`、`arkor deploy`、`arkor jobs`、`arkor logs` は意図的に削除されました。トレーニングとデプロイはエントリポイントが実行されるときに動く TS の config であり、CLI の動詞ではありません。CLI の表面は `dev` / `build` / `start` と認証コマンドです。

## バグとセキュリティ問題の報告

- **バグ**: [GitHub Issues](https://github.com/arkorlab/arkor/issues/new) に、再現手順、期待される動作と実際の動作、Node と pnpm のバージョンを添えて報告してください。
- **セキュリティ**: 公開 Issue を立てる代わりに、security@arkor.ai までメールしてください。48 時間以内に確認の返信をします。

## 行動規範

親切に、誠実だと仮定し、技術的な意見の相違は技術的なまま保ちましょう。それ以外 (ハラスメント、人格攻撃、排他的な振る舞い) は退場をお願いする理由になります。メンテナーの判断が最終です。

## ライセンス

貢献することにより、あなたの貢献が [MIT ライセンス](LICENSE.md) のもとでライセンスされることに同意したものとみなされます。
