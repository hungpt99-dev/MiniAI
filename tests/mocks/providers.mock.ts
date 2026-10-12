/** Fake SSE fetch helper for provider tests — no network. */
export function sseResponse(chunks: string[]): Response {
  const text = chunks.join('');
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(bytes); c.close(); },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

export function openAIChunks(): string[] {
  return [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
}

export function mockFetchOnce(res: Response): typeof fetch {
  return (async () => res) as unknown as typeof fetch;
}

export function mockFetchStatus(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}
