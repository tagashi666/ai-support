/**
 * Файл превысил предел размера. Отдельный тип вместо разбора текста ошибки:
 * маршрут загрузки отвечает на него 413, а не 502.
 */
export class UploadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Файл больше ${Math.floor(maxBytes / 1024 / 1024)} МБ`);
    this.name = 'UploadTooLargeError';
  }
}

/**
 * Пропускает поток загрузки, пока прочитано не больше `maxBytes`, и бросает
 * UploadTooLargeError на первом лишнем байте — до того, как его увидит запись
 * на диск.
 */
export async function* limitUploadBytes(source: AsyncIterable<Uint8Array>, maxBytes: number): AsyncGenerator<Uint8Array> {
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new UploadTooLargeError(maxBytes);
    yield chunk;
  }
}
