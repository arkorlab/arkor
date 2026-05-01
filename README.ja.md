<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Arkor" width="96">
  </picture>
</p>

<h1 align="center">Arkor</h1>

<h3 align="center">オープンウェイト LLM をファインチューニングするための TypeScript フレームワーク</h3>

<p align="center">
  TypeScript アプリと同じ開発体験で、カスタムなオープンウェイトモデルのトレーニングからデプロイまでを一気通貫で行えます。
  型安全な設定、ローカル Studio (Web UI) によるトレーニングの起動と監視、そしてマネージド GPU を提供します。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/arkor"><img src="https://img.shields.io/npm/v/arkor?label=arkor&color=000" alt="npm"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-000" alt="MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.6-000" alt="node ≥22.6">
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="alpha">
  <a href="https://discord.gg/YujCZYGrEZ"><img src="https://img.shields.io/badge/discord-join-5865F2" alt="Discord"></a>
</p>

<p align="center">
  <a href="#クイックスタート"><strong>クイックスタート</strong></a> &nbsp;·&nbsp;
  <a href="#なぜ-arkor-か"><strong>なぜ Arkor か</strong></a> &nbsp;·&nbsp;
  <a href="https://docs.arkor.ai"><strong>ドキュメント</strong></a>
</p>

<p align="center">
  <a href="README.md">English</a>
</p>

> [!WARNING]
> Arkor は **alpha** 段階です。API は予告なく変更されます。私たちはオープンに開発を進めており、フィードバックが次に何が入るかを左右します。

<!--
  Demo media goes here once recorded:
    - assets/demo-cli.gif       Terminalizer: pnpm create arkor → pnpm dev
    - assets/demo-studio.gif    Screen recording: Run Training → loss curve → Playground
-->

## クイックスタート

```bash
pnpm create arkor my-arkor-app
cd my-arkor-app
pnpm dev
```

**サインアップ不要:**
`arkor dev` は **Studio** と呼ばれるローカル Web UI を `http://localhost:4000` で開きます。初回起動時に使い捨ての匿名ワークスペースをプロビジョニングするので、すぐに実際のトレーニング実行を開始できます。

後からアカウントに紐付けたい場合は `arkor login --oauth` を実行してください。

### テンプレートを選ぶ

スキャフォルダーがどのテンプレートを使うかを尋ねます。
3 つすべてが同じ小さなオープンウェイトベースモデル (`unsloth/gemma-4-E4B-it`) と HuggingFace 上の厳選されたパブリックデータセットを組み合わせており、最初の実行は数分で完了します。

| テンプレート | タスク           | 例                                                                                               | データセット                | 推定トレーニング時間 |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------ | --------------------------- | -------------------- |
| `triage`     | サポートトリアージ | `"Can't log in"` → `{category: "auth", urgency: "high", summary: "...", nextAction: "..."}`      | `arkorlab/triage-demo`      | 約 7 分              |
| `translate`  | 翻訳             | `"パスワードを忘れました"` → `{translation: "I forgot my password", detectedLanguage: "ja"}`     | `arkorlab/translate-demo`   | 約 7 分              |
| `redaction`  | PII 削除         | `"Email john@x.com"` → `{redactedText: "Email [REDACTED]", redactedCount: 1, tags: ["EMAIL"]}`   | `arkorlab/redaction-demo`   | 約 12 分             |

`pnpm create arkor my-arkor-app --template triage` のようにプロンプトをスキップできます。

## なぜ Arkor か

カスタムなオープンウェイトモデルが今日現実的な選択肢となっているのは、Python ML エコシステムでの長年の取り組みと、それを築き上げた人々や企業のおかげです。
Arkor はその基盤の上に立っています。

私たちが欲しかった、しかし見つからなかったのは、TypeScript と Node の開発者がすでに行っている働き方に馴染むパスでした。ファインチューニング、評価、サービングがプロダクトと同じコードベースに同居し、同じエディタ、型、レビューフローで扱えるようなワークフローです。

別ファイルの設定ではなく型安全な config を。開発ループのためのローカル Studio を。

私たちが何度も立ち返るフレーズはこれです。**プロダクトを送り出すのと同じ方法でモデルを送り出す。** これが正しいと感じるなら、あなたが対象ユーザーです。

## 今動くもの

- [x] **1 ファイルでオープンウェイト LLM をファインチューニング。** `createTrainer({ model, dataset, lora, ... })` が、指定したベースモデルに対して LoRA トレーニングを実行します。
- [x] **エンドツーエンドで動く 3 つの厳選テンプレート。** `triage`、`translate`、`redaction` は同じ Gemma 4 ベースとパブリック HuggingFace データセットを組み合わせ、数分で完走します。
- [x] **ダッシュボードではなくコードでトレーニングに反応。** ライフサイクルコールバック (`onStarted`、`onLog`、`onCheckpoint`、`onCompleted`、`onFailed`) は、クラウドからストリーミングされる実行に応じて、完全に型付けされた状態で発火します。
- [x] **実行が終わる前にモデルを軽くチェック。** `onCheckpoint` の中から、トレーニング中のモデルに対して `infer({ messages })` を呼び出せます。
- [x] **ローカル Studio で実行を見守る。** `arkor dev` は、ジョブ一覧、ライブの loss チャート、ログテール、ファインチューニング済みモデルとチャットできる Playground を備えた UI を開きます。
- [x] **アカウントなしで試す。** `arkor dev` はそのまま新しい匿名ワークスペースで起動します。アカウントに紐付けたい場合は `arkor login --oauth` で Arkor Cloud の OAuth (PKCE) フローを開始してください。

## これから来るもの

### Framework API

- [ ] **小さなシードセットからの合成トレーニングデータ生成。**
- [ ] **互換性のある teacher / student モデルを組み合わせた蒸留向けテンプレート。**
- [ ] **小型・オンデバイスモデル向けのテンプレート** (WebGPU、モバイル)。

### SDK と CLI

- [ ] **ローカル GPU でのトレーニング。** 現状はすべての実行が Arkor のマネージド GPU に送られます。
- [ ] **JSONL ファイルから自前のデータセットを持ち込む。** 現状でも、HuggingFace の任意の名前と任意の blob URL (オプションで認証トークン付き) は既に動作します。
- [ ] **Gemma 4 以外のベースモデル。**

### Studio

- [ ] **トレーニング済みモデルをファイルとしてダウンロード**して、自分のマシンや任意のデプロイ先で動かせるようにする。現状、実行は Arkor のマネージド推論上に留まります。
- [ ] **dry-run オプションを UI に表面化** して、高速なスモークテストを実現する。

### その他

- [ ] **トレーニングバックエンドのセルフホスト。** 現状は私たちがホストしています。
- [x] **本格的なドキュメントサイト。** ソースは [`docs/`](docs) にあり、公開サイトは [docs.arkor.ai](https://docs.arkor.ai) です。

## API のさわり

```ts
// src/arkor/trainer.ts
import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "support-bot-v1",
  model: "unsloth/gemma-4-E4B-it",
  dataset: { type: "huggingface", name: "arkorlab/triage-demo" },
  lora: { r: 16, alpha: 16 },
  maxSteps: 100,
  callbacks: {
    onLog: ({ step, loss }) => console.log(`step=${step} loss=${loss}`),
    onCheckpoint: async ({ step, infer }) => {
      const res = await infer({ messages: [{ role: "user", content: "Hello!" }] });
      console.log(`ckpt @ ${step}:`, await res.text());
    },
  },
});
```

```ts
// src/arkor/index.ts  ← `arkor dev` / `arkor build` から発見される
import { createArkor } from "arkor";
import { trainer } from "./trainer";

export const arkor = createArkor({ trainer });
```

`src/arkor/index.ts` が CLI と Studio が探しに行くファイルです。
`trainer` は同じ階層の別ファイルに置き、`createArkor` 経由で登録します。

<!--
  Studio screenshots go here once captured:
    - assets/studio-jobs.png        Jobs list
    - assets/studio-chart.png       Live loss + log tail
    - assets/studio-playground.png  Playground chat
-->

## プロジェクトの中身

```
my-arkor-app/
├── src/arkor/
│   ├── index.ts        # createArkor({ trainer })  ← CLI / Studio から発見される
│   └── trainer.ts      # createTrainer({ ... })
├── arkor.config.ts
├── .arkor/             # 状態 + ビルド成果物 (gitignore 済み)
└── package.json        # dev / build / start
```

## CLI

| コマンド                                            | 用途                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `arkor init`                                       | カレントディレクトリに新しいプロジェクトをスキャフォールド             |
| `arkor login` / `arkor logout` / `arkor whoami`    | Arkor Cloud の OAuth (PKCE) / 匿名トークン                            |
| `arkor dev`                                        | ローカル Studio Web UI を起動                                         |
| `arkor build`                                      | `src/arkor/index.ts` を `.arkor/build/index.mjs` にバンドル           |
| `arkor start`                                      | ビルド成果物を実行 (なければ自動ビルド)                               |

スキャフォールド済みプロジェクトでは `pnpm dev` が `arkor dev` に解決されるので、ほとんどのワークフローはそのコマンド 1 つの裏に収まります。

## アーキテクチャ

`arkor dev` は [Hono](https://hono.dev) サーバーを `127.0.0.1:4000` で起動し、同一オリジンから Vite + React SPA を配信します。

SPA は起動ごとの CSRF トークンでゲートされた `/api/*` ルート (ループバック専用、DNS リバインディング対策の `Host` ヘッダーガード付き) を通じてあなたのコードと通信します。あなたのコードは認証付き HTTPS で Arkor トレーニングバックエンドと通信します。

トレーニングはマネージド GPU 上で実行され、チェックポイントは SSE イベントとしてストリームバックされ、プロセス内であなたの `callbacks.*` を発火させます。

## リポジトリ

| パッケージ                                     | 内容                                       |
| ---------------------------------------------- | ------------------------------------------ |
| [`arkor`](packages/arkor)                      | SDK + CLI + バンドル済みローカル Studio    |
| [`create-arkor`](packages/create-arkor)        | `pnpm create arkor` スキャフォルダー       |
| [`docs`](docs)                                 | [docs.arkor.ai](https://docs.arkor.ai) の Mintlify ソース (`pnpm --filter @arkor/docs docs:dev`) |

Node.js 22.6+ が必要です。
(このリポジトリへの貢献には Node.js 24、できれば最新版の利用を推奨します。)

pnpm / npm / yarn / bun で動作します。

## オープンに開発しています

Arkor は alpha 段階で、コアアイデア (プロダクトエンジニアのための TypeScript ネイティブなファインチューニング) は、それを使うであろう人たちと*一緒に*設計したいものです。
あなたがその一人なら:

- 動いてほしいモデル + データセット + ワークフローについて **[Issue を立ててください](https://github.com/arkorlab/arkor/issues/new)**。すべて読んでいます。
- `0.1` に向かう過程の更新を受け取りたければ **リポジトリにスターを** ください。
- ライブな議論や早期アクセスの通知が欲しければ **[Discord に参加](https://discord.gg/YujCZYGrEZ)** してください。

開発セットアップについては [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照してください。

## ライセンス

[MIT](LICENSE.md)
