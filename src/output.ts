import {open, stat} from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';
import type {Readable} from 'node:stream';
import type {ManagedProcessOutputEvent, ManagedProcessOutputStream} from './types.js';

const MAX_READ_CHUNK_BYTES = 64 * 1024;
const MAX_PARTIAL_LINE_CHARS = 64 * 1024;

export class DurableOutputFollower {
  private active = false;
  private offset = 0;
  private buffer = '';
  private timer: NodeJS.Timeout | null = null;
  private decoder = new StringDecoder('utf8');

  constructor(
    private readonly processId: string,
    private readonly stream: ManagedProcessOutputStream,
    private readonly filePath: string,
    private readonly pollMs: number,
    private readonly emit: (event: ManagedProcessOutputEvent) => void,
  ) {}

  async start(atEnd: boolean): Promise<void> {
    if (this.active) return;
    this.active = true;
    if (atEnd) {
      try {
        this.offset = (await stat(this.filePath)).size;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    this.schedule(0);
  }

  close(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buffer = '';
    this.decoder.end();
    this.decoder = new StringDecoder('utf8');
  }

  private schedule(delayMs: number): void {
    if (!this.active) return;
    this.timer = setTimeout(() => void this.poll(), delayMs);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    if (!this.active) return;
    try {
      const file = await stat(this.filePath);
      if (file.size < this.offset) {
        this.offset = 0;
        this.buffer = '';
        this.decoder.end();
        this.decoder = new StringDecoder('utf8');
      }

      if (file.size > this.offset) {
        const handle = await open(this.filePath, 'r');
        try {
          let remaining = file.size - this.offset;
          while (this.active && remaining > 0) {
            const readLength = Math.min(remaining, MAX_READ_CHUNK_BYTES);
            const bytes = Buffer.allocUnsafe(readLength);
            const result = await handle.read(bytes, 0, readLength, this.offset);
            if (result.bytesRead === 0) break;
            this.offset += result.bytesRead;
            remaining -= result.bytesRead;
            this.consume(this.decoder.write(bytes.subarray(0, result.bytesRead)));
          }
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        // A transient log-read failure must not destabilize process ownership.
      }
    } finally {
      this.schedule(this.pollMs);
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      emitSafely(this.emit, {processId: this.processId, stream: this.stream, line});
    }

    if (this.buffer.length > MAX_PARTIAL_LINE_CHARS) {
      emitSafely(this.emit, {
        processId: this.processId,
        stream: this.stream,
        line: `${this.buffer.slice(0, MAX_PARTIAL_LINE_CHARS)}… [truncated]`,
      });
      this.buffer = '';
    }
  }
}

export function attachPipeOutput(
  processId: string,
  stream: Readable,
  name: ManagedProcessOutputStream,
  emit: (event: ManagedProcessOutputEvent) => void,
): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      emitSafely(emit, {processId, stream: name, line});
    }

    if (buffer.length > MAX_PARTIAL_LINE_CHARS) {
      emitSafely(emit, {
        processId,
        stream: name,
        line: `${buffer.slice(0, MAX_PARTIAL_LINE_CHARS)}… [truncated]`,
      });
      buffer = '';
    }
  });

  stream.once('end', () => {
    if (!buffer) return;
    emitSafely(emit, {processId, stream: name, line: buffer.replace(/\r$/, '')});
    buffer = '';
  });
}

export function emitSafely(
  emit: (event: ManagedProcessOutputEvent) => void,
  event: ManagedProcessOutputEvent,
): void {
  try {
    emit(event);
  } catch {
    // Observers must not destabilize process supervision.
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
