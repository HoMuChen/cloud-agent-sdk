# CLI Example

互動式 CLI 對話範例，包含天氣查詢、數學計算、時間查詢三個 tools。

## 使用方式

```bash
cd examples/cli
npm install
export ANTHROPIC_API_KEY=你的key
npm start
```

## 範例對話

```
You > 台北天氣如何？
AI  > 
  [呼叫 get_weather] → {"city":"台北","temperature":27,"condition":"晴天"}
台北目前天氣晴天，氣溫約 27°C。
  (150+45 tokens, 1200ms)

You > 幫我算 123 * 456
AI  > 
  [呼叫 calculate] → {"expression":"123 * 456","result":56088}
123 × 456 = 56,088
  (120+30 tokens, 800ms)

You > exit
Bye!
```
