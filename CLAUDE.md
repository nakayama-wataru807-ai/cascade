# CLAUDE.md

Claude Code 向けの運用メモ。ユーザー向け説明は README.md を参照。

## 概要

毎日の習慣を積み上げる自己管理 PWA「Cascade」。スマホのホームスクリーンに追加し、SNS を開く前に最初に開く場所として設計。

- **公開URL**: https://nakayama-wataru807-ai.github.io/cascade/
- **GitHubリポジトリ**: github.com/nakayama-wataru807-ai/cascade（public・SSH接続済み）
- **構成**: `index.html`（全CSS/JS内包・約2,600行）・`manifest.json`・`sw.js`・`icons/`（PIL生成の積層モチーフ192/512）
- **スタック**: 純粋 HTML/CSS/JS（フレームワーク不使用）、localStorage キー `cascade_v1`、PWA（Service Worker は Cache First）
- **機能（Phase 1 MVP）**: Morning Gate（毎日1回・格言・意図・ストリーク積層） / 習慣スタック8項目（タップ完了・達成率リング・週間ヒートマップ） / タスク（ローカルのみ） / 夜の記録（一言日記・満足度・明日のタスク）
- **デザイン**（2026-09-02 モダンミニマルへ全面刷新）: モノクロ基調＝白 `#FFFFFF`・インク `#1A1A1A`・グレー `#6B6B6B`・ヘアライン `rgba(0,0,0,.10)`、アクセントはシグナルオレンジ `#F0531C` を極小面積のみ（グラフの「今日」の点＝フチなしオレンジ丸・選択中ナビと期間切替の下線・習慣チェックの完了塗り＝オレンジ地に白チェック。文字色には使わない。2026-09-03 に蛍光黄緑 `#EAF33E` から変更＝モノクロ基調に対し明度・彩度が高すぎて浮いたため）。フォントはシステム書体（2026-11-07 にウェブフォントの Noto Sans JP・Inter をやめた。起動時の転送930KBの約95%がフォントだったため。`--font-gothic`・`--font-latin` を参照）。カードの塗り・影・色つき左罫・指標別8色は廃止し、1px ヘアライン＋余白で構成。グラフの折れ線はモノクロの濃淡グラデーション（`#1C1C1C`〜`#787878` を指標ごとに割当・`CHART_COLORS`）で区別。スクロール連動の出現演出・bounce・scale-snap も廃止。参考事例＝toshiyukihashimoto.jp / growth-next.com。旧「木骨（きこつ）」パレット（生成り・木・墨）は廃止

## 連続日数（2026-11-07 再設計）

アプリ全体の連続日数を、習慣タブの最上部（大きな数字・直近7日の点・最高日数・今日のあと何個）とホーム最上部（1行）に表示する。**1日に `STREAK_MIN`（=10）個以上の習慣を達成した日を「記録した日」と数える**（2026-11-08 本人指示で5→10個。直近30日の実績は中央値14個・最大23個。変えるときは `STREAK_MIN` だけ）。今日が基準に届くまでは昨日までの連続日数を見せる（今日は猶予）。保存データは増やさず、`store.habits.logs` から毎回計算する（`appStreak()`・`renderStreakHero()`）。習慣ごとの連続日数（`habitStreak`）は従来どおり。

## 起動を軽くする工夫（2026-11-07）

人物・語学のデータ JSON は、そのタブを初めて開いたときに読む（`ensurePersonLoaded`・`ensureLangLoaded`）。起動時に先読みするのは、ホームの「本日のメニュー」に使う `schedule.json`・`workout_schedule.json` のみ。ウェブフォントは使わない。改修の方針（1アプリ1機能への分割）は Vault `General/Cascade/` と Notion「改善カード」を参照。

## 口座残高の自動更新（2026-11-07 導入。改善カード IC-10）

口座残高は手入力ではなく、PC 側の `General/scripts/bank_balance_update.py` が三井住友の入出金メールから推定し、非公開リポジトリ `personal_sync` の `cascade/state.json` の `bankLog` に今日の日付の1件（`src:'mail'`・`unknown`・`ts` つき）を書く。アプリは起動の3秒後（30分に1回まで）に同期先の `bankLog` だけを取り込み（`pullBankFromRemote`）、ホームの口座残高に「入出金メールから自動計算」と注記する。同じ日付の合流は `ts` が新しい方を採る（`mergeLogs`。手入力にも `ts` が付く。`ts` が無いログは従来どおり端末優先）。基準の残高の置き方・金額不明の扱いは Vault `General/Automation/夜の改善ループ_設計_2026-11-07.md` と `/end` の手順を参照。

## 語学アプリ（`lang/`・2026-11-07 に本体から切り出し。改善カード IC-3 の手順3）

語学は別アプリになった: <https://nakayama-wataru807-ai.github.io/cascade/lang/>。自前の `manifest.json`・`sw.js`（スコープ `/cascade/lang/`）・`icons/` を持ち、ホーム画面に単独で追加できる（約29KB。本体は約115KB）。データは従来どおり `lang/de.json`・`lang/ko.json`（動詞は末尾に足すだけ）。

- **保存**: 本体と同じ localStorage キー `cascade_v1` を共有する。語学アプリが書くのは `store.lang` と、つぶやきの自動チェック（習慣 `h33`）だけ。保存のたびに最新を読み直し（`saveStore`）、他のスライスは触らない。別アプリから戻ったときも読み直す（`visibilitychange`。本体側にも同じ処理を入れた）。
- **同期**: 語学の進捗だけを `personal_sync/cascade/state.json` に合流して書く（`syncLang`・`mergeLang`）。同期先の形式が読めないときは上書きしない。**iPhone では、ホーム画面に追加したアプリごとに保存領域が別になる可能性が高い**（未検証）ため、語学アプリ自身に「同期の設定」（リポジトリ・ファイルの場所・トークン。キーは本体と同じ `cascade_gh_v1`）を持たせ、設定があれば起動2秒後（30分に1回まで）に同期先の進捗を取り込む。ホーム画面に追加した直後は、ここにトークンを入れて進捗を取り込む。**1アプリ1機能の分割では、アプリ間の保存共有を当てにせず、同期先（personal_sync）を共通の正本にする**（以降の切り出しも同じ方針）。
- **本体の語学タブ（撤去済み・2026-11-08）**: 本体から語学の画面・コード・CSS を外し、下部ナビの「語学 ↗」を `./lang/` へのリンクにした。本体に残したのは、同期で `store.lang` を壊さないための `mergeLang` と、保存データの整形（`migrate`）だけ。語学のロジックを直すときは `lang/index.html` だけを直す。
- **Service Worker**: 本体の `sw.js` は `/lang/` のページ（HTML）を扱わず、キャッシュの掃除も自分の `cascade-*` だけにした。同じオリジンの `fp3/sw.js`・`kenchiku/sw.js` は、まだ他アプリのキャッシュも消す作りのまま（未対応）。

## 人物アプリ（`person/`・2026-11-08 に本体から切り出し。改善カード IC-3 の手順4）

人物研究は別アプリになった: <https://nakayama-wataru807-ai.github.io/cascade/person/>。語学アプリと同じ作り（自前の `manifest.json`・`sw.js`（スコープ `/cascade/person/`、キャッシュ `person-v1`）・`icons/`・「同期の設定」）。月次データ `person-study/<YYYY-MM>.json` は従来の場所のまま（`/person` スキルの出力先は変えない）で、アプリは `../person-study/` から読む。

- **保存**: `store.personStudy` と、メモ保存の自動チェック（習慣 `h31`）だけを書く。保存のたびに最新を読み直し、`mergePerson` で他アプリのメモを失わないようにして書く。
- **同期**: 人物メモの合流は月ごとに、開いた日の和集合・日ごとのメモ（`ts`＋本文で重複排除）・全体メモ（空のとき取り込む）。本体の `mergeStore` も同じ `mergePerson` を使う（以前は月単位の置き換えで、別端末のメモが消えうる状態だった）。同期の設定は語学アプリと同じ方針で、アプリ自身が持つ（キー `cascade_gh_v1`）。
- **本体の人物タブ**: 動作確認のあと撤去する（撤去したら、この節に日付を書く）。
- **本体の `sw.js`**: `/person/` のページに触らない（`cascade-v15`）。

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

## 語学ページ（2026-09-19 追加）

アプリ内「語学」タブ。ドイツ語・韓国語を1日1動詞ずつ、例文・つぶやき・間隔反復の復習で積み上げる。
独検3級（2026-12-06）・ハン検4級（2026-11-08）の補完で、試験対策の主役は問題集のまま。

- **データ**: `lang/de.json`・`lang/ko.json`（公開リポジトリ・Claude が生成）。動詞は**末尾に足すだけ**で、並べ替え・削除・id 変更はしない（進捗が id と「次の位置 `next`」に依存するため）。1語＝見出し・意味・活用欄・型・例文2つ（`{{…}}` は復習で伏せる箇所）・つぶやき用の穴埋め文。
- **進捗**: `store.lang[言語] = { next, prog:{id:{ease,interval,reps,lapses,due,last}}, days:{日付:{n,s,r}} }`。端末保存＋GitHub 同期（`mergeLang` が動詞ごと・日付ごとにマージ）。
- **復習**: SM-2 は `fp3/app.js` と同じ式。ただし**試験日による間隔の頭打ちは付けない**（毎日新規が増える語学で付けると、試験直前2週間の復習が1日17〜28件/言語に急増する試算）。復習は言語ごとに1日10件まで（`LG_DAILY_CAP`）。
- **習慣連動**: 「つぶやいた」で習慣 `h33`（外国語独り言）を自動チェックする。同様に、人物研究のメモ保存で `h31`、筋トレカードでワークアウト時間（1分以上）を記録すると `h12`（朝トレ）を自動チェックする（2026-10-19。0分の記録はチェックしない）。
- **音声**: 端末内蔵の音声合成（`speechSynthesis`）。音声ファイルは持たない（cache-first の陳腐化を避けるため）。
- **注意**: `/fp3 push`・`/kenchikushi push` は cascade 全体を `git add -A` でコミットする。語学の作業は未コミットのまま残さない。

## Service Worker の注意（2026-09-01 修正済み）

データ JSON を `?v=Date.now()` で取得すると SW 汎用ハンドラがキャッシュを無制限に肥大化させる。
`sw.js` はデータ JSON をクエリ除去キーで network-first 保存する実装（1ファイル1エントリ固定）。
新規のデータ取得は `fetch(path, {cache:'no-store'})` で行い、URL にクエリを付けない。
