# BaySpark Helper

BaySparkの商品管理画面（`https://bridgemencalendar.com/*`）向けの一括処理を補助するTampermonkeyユーザースクリプトです。

## インストール方法

1. [Tampermonkey](https://www.tampermonkey.net/) をブラウザに導入します。
2. Tampermonkeyのダッシュボードを開き、「新規スクリプトを作成」を選択します。
3. [main.user.js](./main.user.js) の内容を貼り付けて保存します。
4. `https://bridgemencalendar.com/*` を開くと、右上に「BaySpark Helper」ボタンが表示されます。

## 機能

- 右上の「BaySpark Helper」ボタンから操作パネルを表示
- 🚀 一括処理（SKU入力 → 販売価格提案 → Shipping割り当て → カテゴリ変更 → Item Specifics作成 → SKU連番入力）
- 🏷 SKUのみ入力
- 📦 販売価格に応じてShippingを割り当て のみ実行
- 👜 ストアカテゴリー一括変更のみ実行
- 📝 Item Specificsを作成のみ実行
- 💰 販売価格提案のみ実行
- ⚙ 設定（ストアカテゴリ名・各待機時間を保存）
- 🧹 処理ログのクリア
- 処理中の進捗表示・ボタンロック
- SKU入力時の自動スクロール

## 設定項目（localStorageに保存）

| 項目 | 初期値 |
| --- | --- |
| ストアカテゴリ名 | `Bags` |
| カテゴリ反映待機時間 | 8000ms |
| Item Specifics待機時間 | 8000ms |

## 注意事項

「Shippingポリシー一括変更」ではなく「販売価格に応じてShippingを割り当て」を使用しています。
