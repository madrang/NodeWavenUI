/**
 * The reader of one HTTP request body, shared by the servers of the app: the MCP host of the main
 * process and the remote control server of the worker core. The chunks join once at the end,
 * because a per-chunk utf-8 decode splits a multi-byte character at a buffer boundary. The module
 * stays free of platform dependencies: the stream arrives through a structural type, so the
 * renderer project compiles the module beside the Node projects.
 */

/** The refusal of one request body: the status line the client reads. */
export class BodyLimitError extends Error {
  constructor(readonly status: number, readonly text: string) {
    super(text);
  }
}

/** The part of one request stream the reader needs. */
export interface BodyStream {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  /** Stops the intake without the socket reset of a destroy, so a refusal answer still reaches the client. */
  pause(): unknown;
}

/**
 * Reads the body of one request stream as text, under a size cap.
 *
 * @param stream The request stream.
 * @param limitBytes The cap of the body.
 * @returns The body text. An empty body reads as an empty string.
 * @throws BodyLimitError when the body passes the cap (status 413) or the read fails (status 400).
 * The reader pauses the stream on a refusal, so the caller can answer, then destroy the stream.
 */
export function readRequestBody(stream: BodyStream, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    stream.on('data', (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > limitBytes) {
        if (settled) {
          return;
        }
        settled = true;
        stream.pause();
        reject(new BodyLimitError(413, `The request body passes ${limitBytes} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new BodyLimitError(400, `The request body read failed: ${error.message}`));
    });
    stream.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(decode(chunks, size));
    });
  });
}

/** Joins the chunks into one buffer and decodes it once. */
function decode(chunks: readonly Uint8Array[], size: number): string {
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8').decode(joined);
}
