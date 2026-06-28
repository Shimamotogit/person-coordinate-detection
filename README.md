# Stand & Answer - Camera AI Quiz

カメラで人物を検出し、画面上の回答ゾーンへ移動することでクイズに回答できるブラウザアプリです。

## 主な機能

- TensorFlow.js / COCO-SSD によるブラウザ内の人物検出
- 人物の足元位置を使った立ち位置回答
- 2択だけでなく、任意個数の選択肢に対応
- 回答エリアに一定時間滞在すると回答を確定
- 人物の頭上に現在のポイントを表示
- JSONファイルから問題を読み込み、順番をランダム化
- カメラ映像をサーバーへ送信しないクライアント内処理

## 起動方法

カメラAPIと `fetch()` を利用するため、`file://` で直接開かず、ローカルHTTPサーバーから起動してください。

```bash
python -m http.server 8080
```

ブラウザで `http://localhost:8080` を開き、カメラの利用を許可します。

> 本番公開時は HTTPS が必要です。localhost は多くのブラウザで安全なコンテキストとして扱われます。

## 問題の追加・編集

`questions.json` を編集します。

```json
{
  "id": "sample",
  "text": "問題文",
  "choices": ["選択肢A", "選択肢B", "選択肢C"],
  "correctIndex": 1
}
```

- `choices`: 2個以上の可変長配列
- `correctIndex`: 正解の選択肢番号（0始まり）

共通設定も `questions.json` から変更できます。

```json
{
  "settings": {
    "pointsPerCorrectAnswer": 100,
    "holdDurationMs": 1200,
    "resultDisplayMs": 1300
  }
}
```

## 判定方法

人物検出ボックスの下辺中央を「足元」とみなし、画面下部の回答エリアを選択肢数で等分します。足元が同じエリア内に `holdDurationMs` 以上留まると回答を確定します。

現在は最も信頼度が高い1人をプレイヤーとして扱います。

## ファイル構成

```text
.
├── index.html
├── styles.css
├── app.js
├── questions.json
└── README.md
```

## 注意事項

- カメラから全身、特に足元が見えるように配置してください。
- 暗い場所や人物が小さい場合は検出精度が下がります。
- CDNからTensorFlow.jsとモデルを取得するため、初回起動時はインターネット接続が必要です。
