/** Typed consumer client for the `nimi.harness.session.v1` protocol (`ai.nimi.dsh.sessions`). */
import type { NimiAppRuntimeClient } from '@nimiplatform/sdk';

export const DSH_REMOTE_INTEGRATION_ID = 'ai.nimi.dsh.sessions';
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const CALL_POLL_INTERVAL_MS = 450;
const CALL_POLL_TIMEOUT_MS = 45_000;

export interface RemoteSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly status?: 'idle' | 'running' | 'waiting' | 'error';
  readonly hasPendingDecision?: boolean;
  readonly workspaceLabel?: string;
  readonly updatedAt?: number;
}

export interface RemoteHistoryEntry {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly toolName?: string;
  readonly toolFailure?: 'invalid-arguments' | 'blocked' | 'interrupted' | 'other' | boolean;
  readonly truncated?: boolean;
  readonly timestamp?: number;
}

export interface RemoteProgressSnapshot {
  readonly stage: 'idle' | 'queued' | 'placed' | 'generating' | 'waiting' | 'tools' | 'done' | 'unanswered';
  readonly turn: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly activeTool?: string;
  readonly hasPendingDecision?: boolean;
}

export interface RemoteDiffPreview {
  readonly kind: 'write' | 'edit' | 'command';
  readonly path?: string;
  readonly content?: string;
  readonly command?: string;
  readonly replacements?: readonly { readonly oldText: string; readonly newText: string }[];
}

export interface RemoteDecisionReview {
  readonly state: 'none' | 'open-on-pc' | 'review';
  readonly taskId?: string | number;
  readonly revision?: number | string;
  readonly tool?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly argumentsJson?: string;
  readonly diffPreview?: RemoteDiffPreview;
}

export interface RemoteWorkspaceFile {
  readonly name: string;
  readonly ref: string;
  readonly directory: boolean;
  readonly size?: number;
}

export interface RemoteTargetInfo {
  readonly targetRef: string;
  readonly integrationId: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly permittedOperations: readonly string[];
}

export function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export function sha256Text(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class RemoteHarnessClient {
  constructor(
    private readonly client: NimiAppRuntimeClient,
    private readonly targetRef: string,
    private readonly scopeSignal: AbortSignal,
  ) {}

  static async discover(client: NimiAppRuntimeClient): Promise<RemoteTargetInfo | null> {
    const catalog = await client.integration.listCatalog();
    const target = catalog.find(t => t.integrationId === DSH_REMOTE_INTEGRATION_ID);
    if (!target) return null;
    return {
      targetRef: target.targetRef,
      integrationId: target.integrationId,
      displayName: target.displayName || 'Nimi DSH',
      available: target.available,
      permittedOperations: target.permittedOperations,
    };
  }

  private async call<T>(
    operation: string,
    input: Record<string, unknown>,
    asset?: {
      readonly relativePath: string;
      readonly source?: { readonly sha256: string; readonly mediaType: string; readonly sizeBytes: number };
    },
  ): Promise<T> {
    if (this.scopeSignal.aborted) throw new Error('Runtime session is disconnected.');
    let call = await this.client.integration.invoke({
      targetRef: this.targetRef,
      operation,
      inputJson: JSON.stringify(input),
      ...(asset ? { asset } : {}),
    });

    const deadline = Date.now() + CALL_POLL_TIMEOUT_MS;
    while (call.status === 'accepted' && Date.now() < deadline) {
      await sleep(CALL_POLL_INTERVAL_MS, this.scopeSignal);
      if (this.scopeSignal.aborted) throw new Error('Runtime session is disconnected.');
      call = await this.client.integration.getCall({ callId: call.callId });
    }

    if (call.status === 'completed') {
      return (call.resultJson ? JSON.parse(call.resultJson) : {}) as T;
    }
    if (call.status === 'accepted' || call.status === 'unconfirmed') {
      throw new Error(`Operation "${operation}" is still pending (callId: ${call.callId}).`);
    }
    throw new Error(call.errorCode ? `${operation} failed: ${call.errorCode}` : `${operation} failed (${call.status})`);
  }

  listSessions(offset?: number): Promise<{ readonly sessions: readonly RemoteSessionSummary[]; readonly nextOffset: number | null }> {
    return this.call('session.list', offset === undefined ? {} : { offset });
  }

  getHistory(sessionId: string, cursor?: number, limit = 50): Promise<{
    readonly sessionId: string;
    readonly entries: readonly RemoteHistoryEntry[];
    readonly nextCursor: number | null;
  }> {
    return this.call('session.getHistory', {
      sessionId,
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    });
  }

  createSession(configRef?: string): Promise<{ readonly id: string; readonly title: string }> {
    return this.call('session.create', {
      requestId: randomUuid(),
      ...(configRef ? { configRef } : {}),
    });
  }

  submitPrompt(sessionId: string, text: string, requestId?: string): Promise<{ readonly requestId: string }> {
    return this.call('session.submit', {
      sessionId,
      requestId: requestId ?? randomUuid(),
      text,
    });
  }

  inputStatus(sessionId: string, requestId: string): Promise<{
    readonly requestId: string;
    readonly status: 'not-found' | 'queued' | 'placed' | 'done' | 'unanswered';
  }> {
    return this.call('session.inputStatus', { sessionId, requestId });
  }

  readAnswer(sessionId: string, requestId: string): Promise<{
    readonly requestId: string;
    readonly status: 'not-found' | 'queued' | 'placed' | 'done' | 'unanswered';
    readonly text?: string;
    readonly truncated?: boolean;
  }> {
    return this.call('session.readAnswer', { sessionId, requestId });
  }

  stopInput(sessionId: string, requestId: string): Promise<{
    readonly requestId: string;
    readonly outcome: 'not-found' | 'settled' | 'requested' | 'check-again';
  }> {
    return this.call('session.stopInput', { sessionId, requestId });
  }

  observeProgress(sessionId: string): Promise<RemoteProgressSnapshot> {
    return this.call('session.observeProgress', { sessionId });
  }

  subscribeProgress(
    sessionId: string,
    onSnapshot: (snapshot: RemoteProgressSnapshot) => void,
    signal: AbortSignal,
  ): () => void {
    const controller = new AbortController();
    const onAbort = () => { controller.abort(); };
    signal.addEventListener('abort', onAbort, { once: true });
    this.scopeSignal.addEventListener('abort', onAbort, { once: true });

    const run = async () => {
      if (typeof this.client.integration.subscribeSnapshots === 'function') {
        try {
          const stream = this.client.integration.subscribeSnapshots(
            {
              targetRef: this.targetRef,
              operation: 'session.observeProgress',
              inputJson: JSON.stringify({ sessionId }),
            },
            { signal: controller.signal },
          );
          for await (const frame of stream) {
            if (controller.signal.aborted) break;
            if (!frame.resultJson) continue;
            try {
              onSnapshot(JSON.parse(frame.resultJson) as RemoteProgressSnapshot);
            } catch {
              // Ignore malformed snapshot frames.
            }
          }
          return;
        } catch {
          if (controller.signal.aborted) return;
        }
      }

      // Clean polling fallback when snapshot subscription stream is unavailable.
      while (!controller.signal.aborted) {
        try {
          const snap = await this.observeProgress(sessionId);
          if (!controller.signal.aborted) onSnapshot(snap);
        } catch {
          // Ignore transient poll errors until next interval.
        }
        await sleep(1_500, controller.signal);
      }
    };

    void run();
    return () => {
      controller.abort();
      signal.removeEventListener('abort', onAbort);
      this.scopeSignal.removeEventListener('abort', onAbort);
    };
  }

  reviewDecision(sessionId: string): Promise<RemoteDecisionReview> {
    return this.call('session.reviewDecision', { sessionId });
  }

  resolveDecision(
    sessionId: string,
    taskId: string | number,
    revision: number | string,
    allow: boolean,
    feedback?: string,
  ): Promise<{ readonly outcome: 'recorded' | 'stale' }> {
    return this.call('session.resolveDecision', {
      sessionId,
      taskId,
      revision,
      allow,
      ...(feedback && feedback.trim() ? { feedback: feedback.trim() } : {}),
    });
  }

  listFiles(sessionId: string, folder?: string, offset?: number): Promise<{
    readonly items: readonly RemoteWorkspaceFile[];
    readonly nextOffset: number | null;
  }> {
    return this.call('session.listFiles', {
      sessionId,
      ...(folder ? { folder } : {}),
      ...(offset === undefined ? {} : { offset }),
    });
  }

  async uploadFile(sessionId: string, file: File): Promise<{ readonly fileId: string }> {
    if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) {
      throw new Error('Choose a nonempty file up to 32 MiB.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mediaType = file.type || 'application/octet-stream';
    const relativePath = `remote-upload/${randomUuid()}/${file.name.replace(/[^\w.-]/gu, '_') || 'upload.bin'}`;
    const asset = await this.client.storage.assets.write({
      relativePath,
      mediaType,
      body: bytes,
      overwrite: true,
    });
    try {
      return await this.call<{ readonly fileId: string }>('session.importAttachment', { sessionId }, {
        relativePath,
        source: { sha256: asset.sha256, mediaType: asset.mediaType ?? mediaType, sizeBytes: asset.sizeBytes },
      });
    } finally {
      void this.client.storage.assets.remove(relativePath).catch(() => undefined);
    }
  }

  async downloadFile(
    sessionId: string,
    target: { readonly ref?: string; readonly fileId?: string; readonly name?: string },
  ): Promise<{ readonly name: string; readonly blob: Blob }> {
    const relativePath = `remote-download/${randomUuid()}`;
    const result = await this.call<{ readonly fileId: string; readonly name?: string }>(
      'session.downloadResult',
      {
        sessionId,
        ...(target.ref ? { ref: target.ref } : {}),
        ...(target.fileId ? { fileId: target.fileId } : {}),
      },
      { relativePath },
    );
    try {
      const read = await this.client.storage.assets.read({ relativePath });
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of read.body) {
        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        chunks.push(copy);
        total += copy.byteLength;
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const blob = new Blob([merged.buffer], { type: read.asset?.mediaType || 'application/octet-stream' });
      return { name: result.name || target.name || 'download.bin', blob };
    } finally {
      void this.client.storage.assets.remove(relativePath).catch(() => undefined);
    }
  }
}
