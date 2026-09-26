export async function readProgressStream(response, onProgress, messages) {
  const errorMessage = data => [data?.error, data?.message].filter(value => typeof value === 'string' && value).join(': ') || messages.failed;
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const data = await response.json().catch(() => null);
    throw new Error((data?.error || !response.ok) ? errorMessage(data) : messages.incomplete);
  }
  if (!response.body) throw new Error(messages.incomplete);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = line => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(messages.invalid);
    }
    if (event?.type === 'error') throw new Error(errorMessage(event));
    if (event?.type === 'complete' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) return event.data;
    if (event?.type !== 'progress') throw new Error(messages.invalid);
    onProgress(event);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let start = 0;
      let end;
      while ((end = buffer.indexOf('\n', start)) !== -1) {
        const line = buffer.slice(start, end).trim();
        start = end + 1;
        if (line) {
          const data = consume(line);
          if (data) return data;
        }
      }
      buffer = buffer.slice(start);
      if (done) {
        if (buffer.trim()) {
          const data = consume(buffer.trim());
          if (data) return data;
        }
        throw new Error(messages.incomplete);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
