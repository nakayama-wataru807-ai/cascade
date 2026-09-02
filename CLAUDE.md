# CLAUDE.md

Claude Code 向けの運用メモ。ユーザー向け説明は README.md を参照。

## 概要

毎日の習慣を積み上げる自己管理 PWA「Cascade」。スマホのホームスクリーンに追加し、SNS を開く前に最初に開く場所として設計。

- **公開URL**: https://nakayama-wataru807-ai.github.io/cascade/
- **GitHubリポジトリ**: github.com/nakayama-wataru807-ai/cascade（public・SSH接続済み）
- **構成**: `index.html`（全CSS/JS内包・約950行）・`manifest.json`・`sw.js`・`icons/`（PIL生成の積層モチーフ192/512）
- **スタック**: 純粋 HTML/CSS/JS（フレームワーク不使用）、localStorage キー `cascade_v1`、PWA（Service Worker は Cache First）
- **機能（Phase 1 MVP）**: Morning Gate（毎日1回・格言・意図・ストリーク積層） / 習慣スタック8項目（タップ完了・達成率リング・週間ヒートマップ） / タスク（ローカルのみ） / 夜の記録（一言日記・満足度・明日のタスク）
- **デザイン**（2026-09-02 モダンミニマルへ全面刷新）: モノクロ基調＝白 `#FFFFFF`・インク `#1A1A1A`・グレー `#6B6B6B`・ヘアライン `rgba(0,0,0,.10)`、アクセントは蛍光黄緑 `#EAF33E` を極小面積のみ（グラフの「今日」の点＝フチなし黄丸・選択中ナビと期間切替の下線・習慣チェックの完了塗り。文字色には使わない）。フォント Noto Sans JP（和文）／ Inter（英字・数値）。カードの塗り・影・色つき左罫・指標別8色は廃止し、1px ヘアライン＋余白で構成。グラフの折れ線はモノクロの濃淡グラデーション（`#1C1C1C`〜`#787878` を指標ごとに割当・`CHART_COLORS`）で区別。スクロール連動の出現演出・bounce・scale-snap も廃止。参考事例＝toshiyukihashimoto.jp / growth-next.com。旧「木骨（きこつ）」パレット（生成り・木・墨）は廃止

## 更新手順

`~/projects/cascade/` を編集 → `git -C ~/projects/cascade push`（SSH 接続済み、GitHub Pages が自動反映、反映1〜3分）。

## Phase 2 拡張候補

Notion連携・体重グラフ・Focus Card/建築用語帳。設計は plan ファイル `~/.claude/plans/web-web-ui-sns-recursive-cascade.md` を参照。

## 一級建築士学習連携

`schedule.json` は 1st-ClassArchitect リポジトリの学習計画スキル（`/kenchikushi`）と連携している。

## 人物研究連携

`person-study/<YYYY-MM>.json`（＋ `person-study/img/<YYYY-MM>/`・`person-study/index.json`）は
`/person` スキル（`~/projects/.claude/commands/person.md`）が毎月生成する。アプリ内「人物」タブが
1日1トピックのニュース形式で表示。ユーザーのメモは `store.personStudy` に端末保存（GitHub 同期対象・
公開リポジトリには載らない）。月末レポートは `/person report` が HTML で出力。

## Service Worker の注意（2026-09-01 修正済み）

データ JSON を `?v=Date.now()` で取得すると SW 汎用ハンドラがキャッシュを無制限に肥大化させる。
`sw.js` はデータ JSON をクエリ除去キーで network-first 保存する実装（1ファイル1エントリ固定）。
新規のデータ取得は `fetch(path, {cache:'no-store'})` で行い、URL にクエリを付けない。
