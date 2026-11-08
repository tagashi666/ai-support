/** Читает HTTP-тело, не позволяя внешнему сервису занять всю память процесса. */
export async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Файл слишком большой: ${declared} байт, предел ${maxBytes}`);
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('size limit');
        throw new Error(`Файл превысил предел ${maxBytes} байт`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Ограничитель параллельности: не больше `max` задач одновременно, остальные
 * ждут в очереди по порядку. Нужен там, где внешний API режет частые запросы.
 */
export function limitConcurrency(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= max) return;
    const start = queue.shift();
    if (start) { active += 1; start(); }
  };
  return <T>(task: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    queue.push(() => {
      task().then(resolve, reject).finally(() => { active -= 1; next(); });
    });
    next();
  });
}
