import {constants as fsConstants} from 'node:fs';
import {open} from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';
import type {Readable} from 'node:stream';
import type {ManagedProcessOutputEvent, ManagedProcessOutputStream} from './types.js';

const MAX_READ_CHUNK_BYTES = 64 * 1024;
const MAX_PARTIAL_LINE_CHARS = 64 * 1024;
const MAX_IDLE_POLL_MS = 2_000;

export class DurableOutputFollower {
  private active = false;
  private offset = 0;
  private buffer = '';
  private timer: NodeJS.Timeout | null = null;
  private decoder = new StringDecoder('utf8');
  private currentPollMs: number;

  constructor(
    private readonly processId: string,
    private readonly stream: ManagedProcessOutputStream,
    private readonly filePath: string,
    private readonly pollMs: number,
    private readonly maxFileBytes: number,
    private readonly emit: (event: ManagedProcessOutputEvent) => void,
  ) {
    this.currentPollMs = pollMs;
  }

  async start(atEnd: boolean): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.currentPollMs = this.pollMs;
    if (atEnd) {
      try {
        const handle = await openRegularFile(this.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          this.offset = (await handle.stat()).size;
        } finally {
          await handle.close();
        }
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
    this.resetReadState();
    this.currentPollMs = this.pollMs;
  }

  private schedule(delayMs: number): void {
    if (!this.active) return;
    this.timer = setTimeout(() => void this.poll(), delayMs);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    if (!this.active) return;
    let consumedBytes = false;
    try {
      const handle = await openRegularFile(this.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const file = await handle.stat();
        if (file.size > this.maxFileBytes) {
          await handle.close();
          await this.truncateOversizedFile();
          consumedBytes = true;
          return;
        }

        if (file.size < this.offset) this.resetReadState();

        if (file.size > this.offset) {
          let remaining = file.size - this.offset;
          while (this.active && remaining > 0) {
            const readLength = Math.min(remaining, MAX_READ_CHUNK_BYTES);
            const bytes = Buffer.allocUnsafe(readLength);
            const result = await handle.read(bytes, 0, readLength, this.offset);
            if (result.bytesRead === 0) break;
            consumedBytes = true;
            this.offset += result.bytesRead;
            remaining -= result.bytesRead;
            this.consume(this.decoder.write(bytes.subarray(0, result.bytesRead)));
          }
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        // A transient log-read failure must not destabilize process ownership.
      }
    } finally {
      this.currentPollMs = consumedBytes
        ? this.pollMs
        : Math.min(Math.max(this.pollMs, this.currentPollMs * 2), MAX_IDLE_POLL_MS);
      this.schedule(this.currentPollMs);
    }
  }

  private async truncateOversizedFile(): Promise<void> {
    const handle = await openRegularFile(
      this.filePath,
      fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const current = await handle.stat();
      if (current.size > this.maxFileBytes) await handle.truncate(0);
    } finally {
      await handle.close();
    }
    this.resetReadState();
  }

  private resetReadState(): void {
    this.offset = 0;
    this.buffer = '';
    this.decoder.end();
    this.decoder = new StringDecoder('utf8');
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

async function openRegularFile(path: string, flags: number): Promise<Awaited<ReturnType<typeof open>>> {
  const handle = await open(path, flags);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Durable log path is not a regular file: ${path}`);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
