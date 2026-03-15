import { describe, it, expect } from 'bun:test';
import { createSSEUsageExtractor } from '../../src/utils/sse-parser';

const encoder = new TextEncoder();

function makeSSEChunk(lines: string[]): Uint8Array {
  return encoder.encode(lines.map(l => `data: ${l}\n\n`).join(''));
}

async function pipeChunks(chunks: Uint8Array[], extractor: ReturnType<typeof createSSEUsageExtractor>) {
  const reader = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  }).pipeThrough(extractor.transformStream);

  const output: Uint8Array[] = [];
  const outputReader = reader.getReader();
  while (true) {
    const { done, value } = await outputReader.read();
    if (done) break;
    output.push(value);
  }
  return output;
}

describe('createSSEUsageExtractor', () => {
  it('正常 SSE 序列擷取 usage', async () => {
    const extractor = createSSEUsageExtractor();
    const chunks = [
      makeSSEChunk([
        '{"id":"chatcmpl-1","choices":[{"delta":{"content":"Hi"}}]}',
        '{"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
        '[DONE]',
      ]),
    ];
    await pipeChunks(chunks, extractor);
    const usage = extractor.getUsage();
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('跨 chunk 的不完整行 (line buffer)', async () => {
    const extractor = createSSEUsageExtractor();
    // Split a line across two chunks
    const part1 = encoder.encode('data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"id":"chatcmpl-1","us');
    const part2 = encoder.encode('age":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}}\n\ndata: [DONE]\n\n');
    await pipeChunks([part1, part2], extractor);
    const usage = extractor.getUsage();
    expect(usage).toEqual({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
  });

  it('多個 SSE 事件在同一 chunk', async () => {
    const extractor = createSSEUsageExtractor();
    const chunk = makeSSEChunk([
      '{"id":"1","choices":[{"delta":{"content":"A"}}]}',
      '{"id":"2","choices":[{"delta":{"content":"B"}}]}',
      '{"id":"3","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
      '[DONE]',
    ]);
    await pipeChunks([chunk], extractor);
    const usage = extractor.getUsage();
    expect(usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  });

  it('無 usage chunk 回傳 null', async () => {
    const extractor = createSSEUsageExtractor();
    const chunks = [
      makeSSEChunk([
        '{"id":"chatcmpl-1","choices":[{"delta":{"content":"Hi"}}]}',
        '{"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop"}]}',
        '[DONE]',
      ]),
    ];
    await pipeChunks(chunks, extractor);
    expect(extractor.getUsage()).toBeNull();
  });

  it('malformed JSON warn 並跳過', async () => {
    const extractor = createSSEUsageExtractor();
    const chunks = [
      makeSSEChunk([
        '{invalid json here',
        '{"id":"1","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
        '[DONE]',
      ]),
    ];
    // Should not throw, should still capture usage from valid chunk
    await pipeChunks(chunks, extractor);
    const usage = extractor.getUsage();
    expect(usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });

  it('data: [DONE] 不觸發 JSON.parse', async () => {
    const extractor = createSSEUsageExtractor();
    const chunks = [makeSSEChunk(['[DONE]'])];
    // Should not throw
    await pipeChunks(chunks, extractor);
    expect(extractor.getUsage()).toBeNull();
  });

  it('非 data: 行被忽略', async () => {
    const extractor = createSSEUsageExtractor();
    // Include SSE comments and event type lines
    const raw = encoder.encode(': this is a comment\nevent: message\ndata: {"usage":{"prompt_tokens":7,"completion_tokens":8,"total_tokens":15}}\n\ndata: [DONE]\n\n');
    await pipeChunks([raw], extractor);
    const usage = extractor.getUsage();
    expect(usage).toEqual({ prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 });
  });

  it('chunk 原樣轉發不修改 bytes', async () => {
    const extractor = createSSEUsageExtractor();
    const original = makeSSEChunk([
      '{"id":"1","choices":[{"delta":{"content":"Hello"}}]}',
      '[DONE]',
    ]);
    const output = await pipeChunks([original], extractor);
    // Concatenate output chunks and compare to original
    const outputBytes = new Uint8Array(output.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const c of output) {
      outputBytes.set(c, offset);
      offset += c.length;
    }
    expect(outputBytes).toEqual(original);
  });
});
