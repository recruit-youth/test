# Agent diagnosis demo

## Files

- `index.html`: フロント画面（30問診断 + 面談予約）
- `gas/Code.gs`: Google Apps Script のバックエンド実装

## GAS setup

1. スプレッドシートに `agents` シート・`applications` シートを用意
2. `gas/Code.gs` をGASエディタに貼り付け
3. Webアプリとしてデプロイ（実行ユーザー: 自分 / アクセス: 全員）
4. `index.html` 内の `WEB_APP_URL` をデプロイした `/exec` URL に置換

## Behavior

- `action: "diagnose"`: `agents` シートから回答条件に近いエージェントを最大3件返却
- `action: "reserve"`: 面談完了時に回答内容 + 完了時刻 + 選択エージェント情報を `applications` に1行追記
