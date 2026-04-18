# Job Seeker Matching & Scheduling

求職者向けの以下フローを実装したサンプルです。

1. 求職者が質問へ回答
2. 回答に応じて 3 社を提案（各社の月間面談上限 14 件）
3. 同一画面から各社の空き枠を確認して日程調整
4. 予約完了画面で予約一覧・回答内容を確認し、無料 LINE 登録画面へ遷移

## 技術構成

- Frontend: Vanilla HTML/CSS/JS
- Backend: Node.js + Express
- DB: SQLite (`better-sqlite3`)
- 外部連携（任意設定）
  - Google Calendar（空き枠確認 + 予約作成）
  - Google Sheets（全体予約一覧 + 会社別予約一覧追記）
  - SMTP（会社担当者/求職者への通知メール）

## セットアップ

```bash
npm install
cp .env.example .env
npm run dev
```

起動後: `http://localhost:3000`

## 主要仕様

### 3 社提案ロジック

- 回答内容と会社の強みタグをスコアリング
- `monthly_capacity` テーブルで `company_id + year_month` ごとの予約数を管理
- `booked_count >= 14` の会社は提案対象から除外
- スコア上位 3 社を返却

### 日程調整

- 会社カードごとに「日程を調整する」ボタンを設置
- ボタン押下で当日以降の候補枠を表示（平日・営業時間帯）
- ローカル DB 予約 + Google Calendar の busy 情報を加味して空き枠を判定

### 予約確定時の処理

- 求職者予約一覧へ反映（`/bookings.html?seekerId=...`）
- 会社予約一覧 API へ反映（`/api/bookings/company/:companyId`）
- 会社の Google Calendar へイベント作成（設定時）
- 会社別スプレッドシート + 全体スプレッドシートへ追記（設定時）
- 担当者へメール送信（設定時）

## API 概要

- `GET /api/questions`
- `POST /api/recommendations`
- `GET /api/companies/:companyId/slots`
- `POST /api/bookings`
- `GET /api/bookings/seeker/:seekerId`
- `GET /api/bookings/company/:companyId`

## 環境変数

`.env.example` を参照してください。

- `GOOGLE_SERVICE_ACCOUNT_JSON` または `GOOGLE_SERVICE_ACCOUNT_PATH`
- `GLOBAL_BOOKING_SHEET_ID`
- `COMP_*_CALENDAR_ID` / `COMP_*_SHEET_ID`
- `SMTP_*`
- `LINE_REGISTRATION_URL`

## WordPress貼り付け版（同等フロー）

`wordpress/jobflow-matching-plugin.php` を追加しています。  
このプラグインを有効化すると、WordPress内で以下を同等フローで実行できます。

- 求職者質問 -> 3社提案 -> 日程調整 -> 予約完了 -> LINE遷移
- 会社ごとの月14件制限
- 予約一覧API（求職者/会社）

### 導入手順

1. `wp-content/plugins/jobflow-matching-plugin/jobflow-matching-plugin.php` として配置
2. 管理画面でプラグインを有効化
3. 固定ページ本文にショートコード `[jobflow_app]` を貼り付け
4. 「Jobflow設定」メニューで LINE 登録URL を設定

### 本番向け必須設定（WordPress版）

#### 1) セキュリティ
- `reCAPTCHA Site Key` / `reCAPTCHA Secret Key` を設定（v3想定）
  - 未設定時は reCAPTCHA チェックをスキップ
- 会社予約一覧 API (`/jobflow/v1/bookings/company/:companyId`) は管理者権限のみアクセス可
- API は IP 単位でレート制限を実施（10分あたり45リクエスト）

#### 2) Google連携（カレンダー/スプレッドシート）
- 「Google連携を有効化」を ON
- `Google Service Account JSON` を設定
- 会社ごとに以下を設定
  - `Google Calendar ID`
  - `会社別 Spreadsheet ID`
- 必要に応じて `全体予約一覧 Spreadsheet ID` を設定

#### 3) Google 側の権限
- サービスアカウントに各社カレンダーへの編集権限を付与
- 各スプレッドシートにサービスアカウントの編集権限を付与

### WordPress版の拡張フック

- `jobflow_google_busy_ranges`
- `jobflow_google_slot_is_free`
- `jobflow_google_create_event`
- `jobflow_append_to_sheet`

メール通知は `wp_mail` で実行します。必要に応じて `jobflow_should_send_mail` フィルタで制御できます。
