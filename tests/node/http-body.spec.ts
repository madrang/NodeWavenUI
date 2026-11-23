/**
 * Specs for the shared request body reader: the chunks join and decode once, an empty body reads
 * as an empty string, and a body over the cap fails with the status of the refusal.
 */

import { expect } from 'chai';
import { Readable } from 'node:stream';
import { BodyLimitError, readRequestBody } from '../../dist/shared/http-body.js';

/** Builds one request stream over the given chunks. */
function streamOf(chunks: readonly Uint8Array[]): Readable {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
}

describe('the request body reader', () => {
  it('joins the chunks and decodes a character split across a chunk boundary once', async () => {
    const text = 'café — done';
    const bytes = Buffer.from(text, 'utf-8');
    const split = bytes.indexOf(Buffer.from('é', 'utf-8')) + 1;
    const body = await readRequestBody(streamOf([bytes.subarray(0, split), bytes.subarray(split)]), 1000);
    expect(body).to.equal(text);
  });

  it('reads an empty body as an empty string', async () => {
    expect(await readRequestBody(streamOf([]), 1000)).to.equal('');
  });

  it('accepts a body exactly at the cap', async () => {
    const body = await readRequestBody(streamOf([Buffer.alloc(1000, 65)]), 1000);
    expect(body).to.have.lengthOf(1000);
  });

  it('refuses a body over the cap with the status of the refusal, and pauses the stream', async () => {
    // The source stays open, so the end of a finished stream cannot mask the pause.
    const stream = new Readable({ read() {} });
    stream.push(Buffer.alloc(600));
    stream.push(Buffer.alloc(600));
    let refusal: unknown = null;
    try {
      await readRequestBody(stream, 1000);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).to.be.instanceOf(BodyLimitError);
    expect((refusal as BodyLimitError).status).to.equal(413);
    expect((refusal as BodyLimitError).text).to.equal('The request body passes 1000 bytes.');
    // The reader pauses the stream, so the caller can answer before it destroys the stream.
    expect(stream.destroyed).to.equal(false);
    stream.destroy();
  });
});
