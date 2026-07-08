# CLAUDE.md

Claude Code 向けの運用メモ。ユーザー向け説明は README.md を参照。

## 概要

毎日の習慣を積み上げる自己管理 PWA「Cascade」。スマホのホームスクリーンに追加し、SNS を開く前に最初に開く場所として設計。

- **公開URL**: https://nakayama-wataru807-ai.github.io/cascade/
- **GitHubリポジトリ**: github.com/nakayama-wataru807-ai/cascade（public・SSH接続済み）
- **構成**: `index.html`（全CSS/JS内包・約950行）・`manifest.json`・`sw.js`・`icons/`（PIL生成の積層モチーフ192/512）
- **スタック**: 純粋 HTML/CSS/JS（フレームワーク不使用）、localStorage キー `cascade_v1`、PWA（Service Worker は Cache First）
- **機能（Phase 1 MVP）**: Morning Gate（毎日1回・格言・意図・ストリーク積層） / 習慣スタック8項目（タップ完了・達成率リング・週間ヒートマップ） / タスク（ローカルのみ） / 夜の記録（一言日記・満足度・明日のタスク）
- **デザイン**: カラーパレット「木骨（きこつ）」（生成り#F5F0E8・木#C4833A・墨#1C1C1A・竹・鉄錆）、フォント Shippori Mincho / Space Grotesk / BIZ UDGothic

## 更新手順

`~/projects/cascade/` を編集 → `git -C ~/projects/cascade push`（SSH 接続済み、GitHub Pages が自動反映、反映1〜3分）。

## Phase 2 拡張候補

Notion連携・体重グラフ・Focus Card/建築用語帳。設計は plan ファイル `~/.claude/plans/web-web-ui-sns-recursive-cascade.md` を参照。

## 一級建築士学習連携

`schedule.json` は 1st-ClassArchitect リポジトリの学習計画スキル（`/kenchikushi`）と連携している。
