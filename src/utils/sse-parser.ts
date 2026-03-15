export interface SSEUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface SSEUsageExtractor {
  transformStream: TransformStream<Uint8Array, Uint8Array>;
  getUsage(): SSEUsage | null;
}

/**
 * 建立 SSE usage 擷取器。
 * TransformStream 原樣轉發所有 chunk（不修改 bytes），
 * 同時以 line buffer 解析 SSE 事件並捕獲 usage 資料。
 */
export function createSSEUsageExtractor(): SSEUsageExtractor {
  let usage: SSEUsage | null = null;
  let buffer = '';
  const decoder = new TextDecoder();

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // 原樣轉發
      controller.enqueue(chunk);

      // 解析 SSE
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      // 最後一段可能不完整，保留在 buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6); // 去掉 'data: ' prefix
        if (payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          if (parsed.usage) {
            usage = {
              prompt_tokens: Number(parsed.usage.prompt_tokens ?? 0),
              completion_tokens: Number(parsed.usage.completion_tokens ?? 0),
              total_tokens: Number(parsed.usage.total_tokens ?? 0),
            };
          }
        } catch {
          console.warn('[sse-parser] Failed to parse SSE data:', payload.slice(0, 100));
        }
      }
    },

    flush() {
      // 處理 buffer 中剩餘的內容
      if (buffer.startsWith('data: ') && buffer.slice(6) !== '[DONE]') {
        try {
          const parsed = JSON.parse(buffer.slice(6));
          if (parsed.usage) {
            usage = {
              prompt_tokens: Number(parsed.usage.prompt_tokens ?? 0),
              completion_tokens: Number(parsed.usage.completion_tokens ?? 0),
              total_tokens: Number(parsed.usage.total_tokens ?? 0),
            };
          }
        } catch {
          // ignore
        }
      }
      buffer = '';
    },
  });

  return {
    transformStream,
    getUsage() {
      return usage;
    },
  };
}
