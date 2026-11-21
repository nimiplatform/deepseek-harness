import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NimiAppScope } from '@nimiplatform/kit/core/app-session';
import { extractNimiErrorFields, isJsonObject } from '@nimiplatform/sdk/types';
import {
  randomUuid,
  RemoteHarnessClient,
  sha256Text,
  type RemoteDecisionReview,
  type RemoteHistoryEntry,
  type RemoteProgressSnapshot,
  type RemoteSessionSummary,
  type RemoteTargetInfo,
  type RemoteWorkspaceFile,
} from './remote-client.js';

type SavedInputReceipt = {
  readonly requestId: string;
  readonly digest: string;
  readonly settled?: boolean;
};

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

export type RemoteLocale = 'en' | 'zh';

const COPY: Record<RemoteLocale, Record<string, string>> = {
  en: {
    sessions: 'Sessions',
    newSession: 'New session',
    refresh: 'Refresh',
    files: 'Workspace files',
    upload: 'Upload file',
    download: 'Download',
    upFolder: 'Up one level',
    send: 'Send',
    stop: 'Stop',
    approve: 'Approve',
    deny: 'Deny',
    feedbackPlaceholder: 'Optional reviewer guidance for the agent…',
    promptPlaceholder: 'Send an instruction to your desktop Nimi DSH session… (Ctrl/Cmd+Enter to send)',
    noTargetTitle: 'Nimi DSH desktop provider not found',
    noTargetBody: 'Keep Nimi DSH open on your desktop and grant integration access to "Nimi DSH" (ai.nimi.dsh.sessions) in Nimi Home, then refresh.',
    noSessionSelected: 'Select a session or create a new one to start working remotely.',
    emptyHistory: 'No messages yet. Send a prompt below to wake your desktop session.',
    emptyFiles: 'No files in this folder.',
    approvalRequired: 'Approval required',
    openOnPc: 'This pending action requires confirmation on your desktop.',
    streaming: 'Live response',
    runningTool: 'Running tool',
    uploading: 'Uploading…',
    downloading: 'Downloading…',
    uploadedOk: 'Transferred to the desktop.',
    backToSessions: 'Sessions',
    retrySend: 'Retry last message',
  },
  zh: {
    sessions: '会话列表',
    newSession: '新建会话',
    refresh: '刷新',
    files: '工作区文件',
    upload: '上传文件',
    download: '下载',
    upFolder: '返回上级目录',
    send: '发送',
    stop: '停止',
    approve: '允许执行',
    deny: '拒绝',
    feedbackPlaceholder: '可选：补充给 Agent 的审批说明…',
    promptPlaceholder: '向桌面端 Nimi DSH 发送指令…（Ctrl/Cmd+Enter 发送）',
    noTargetTitle: '未发现桌面端 Nimi DSH 服务',
    noTargetBody: '请保持桌面端 Nimi DSH 运行，并在 Nimi Home 中为本应用授权「Nimi DSH」(ai.nimi.dsh.sessions) 集成访问权限后点击刷新。',
    noSessionSelected: '请选择左侧会话或新建一个会话以开始远程协作。',
    emptyHistory: '暂无消息记录。在下方输入指令即可驱动桌面端会话。',
    emptyFiles: '该目录下暂无文件。',
    approvalRequired: '需要您的审批确认',
    openOnPc: '当前待审批操作需要在桌面端确认。',
    streaming: '实时输出中',
    runningTool: '正在运行工具',
    uploading: '上传中…',
    downloading: '下载中…',
    uploadedOk: '已传输到桌面端。',
    backToSessions: '会话列表',
    retrySend: '重试上一条消息',
  },
};

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function RemoteCompanionApp({
  scope,
  language,
}: {
  readonly scope: NimiAppScope;
  readonly language: RemoteLocale;
}) {
  const t = useCallback((key: string) => COPY[language][key] ?? key, [language]);
  const [target, setTarget] = useState<RemoteTargetInfo | null>(null);
  const [discovering, setDiscovering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const [sessions, setSessions] = useState<readonly RemoteSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<readonly RemoteHistoryEntry[]>([]);
  const [progress, setProgress] = useState<RemoteProgressSnapshot | null>(null);
  const [decision, setDecision] = useState<RemoteDecisionReview>({ state: 'none' });
  const [decisionFeedback, setDecisionFeedback] = useState('');
  const [resolvingDecision, setResolvingDecision] = useState(false);

  const [promptText, setPromptText] = useState('');
  const [sending, setSending] = useState(false);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [savedReceipt, setSavedReceipt] = useState<SavedInputReceipt | null>(null);
  const [failedText, setFailedText] = useState<string | null>(null);
  const savedReceiptRef = useRef<SavedInputReceipt | null>(null);
  const receiptPathRef = useRef<string | null>(null);
  savedReceiptRef.current = savedReceipt;
  receiptPathRef.current = receiptPath;

  const [filesOpen, setFilesOpen] = useState(false);
  const [folder, setFolder] = useState('');
  const [files, setFiles] = useState<readonly RemoteWorkspaceFile[]>([]);
  const [transferBusy, setTransferBusy] = useState(false);
  const [mobileShowSidebar, setMobileShowSidebar] = useState(true);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const harness = useMemo(
    () => (target ? new RemoteHarnessClient(scope.client, target.targetRef, scope.signal) : null),
    [scope.client, scope.signal, target],
  );

  const discover = useCallback(async () => {
    setDiscovering(true);
    setError(null);
    try {
      const found = await RemoteHarnessClient.discover(scope.client);
      setTarget(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  }, [scope.client]);

  useEffect(() => {
    void discover();
  }, [discover]);

  const refreshSessions = useCallback(async () => {
    if (!harness) return;
    try {
      const res = await harness.listSessions();
      setSessions(res.sessions);
      setSelectedId(prev => prev ?? res.sessions[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [harness]);

  const refreshHistory = useCallback(async (sessionId: string) => {
    if (!harness) return;
    try {
      const res = await harness.getHistory(sessionId);
      setEntries(res.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [harness]);

  const refreshDecision = useCallback(async (sessionId: string) => {
    if (!harness) return;
    try {
      const review = await harness.reviewDecision(sessionId);
      setDecision(review);
    } catch {
      // Non-fatal while polling.
    }
  }, [harness]);

  const refreshFiles = useCallback(async (sessionId: string, nextFolder: string) => {
    if (!harness) return;
    try {
      const res = await harness.listFiles(sessionId, nextFolder || undefined);
      setFiles(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [harness]);

  useEffect(() => {
    if (harness) void refreshSessions();
  }, [harness, refreshSessions]);

  useEffect(() => {
    if (!harness || !selectedId || !target) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, scope.signal]);
    setProgress(null);
    setDecision({ state: 'none' });
    setFolder('');
    setActiveRequestId(null);
    setSavedReceipt(null);
    setReceiptPath(null);
    setFailedText(null);
    void refreshHistory(selectedId);
    void refreshDecision(selectedId);
    if (filesOpen) void refreshFiles(selectedId, '');

    void (async () => {
      try {
        const key = `remote-input-${await sha256Text(JSON.stringify([target.targetRef, selectedId]))}.json`;
        if (signal.aborted) return;
        setReceiptPath(key);
        let stored: SavedInputReceipt | null = null;
        try {
          const { value } = await scope.client.storage.readJson(key);
          if (!signal.aborted && isJsonObject(value)
            && typeof value.requestId === 'string' && UUID_RE.test(value.requestId)
            && typeof value.digest === 'string' && SHA256_RE.test(value.digest)) {
            stored = {
              requestId: value.requestId,
              digest: value.digest,
              settled: value.settled === true,
            };
            setSavedReceipt(stored);
          }
        } catch (err) {
          if (extractNimiErrorFields(err).reasonCode !== 'APP_STORAGE_ENTRY_NOT_FOUND') throw err;
        }
        if (!signal.aborted && stored && !stored.settled) {
          try {
            const status = await harness.inputStatus(selectedId, stored.requestId);
            if (signal.aborted) return;
            if (status.status === 'queued' || status.status === 'placed') {
              setActiveRequestId(stored.requestId);
            } else if (status.status === 'done' || status.status === 'unanswered') {
              await harness.readAnswer(selectedId, stored.requestId).catch(() => undefined);
              const settledReceipt: SavedInputReceipt = { ...stored, settled: true };
              setSavedReceipt(settledReceipt);
              void scope.client.storage.writeJson(key, settledReceipt).catch(() => undefined);
              void refreshHistory(selectedId);
            }
          } catch {
            // Non-fatal: server may not grant inputStatus or may be reconnecting.
          }
        }
      } catch (err) {
        if (!signal.aborted) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    let lastStage: RemoteProgressSnapshot['stage'] | null = null;
    const off = harness.subscribeProgress(selectedId, (snap) => {
      setProgress(snap);
      if (snap.hasPendingDecision || snap.stage === 'waiting') {
        void refreshDecision(selectedId);
      } else if (lastStage === 'waiting') {
        setDecision({ state: 'none' });
      }
      if ((snap.stage === 'done' || snap.stage === 'unanswered' || snap.stage === 'idle')
        && lastStage !== null && lastStage !== snap.stage) {
        setActiveRequestId(null);
        const currentReceipt = savedReceiptRef.current;
        const currentPath = receiptPathRef.current;
        if (currentReceipt && !currentReceipt.settled && currentPath) {
          const settledReceipt: SavedInputReceipt = { ...currentReceipt, settled: true };
          setSavedReceipt(settledReceipt);
          void scope.client.storage.writeJson(currentPath, settledReceipt).catch(() => undefined);
        }
        void refreshHistory(selectedId);
        void refreshSessions();
      }
      lastStage = snap.stage;
    }, abort.signal);

    return () => {
      abort.abort();
      off();
    };
  }, [harness, scope.client.storage, scope.signal, selectedId, target, filesOpen, refreshHistory, refreshDecision, refreshFiles, refreshSessions]);

  const handleCreateSession = async () => {
    if (!harness) return;
    setError(null);
    try {
      const created = await harness.createSession();
      await refreshSessions();
      setSelectedId(created.id);
      setEntries([]);
      setMobileShowSidebar(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSubmit = async (isRetry = false) => {
    if (!harness || !selectedId || !target) return;
    const text = isRetry && failedText ? failedText : promptText.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    try {
      const key = receiptPath ?? `remote-input-${await sha256Text(JSON.stringify([target.targetRef, selectedId]))}.json`;
      if (!receiptPath) setReceiptPath(key);
      const digest = await sha256Text(text);
      let receipt = savedReceipt;
      if (!receipt || receipt.settled || receipt.digest !== digest) {
        receipt = { requestId: randomUuid(), digest, settled: false };
        await scope.client.storage.writeJson(key, receipt);
        setSavedReceipt(receipt);
      }
      const res = await harness.submitPrompt(selectedId, text, receipt.requestId);
      if (res.requestId !== receipt.requestId) {
        throw new Error('Desktop returned a different input receipt.');
      }
      setActiveRequestId(res.requestId);
      setPromptText('');
      setFailedText(null);
      await refreshHistory(selectedId);
    } catch (err) {
      setFailedText(text);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    if (!harness || !selectedId || !activeRequestId) return;
    try {
      await harness.stopInput(selectedId, activeRequestId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResolveDecision = async (allow: boolean) => {
    if (!harness || !selectedId || decision.state !== 'review' || !decision.taskId || decision.revision === undefined) return;
    setResolvingDecision(true);
    setError(null);
    try {
      await harness.resolveDecision(selectedId, decision.taskId, decision.revision, allow, decisionFeedback);
      setDecision({ state: 'none' });
      setDecisionFeedback('');
      await refreshHistory(selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingDecision(false);
    }
  };

  const handleUpload = async (file: File) => {
    if (!harness || !selectedId) return;
    setTransferBusy(true);
    setError(null);
    setStatusNotice(null);
    try {
      await harness.uploadFile(selectedId, file);
      setStatusNotice(`${file.name} — ${t('uploadedOk')}`);
      if (filesOpen) await refreshFiles(selectedId, folder);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusy(false);
    }
  };

  const handleDownload = async (item: RemoteWorkspaceFile) => {
    if (!harness || !selectedId) return;
    setTransferBusy(true);
    setError(null);
    try {
      const { name, blob } = await harness.downloadFile(selectedId, { ref: item.ref, name: item.name });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusy(false);
    }
  };

  if (discovering) {
    return <div className="rc-empty">Connecting to Nimi DSH…</div>;
  }

  if (!target) {
    return (
      <div className="rc-empty">
        <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>{t('noTargetTitle')}</h2>
        <p style={{ maxWidth: 460, margin: '0 auto 16px' }}>{t('noTargetBody')}</p>
        {error && <p style={{ color: 'var(--rc-danger)', marginBottom: 12 }}>{error}</p>}
        <button type="button" className="rc-btn rc-btn-primary" onClick={() => { void discover(); }}>
          {t('refresh')}
        </button>
      </div>
    );
  }

  const activeSession = sessions.find(s => s.id === selectedId) ?? null;
  const isRunning = progress !== null && ['queued', 'placed', 'generating', 'tools', 'waiting'].includes(progress.stage);

  return (
    <div className="rc-workspace" data-files-open={filesOpen ? 'true' : 'false'}>
      <aside className="rc-sidebar" data-hidden-mobile={!mobileShowSidebar && selectedId ? 'true' : 'false'}>
        <div className="rc-sidebar-top">
          <strong style={{ fontSize: 14 }}>{t('sessions')}</strong>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="rc-btn" onClick={() => { void refreshSessions(); }}>{t('refresh')}</button>
            <button type="button" className="rc-btn rc-btn-primary" onClick={() => { void handleCreateSession(); }}>
              + {t('newSession')}
            </button>
          </div>
        </div>
        <div className="rc-session-list">
          {sessions.map(session => (
            <button
              key={session.id}
              type="button"
              className="rc-session-item"
              data-active={session.id === selectedId ? 'true' : 'false'}
              onClick={() => {
                setSelectedId(session.id);
                setMobileShowSidebar(false);
              }}
            >
              <div className="rc-session-title">{session.title}</div>
              <div className="rc-session-meta">
                {session.workspaceLabel && <span>{session.workspaceLabel}</span>}
                {session.hasPendingDecision && (
                  <span className="rc-badge" data-tone="waiting">{t('approvalRequired')}</span>
                )}
                {!session.hasPendingDecision && session.status && session.status !== 'idle' && (
                  <span className="rc-badge" data-tone={session.status}>{session.status}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="rc-main">
        {!selectedId ? (
          <div className="rc-empty">{t('noSessionSelected')}</div>
        ) : (
          <>
            <div className="rc-main-bar">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <button
                  type="button"
                  className="rc-btn"
                  onClick={() => { setMobileShowSidebar(v => !v); }}
                >
                  {t('backToSessions')}
                </button>
                <strong style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeSession?.title ?? selectedId}
                </strong>
                {progress && (
                  <span className="rc-badge" data-tone={progress.stage === 'waiting' ? 'waiting' : isRunning ? 'running' : 'ready'}>
                    {progress.activeTool ? `${t('runningTool')}: ${progress.activeTool}` : progress.stage}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="rc-btn"
                  onClick={() => {
                    const next = !filesOpen;
                    setFilesOpen(next);
                    if (next) void refreshFiles(selectedId, folder);
                  }}
                >
                  {t('files')}
                </button>
              </div>
            </div>

            {error && (
              <div role="alert" style={{ padding: '8px 16px', color: 'var(--rc-danger)', fontSize: 13 }}>
                {error}
              </div>
            )}
            {statusNotice && (
              <div role="status" style={{ padding: '8px 16px', color: 'var(--rc-success)', fontSize: 13 }}>
                {statusNotice}
              </div>
            )}

            <div className="rc-thread">
              {entries.length === 0 && !progress?.text && (
                <div className="rc-empty">{t('emptyHistory')}</div>
              )}

              {entries.map(entry => (
                <div
                  key={entry.id}
                  className={`rc-msg ${
                    entry.role === 'user'
                      ? 'rc-msg-user'
                      : entry.role === 'tool'
                        ? 'rc-msg-tool'
                        : 'rc-msg-assistant'
                  }`}
                >
                  {entry.role === 'tool' && (
                    <div style={{ fontWeight: 600, marginBottom: 4, color: entry.toolFailure ? 'var(--rc-danger)' : 'var(--rc-text-muted)' }}>
                      {entry.toolName ?? 'tool'}{entry.toolFailure ? ' (failed)' : ''}
                    </div>
                  )}
                  {entry.text}
                </div>
              ))}

              {progress && isRunning && progress.text && (
                <div className="rc-msg rc-msg-assistant">
                  <div style={{ fontSize: 11, color: 'var(--rc-accent)', marginBottom: 4, fontWeight: 600 }}>
                    {t('streaming')}
                  </div>
                  {progress.text}
                </div>
              )}

              {decision.state === 'open-on-pc' && (
                <div className="rc-approval-card">
                  <strong>{t('approvalRequired')}</strong>
                  <div style={{ fontSize: 13 }}>{t('openOnPc')}</div>
                </div>
              )}

              {decision.state === 'review' && (
                <div className="rc-approval-card" role="region" aria-label={t('approvalRequired')}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <strong>{decision.title || `${t('approvalRequired')}: ${decision.tool}`}</strong>
                    <span className="rc-badge" data-tone="waiting">{decision.tool}</span>
                  </div>
                  {decision.summary && <div style={{ fontSize: 13, color: 'var(--rc-text-muted)' }}>{decision.summary}</div>}

                  {decision.diffPreview?.kind === 'command' && decision.diffPreview.command && (
                    <pre className="rc-code-block">$ {decision.diffPreview.command}</pre>
                  )}
                  {decision.diffPreview?.kind === 'write' && (
                    <div>
                      {decision.diffPreview.path && <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{decision.diffPreview.path}</div>}
                      <pre className="rc-code-block">{decision.diffPreview.content}</pre>
                    </div>
                  )}
                  {decision.diffPreview?.kind === 'edit' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {decision.diffPreview.path && <div style={{ fontSize: 12, fontWeight: 600 }}>{decision.diffPreview.path}</div>}
                      {(decision.diffPreview.replacements ?? []).map((rep, idx) => (
                        <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <pre className="rc-code-block rc-diff-del">- {rep.oldText}</pre>
                          <pre className="rc-code-block rc-diff-add">+ {rep.newText}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                  {!decision.diffPreview && decision.argumentsJson && (
                    <pre className="rc-code-block">{decision.argumentsJson}</pre>
                  )}

                  <input
                    type="text"
                    className="rc-textarea"
                    style={{ minHeight: 36 }}
                    value={decisionFeedback}
                    placeholder={t('feedbackPlaceholder')}
                    onChange={(event) => { setDecisionFeedback(event.target.value); }}
                  />
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="rc-btn rc-btn-danger"
                      disabled={resolvingDecision}
                      onClick={() => { void handleResolveDecision(false); }}
                    >
                      {t('deny')}
                    </button>
                    <button
                      type="button"
                      className="rc-btn rc-btn-primary"
                      disabled={resolvingDecision}
                      onClick={() => { void handleResolveDecision(true); }}
                    >
                      {t('approve')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="rc-composer">
              <textarea
                className="rc-textarea"
                value={promptText}
                placeholder={t('promptPlaceholder')}
                onChange={(event) => { setPromptText(event.target.value); }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    void handleSubmit();
                  }
                }}
              />
              <input
                ref={uploadInputRef}
                type="file"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void handleUpload(file);
                }}
              />
              <div className="rc-composer-bar">
                <button
                  type="button"
                  className="rc-btn"
                  disabled={transferBusy}
                  onClick={() => { uploadInputRef.current?.click(); }}
                >
                  {transferBusy ? t('uploading') : t('upload')}
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                  {failedText && !sending && (
                    <button type="button" className="rc-btn" onClick={() => { void handleSubmit(true); }}>
                      {t('retrySend')}
                    </button>
                  )}
                  {isRunning && activeRequestId && (
                    <button type="button" className="rc-btn rc-btn-danger" onClick={() => { void handleStop(); }}>
                      {t('stop')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rc-btn rc-btn-primary"
                    disabled={sending || !promptText.trim()}
                    onClick={() => { void handleSubmit(false); }}
                  >
                    {t('send')}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {filesOpen && selectedId && (
        <aside className="rc-files">
          <div className="rc-sidebar-top">
            <strong style={{ fontSize: 13 }}>{t('files')}{folder ? `: /${folder}` : ''}</strong>
            <div style={{ display: 'flex', gap: 6 }}>
              {folder && (
                <button
                  type="button"
                  className="rc-btn"
                  onClick={() => {
                    const parent = folder.split('/').slice(0, -1).join('/');
                    setFolder(parent);
                    void refreshFiles(selectedId, parent);
                  }}
                >
                  ..
                </button>
              )}
              <button
                type="button"
                className="rc-btn"
                disabled={transferBusy}
                onClick={() => { uploadInputRef.current?.click(); }}
              >
                {t('upload')}
              </button>
            </div>
          </div>
          <div className="rc-file-list">
            {files.length === 0 && <div className="rc-empty">{t('emptyFiles')}</div>}
            {files.map(item => (
              <div key={item.ref} className="rc-file-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  {item.directory ? (
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: 'var(--rc-accent)', cursor: 'pointer', padding: 0, fontWeight: 500 }}
                      onClick={() => {
                        setFolder(item.ref);
                        void refreshFiles(selectedId, item.ref);
                      }}
                    >
                      📁 {item.name}
                    </button>
                  ) : (
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name}
                      {item.size !== undefined && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--rc-text-muted)' }}>
                          {formatBytes(item.size)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {!item.directory && (
                  <button
                    type="button"
                    className="rc-btn"
                    disabled={transferBusy}
                    onClick={() => { void handleDownload(item); }}
                  >
                    {t('download')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
