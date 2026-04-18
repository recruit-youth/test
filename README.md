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
  - `reservations` シートはリクエスト内で1回だけ読み取り、メモリ上のインデックスで空き枠判定・月間上限判定・最新予約参照を行うため、予約処理の体感速度を改善

## WordPress 無料構成（推奨: 高速化）

GAS/スプレッドシート構成で遅延が気になる場合、WordPress の MySQL を使う構成に切り替えると予約処理が高速化しやすくなります。

### 追加ファイル

- `wordpress/youthjob-booking-api/youthjob-booking-api.php`
  - WordPress プラグイン
  - 既存フロントの `action` 形式に合わせた API を提供
  - DB テーブル（応募/予約/企業設定）を自動作成
  - 企業分離、月間14件上限、Google Calendar 連携（空き確認/作成/削除）対応

### 導入手順

1. WordPress サーバーにプラグインを配置  
   `wp-content/plugins/youthjob-booking-api/youthjob-booking-api.php`
2. WordPress 管理画面でプラグインを有効化
3. 管理画面メニュー `YouthJob Booking API` を開く
4. （Google Calendar連携する場合）Service Account JSON を設定して保存
5. 会社設定（agent_name / token / calendar_id / slot_candidates）を登録
6. フロント側 API URL を WordPress REST に設定

### フロント API 設定

`index.html` は次の優先順で API URL を決定します:

1. `window.WP_BOOKING_API_URL`（WordPress側でグローバル注入した場合）
2. `window.WEB_APP_URL`（既存互換）
3. `const WP_BOOKING_API_URL`（ファイル内定数）
4. `const GAS_WEB_APP_URL`（フォールバック）

既定値:

- `WP_BOOKING_API_URL`: `https://example.com/wp-json/youthjob/v1/booking`（差し替え）
- `GAS_WEB_APP_URL`: 既存 Apps Script URL

### REST エンドポイント

- `POST /wp-json/youthjob/v1/booking`
  - `action`: `diagnose` / `get_availability` / `reserve_slot` / `reserve` / `update_reservation_status`
- `POST /wp-json/youthjob/v1/company-reservations`
  - `agent_name` + `company_token` で自社予約のみ取得
