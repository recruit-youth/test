# 適職診断 + 3カレンダー予約導線

Meta広告からの流入後に、すぐ入力できる適職診断フォームを表示し、入力内容をもとに3つの予約カレンダーを提示するサンプルです。

## 実装している要件

- Meta広告から通常遷移できるランディングページ
- 即入力できる診断フォーム（名前・メール・年代・興味・優先事項）
- 入力結果から3つのカレンダー候補を表示
- 各カレンダーは予約導線を持つ（別タブで予約フローへ）
- 予約後に通常画面へ戻れる導線（自動戻り + 手動戻り）
- 予約状態の反映（localStorage）

## ファイル構成

- `index.html`: 診断入力と3カレンダー表示UI
- `app.js`: スコアリング、表示制御、予約状態管理
- `styles.css`: スタイル
- `booking-complete.html`: 予約完了後の戻りページ

## ローカル起動

```bash
python3 -m http.server 8080
```

ブラウザで以下にアクセス:

- `http://localhost:8080/index.html`

## Meta広告からの流入例

```text
https://your-domain.example/index.html?utm_source=meta&utm_campaign=spring_offer
```

`utm_source` と `utm_campaign` はフォーム送信データに保持され、予約URLのクエリにも引き継がれます。

## 予約カレンダーURLの差し替え

`app.js` 内の `domainCalendars` にある `bookingBaseUrl` を、実運用のカレンダーURLへ置き換えてください。

## 予約後の戻り挙動

- 診断画面で「この枠を予約する」を押す
- 別タブで `booking-complete.html` を開く
- その画面から実カレンダーへ進んで予約
- 「診断画面に戻る」または自動戻りで通常画面に復帰
- 予約済み状態を診断画面に反映
