// 每百萬 token 的 USD 費率（input = prompt tokens，output = completion tokens）
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o':            { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':       { input: 0.15,  output: 0.60  },
  'gpt-4-turbo':       { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo':     { input: 0.50,  output: 1.50  },
  'claude-sonnet-4-5': { input: 3.00,  output: 15.00 },
  'claude-haiku-3-5':  { input: 0.80,  output: 4.00  },
};

// 未知 model 的預設費率
const DEFAULT_PRICING = { input: 5.00, output: 15.00 };

/**
 * 根據 model 和 token 數量計算費用（USD）
 * @param model - 模型名稱
 * @param promptTokens - prompt tokens 數量
 * @param completionTokens - completion tokens 數量
 * @returns 費用 USD，精度到小數第 6 位
 */
export function calculateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  const cost = (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
  // 四捨五入到小數第 6 位，避免浮點數累積誤差
  return Math.round(cost * 1_000_000) / 1_000_000;
}
