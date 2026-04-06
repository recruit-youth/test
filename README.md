# Agent diagnosis demo

## Files

- `index.html`: フロント画面（30問診断 + 面談予約）
- `gas/Code.gs`: Google Apps Script のバックエンド実装

## GAS setup

1. スプレッドシートに `agents` シート・`applicants` シート・`reservations` シートを用意
2. `gas/Code.gs` をGASエディタに貼り付け
3. Webアプリとしてデプロイ（実行ユーザー: 自分 / アクセス: 全員）
4. `index.html` 内の `WEB_APP_URL` をデプロイした `/exec` URL に置換

### agents シートの追加推奨列（会社別運用）

- `calendar_id`（または `google_calendar_id`）: 企業担当者のGoogleカレンダーID
- `company_token`: 企業側の予約一覧API閲覧トークン
- `company_reservations_spreadsheet_id`（任意）: 企業別予約一覧を書き出す先スプレッドシートID
- `company_reservations_sheet_name`（任意）: 企業別予約一覧のシート名（未指定時は自動生成）

## Behavior

- `action: "diagnose"`: `agents` シートから回答条件に近いエージェントを最大3件返却
- `action: "reserve"`: 面談完了時に回答内容 + 完了時刻 + 選択エージェント情報を `applicants` に1行追記（A列は完了時間、ヘッダーは日本語化）
- `reservations` シート: 予約ごとに1行で最新状態を更新して管理（日本語ヘッダー、時間項目は `yyyy/MM/dd/ HH:mm`）
- `action: "get_company_reservations"`: 会社別の予約一覧（予約者名・連絡先・予約日時）を返却
- 会社ごとの月間面談上限: **14件/月**（`booked` ベース）
- 予約確定時:
  - 企業担当者のGoogleカレンダーに面談イベントを自動登録
  - 会社別予約シートへ最新情報を同期
- 予約調整時:
  - 企業担当者カレンダーの既存予定を空き枠計算に反映
