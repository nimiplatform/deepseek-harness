import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  NimiDesktopAiConfigCloudConnectorOption,
  NimiDesktopAiConfigCloudTargetOption,
  NimiDesktopAiConfigIntent,
  NimiDesktopAiConfigLocalLoadoutOption,
  NimiDesktopAiConfigOverwriteInput,
  NimiDesktopAiConfigOverwriteResult,
  NimiDesktopAiConfigQuery,
  NimiDesktopAiConfigOptionsQuery,
  NimiDesktopAiConfigOptionsResult,
  NimiDesktopAiConfigRecord,
  NimiDesktopAiConfigSnapshot,
  NimiDesktopHomeSection,
} from '../types.ts'
import css from './NimiSection.module.css'

const MANAGED_CAPABILITIES = ['text.generate', 'audio.transcribe'] as const
type ManagedCapability = (typeof MANAGED_CAPABILITIES)[number]

interface CapabilityDraft {
  routeKind: 'none' | 'local' | 'cloud'
  loadoutRef: string
  connectorRef: string
  targetKey: string
  targetObj?: Record<string, unknown> | undefined
  implementation?: Record<string, unknown> | undefined
}

interface CapabilityOptions {
  localLoadouts: readonly NimiDesktopAiConfigLocalLoadoutOption[]
  cloudConnectors: readonly NimiDesktopAiConfigCloudConnectorOption[]
  cloudTargets: readonly NimiDesktopAiConfigCloudTargetOption[]
}

export interface NimiModelsSectionInjected {
  openNimiSettings(): Promise<void>
  openHome?(section?: NimiDesktopHomeSection): Promise<void>
  adoptLatestRevision?(configRef?: string): Promise<void>
  readonly aiConfig?: {
    get(query?: NimiDesktopAiConfigQuery): Promise<NimiDesktopAiConfigSnapshot>
    listOptions(query: NimiDesktopAiConfigOptionsQuery): Promise<NimiDesktopAiConfigOptionsResult>
    overwrite(input: NimiDesktopAiConfigOverwriteInput): Promise<NimiDesktopAiConfigOverwriteResult>
  }
}

export type NimiModelsSectionProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'settings'>
  & InjectFace<NimiModelsSectionInjected>

function emptyDraft(): CapabilityDraft {
  return { routeKind: 'none', loadoutRef: '', connectorRef: '', targetKey: '' }
}

function emptyOptions(): CapabilityOptions {
  return { localLoadouts: [], cloudConnectors: [], cloudTargets: [] }
}

function unwrapProtobufValue(val: unknown): unknown {
  if (typeof val !== 'object' || val === null) return val
  const obj = val as Record<string, unknown>
  if ('kind' in obj && typeof obj.kind === 'object' && obj.kind !== null) {
    const kind = obj.kind as Record<string, unknown>
    if (kind.oneofKind === 'stringValue') return kind.stringValue
    if (kind.oneofKind === 'numberValue') return kind.numberValue
    if (kind.oneofKind === 'boolValue') return kind.boolValue
    if (kind.oneofKind === 'nullValue') return null
    if (kind.oneofKind === 'structValue') return normalizeTargetObject(kind.structValue as Record<string, unknown>)
    if (kind.oneofKind === 'listValue' && typeof kind.listValue === 'object' && kind.listValue !== null) {
      const values = (kind.listValue as { values?: unknown[] }).values
      return Array.isArray(values) ? values.map(unwrapProtobufValue) : []
    }
  }
  return val
}

function normalizeTargetObject(target: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!target) return undefined
  if ('fields' in target && typeof target.fields === 'object' && target.fields !== null && !Array.isArray(target.fields)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(target.fields as Record<string, unknown>)) {
      out[k] = unwrapProtobufValue(v)
    }
    return out
  }
  return target
}

function targetKeyOf(raw: Record<string, unknown> | undefined): string {
  const target = normalizeTargetObject(raw)
  if (!target) return ''
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(target).sort()) {
    sorted[key] = target[key]
  }
  try { return JSON.stringify(sorted) } catch { return '' }
}

function findMatchingCloudTarget(
  targets: readonly NimiDesktopAiConfigCloudTargetOption[],
  draftKey: string,
  draftObj: Record<string, unknown> | undefined,
): NimiDesktopAiConfigCloudTargetOption | undefined {
  if (draftKey) {
    const exact = targets.find(t => targetKeyOf(t.providerModelTarget) === draftKey)
    if (exact) return exact
  }
  const normalized = normalizeTargetObject(draftObj)
  if (!normalized) return undefined
  const catalogId = typeof normalized.remoteModelCatalogId === 'string' ? normalized.remoteModelCatalogId : ''
  if (catalogId) {
    const byCatalog = targets.find(t => normalizeTargetObject(t.providerModelTarget)?.remoteModelCatalogId === catalogId)
    if (byCatalog) return byCatalog
  }
  const modelId = typeof normalized.providerModelId === 'string' ? normalized.providerModelId : ''
  if (modelId) {
    const byModel = targets.find(t => normalizeTargetObject(t.providerModelTarget)?.providerModelId === modelId)
    if (byModel) return byModel
  }
  return undefined
}

function draftFromSnapshot(snapshot: NimiDesktopAiConfigSnapshot, capability: ManagedCapability): CapabilityDraft {
  const intent = snapshot.config?.capabilities?.find(c => c.capabilityContract === capability)
  const effective = snapshot.effectiveSelections.find(s => s.capabilityContract === capability)
  if (!intent || intent.route.oneofKind === undefined) return emptyDraft()
  if (intent.route.oneofKind === 'local') {
    const effectiveLoadout = effective?.resource?.oneofKind === 'local' ? effective.resource.local.loadoutRef : ''
    return {
      routeKind: 'local',
      loadoutRef: intent.route.local.loadoutRef ?? effectiveLoadout ?? '',
      connectorRef: '',
      targetKey: '',
    }
  }
  const effectiveTarget = effective?.resource?.oneofKind === 'cloud'
    ? effective.resource.cloud.target.providerModelTarget
    : undefined
  const normalizedTarget = normalizeTargetObject(intent.route.cloud.providerModelTarget)
    ?? normalizeTargetObject(effectiveTarget)
  return {
    routeKind: 'cloud',
    loadoutRef: '',
    connectorRef: intent.route.cloud.connectorRef,
    targetKey: targetKeyOf(normalizedTarget),
    targetObj: normalizedTarget,
    implementation: intent.route.cloud.implementation,
  }
}

function buildIntents(
  snapshot: NimiDesktopAiConfigSnapshot | null,
  drafts: Record<ManagedCapability, CapabilityDraft>,
  options: Record<ManagedCapability, CapabilityOptions>,
): NimiDesktopAiConfigIntent[] {
  const preserved = (snapshot?.config?.capabilities ?? [])
    .filter(c => !MANAGED_CAPABILITIES.includes(c.capabilityContract as ManagedCapability))
  const updated: NimiDesktopAiConfigIntent[] = [...preserved]

  for (const capability of MANAGED_CAPABILITIES) {
    const draft = drafts[capability]
    const existing = snapshot?.config?.capabilities?.find(c => c.capabilityContract === capability)
    const requiredFeatures = existing?.requiredFeatures ?? []
    const defaults = existing?.defaults
    if (draft.routeKind === 'local') {
      updated.push({
        capabilityContract: capability,
        requiredFeatures,
        ...(defaults ? { defaults } : {}),
        route: {
          oneofKind: 'local',
          local: draft.loadoutRef ? { loadoutRef: draft.loadoutRef } : {},
        },
      })
    } else if (draft.routeKind === 'cloud' && draft.connectorRef) {
      const matchedTarget = findMatchingCloudTarget(options[capability].cloudTargets, draft.targetKey, draft.targetObj)
      const providerModelTarget = matchedTarget?.providerModelTarget ?? draft.targetObj ?? {}
      const implementation = matchedTarget?.implementation ?? draft.implementation
      updated.push({
        capabilityContract: capability,
        requiredFeatures,
        ...(defaults ? { defaults } : {}),
        route: {
          oneofKind: 'cloud',
          cloud: {
            connectorRef: draft.connectorRef,
            ...(implementation ? { implementation } : {}),
            providerModelTarget,
          },
        },
      })
    }
  }
  return updated
}

/** Native Option A Headless AIConfig manager inside DSH Settings. */
export function NimiModelsSection({
  openNimiSettings,
  openHome,
  adoptLatestRevision,
  aiConfig,
  t,
}: NimiModelsSectionProps) {
  const [snapshot, setSnapshot] = useState<NimiDesktopAiConfigSnapshot | null>(null)
  const [selectedRef, setSelectedRef] = useState<string | undefined>(undefined)
  const [drafts, setDrafts] = useState<Record<ManagedCapability, CapabilityDraft>>({
    'text.generate': emptyDraft(),
    'audio.transcribe': emptyDraft(),
  })
  const [options, setOptions] = useState<Record<ManagedCapability, CapabilityOptions>>({
    'text.generate': emptyOptions(),
    'audio.transcribe': emptyOptions(),
  })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [newName, setNewName] = useState('')
  const [renameValue, setRenameValue] = useState('')
  const [targetFilter, setTargetFilter] = useState<Record<ManagedCapability, string>>({
    'text.generate': '',
    'audio.transcribe': '',
  })

  const loadCloudTargets = useCallback(async (capability: ManagedCapability, connectorRef: string) => {
    if (!aiConfig || !connectorRef) {
      setOptions(prev => ({ ...prev, [capability]: { ...prev[capability], cloudTargets: [] } }))
      return
    }
    const res = await aiConfig.listOptions({ kind: 'cloud-targets', capabilityContract: capability, connectorRef })
    if (res.kind === 'cloud-targets') {
      setOptions(prev => ({ ...prev, [capability]: { ...prev[capability], cloudTargets: res.options } }))
    }
  }, [aiConfig])

  const loadConfig = useCallback(async (configRef?: string) => {
    if (!aiConfig) return
    setLoading(true)
    setError(null)
    setConflict(false)
    try {
      const snap = await aiConfig.get({ ...(configRef ? { configRef } : {}), includeRecords: true })
      setSnapshot(snap)
      const activeRef = snap.record?.configRef
      setSelectedRef(activeRef)
      setRenameValue(snap.record?.name ?? '')

      const nextDrafts: Record<ManagedCapability, CapabilityDraft> = {
        'text.generate': draftFromSnapshot(snap, 'text.generate'),
        'audio.transcribe': draftFromSnapshot(snap, 'audio.transcribe'),
      }

      const nextOptions: Record<ManagedCapability, CapabilityOptions> = {
        'text.generate': emptyOptions(),
        'audio.transcribe': emptyOptions(),
      }
      await Promise.all(MANAGED_CAPABILITIES.map(async (capability) => {
        const [locals, connectors] = await Promise.all([
          aiConfig.listOptions({ kind: 'local-loadouts', capabilityContract: capability }),
          aiConfig.listOptions({ kind: 'cloud-connectors', capabilityContract: capability }),
        ])
        const localLoadouts = locals.kind === 'local-loadouts' ? locals.options : []
        const cloudConnectors = connectors.kind === 'cloud-connectors' ? connectors.options : []
        let cloudTargets: readonly NimiDesktopAiConfigCloudTargetOption[] = []
        if (nextDrafts[capability].routeKind === 'cloud' && nextDrafts[capability].connectorRef) {
          const targets = await aiConfig.listOptions({
            kind: 'cloud-targets',
            capabilityContract: capability,
            connectorRef: nextDrafts[capability].connectorRef,
          })
          if (targets.kind === 'cloud-targets') cloudTargets = targets.options
          const matched = findMatchingCloudTarget(
            cloudTargets,
            nextDrafts[capability].targetKey,
            nextDrafts[capability].targetObj,
          )
          if (matched) {
            nextDrafts[capability] = {
              ...nextDrafts[capability],
              targetKey: targetKeyOf(matched.providerModelTarget),
              targetObj: matched.providerModelTarget,
              implementation: matched.implementation ?? nextDrafts[capability].implementation,
            }
          }
        }
        nextOptions[capability] = { localLoadouts, cloudConnectors, cloudTargets }
      }))
      setDrafts(nextDrafts)
      setOptions(nextOptions)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('nimi.models.loadError'))
    } finally {
      setLoading(false)
    }
  }, [aiConfig, t])

  useEffect(() => {
    if (aiConfig) void loadConfig()
  }, [aiConfig, loadConfig])

  if (!aiConfig) {
    return (
      <div className={css.stack}>
        <section className={css.card}>
          <div>
            <h3 className={css.title}>{t('nimi.settings')}</h3>
            <p className={css.description}>{t('nimi.description')}</p>
          </div>
          {error && <div className={css.notice} data-tone="error" role="alert">{error}</div>}
          <div className={css.actions}>
            <Button variant="primary" size="sm" onClick={() => {
              setError(null)
              void openNimiSettings().catch(() => { setError(t('nimi.settingsError')) })
            }}>
              {t('nimi.open')}
            </Button>
          </div>
        </section>
      </div>
    )
  }

  const records: readonly NimiDesktopAiConfigRecord[] = snapshot?.records ?? (snapshot?.record ? [snapshot.record] : [])
  const activeRecord = snapshot?.record

  const runOverwrite = async (
    recordEdit: NimiDesktopAiConfigOverwriteInput['record'],
    nextCapabilities?: readonly NimiDesktopAiConfigIntent[],
    successMessage?: string,
  ): Promise<void> => {
    if (!snapshot) return
    setSaving(true)
    setError(null)
    setNotice(null)
    setConflict(false)
    try {
      const result = await aiConfig.overwrite({
        ...(recordEdit ? { record: recordEdit } : {}),
        expectedRevision: snapshot.revision,
        capabilities: nextCapabilities ?? buildIntents(snapshot, drafts, options),
      })
      if (result.outcome === 'conflict') {
        setConflict(true)
        setError(t('nimi.models.conflict'))
        return
      }
      const refAfter = result.record?.configRef
      if (adoptLatestRevision) await adoptLatestRevision(refAfter).catch(() => undefined)
      await loadConfig(recordEdit?.action === 'delete' ? undefined : refAfter)
      setNotice(successMessage ?? t('nimi.models.saved'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('nimi.models.saveError'))
    } finally {
      setSaving(false)
    }
  }

  const updateDraft = (capability: ManagedCapability, patch: Partial<CapabilityDraft>): void => {
    setDrafts(prev => ({ ...prev, [capability]: { ...prev[capability], ...patch } }))
  }

  const stateLabelFor = (state: 'ready' | 'missing' | 'blocked' | 'unavailable'): string => {
    switch (state) {
      case 'ready': return t('nimi.models.stateReady')
      case 'missing': return t('nimi.models.stateMissing')
      case 'blocked': return t('nimi.models.stateBlocked')
      default: return t('nimi.models.stateUnavailable')
    }
  }

  return (
    <div className={css.stack}>
      <section className={css.card}>
        <div className={css.headerRow}>
          <div className={css.headerCopy}>
            <h3 className={css.title}>{t('nimi.models.title')}</h3>
            <p className={css.description}>{t('nimi.models.description')}</p>
          </div>
          <div className={css.actions}>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => { void loadConfig(selectedRef) }}>
              {t('nimi.action.refresh')}
            </Button>
            {openHome && (
              <Button variant="outline" size="sm" onClick={() => { void openHome('ai-models').catch(() => undefined) }}>
                {t('nimi.models.manageInHome')}
              </Button>
            )}
          </div>
        </div>

        <div className={css.fieldGrid}>
          <div className={css.field}>
            <label className={css.label} htmlFor="nimi-config-select">{t('nimi.models.configSelectLabel')}</label>
            <select
              id="nimi-config-select"
              className={css.select}
              value={selectedRef ?? ''}
              disabled={loading || saving}
              onChange={(event) => {
                const nextRef = event.target.value || undefined
                setSelectedRef(nextRef)
                void loadConfig(nextRef)
              }}
            >
              {records.map(record => (
                <option key={record.configRef} value={record.configRef}>
                  {record.name}{record.isDefault ? ` (${t('nimi.models.defaultTag')})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className={css.field}>
            <label className={css.label} htmlFor="nimi-config-rename">{t('nimi.models.renameLabel')}</label>
            <div className={css.actions}>
              <input
                id="nimi-config-rename"
                className={css.input}
                style={{ flex: 1 }}
                value={renameValue}
                disabled={!activeRecord || saving}
                onChange={(event) => { setRenameValue(event.target.value) }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!activeRecord || saving || !renameValue.trim() || renameValue.trim() === activeRecord.name}
                onClick={() => {
                  if (!activeRecord) return
                  void runOverwrite({ configRef: activeRecord.configRef, action: 'rename', name: renameValue.trim() })
                }}
              >
                {t('nimi.models.renameAction')}
              </Button>
            </div>
          </div>
        </div>

        <div className={css.actions}>
          {activeRecord && !activeRecord.isDefault && (
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => {
                void runOverwrite({ configRef: activeRecord.configRef, action: 'make-default' })
              }}
            >
              {t('nimi.models.setDefault')}
            </Button>
          )}
          {activeRecord && records.length > 1 && (
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => {
                void runOverwrite({ configRef: activeRecord.configRef, action: 'delete' })
              }}
            >
              {t('nimi.models.deleteConfig')}
            </Button>
          )}
          {adoptLatestRevision && (
            <Button
              variant="outline"
              size="sm"
              disabled={saving || loading}
              onClick={() => {
                void adoptLatestRevision(selectedRef).then(() => {
                  setConflict(false)
                  setNotice(t('nimi.models.adopted'))
                  return loadConfig(selectedRef)
                }).catch(() => undefined)
              }}
            >
              {t('nimi.models.adoptRevision')}
            </Button>
          )}
        </div>

        <hr className={css.divider} />

        <div className={css.field}>
          <label className={css.label} htmlFor="nimi-config-create">{t('nimi.models.createLabel')}</label>
          <div className={css.actions}>
            <input
              id="nimi-config-create"
              className={css.input}
              style={{ flex: 1 }}
              value={newName}
              placeholder={t('nimi.models.createPlaceholder')}
              disabled={saving}
              onChange={(event) => { setNewName(event.target.value) }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={saving || !newName.trim()}
              onClick={() => {
                const name = newName.trim()
                setNewName('')
                void runOverwrite({ action: 'create', name }, buildIntents(snapshot, drafts, options))
              }}
            >
              {t('nimi.models.createAction')}
            </Button>
          </div>
        </div>
      </section>

      {MANAGED_CAPABILITIES.map((capability) => {
        const draft = drafts[capability]
        const capOptions = options[capability]
        const effective = snapshot?.effectiveSelections.find(s => s.capabilityContract === capability)
        const stateTone = effective?.state === 'ready'
          ? 'ready'
          : effective?.state === 'missing'
            ? 'warning'
            : 'error'
        const title = capability === 'text.generate'
          ? t('nimi.models.capTextGenerate')
          : t('nimi.models.capAudioTranscribe')
        const activeTargetSummary = effective?.resource?.oneofKind === 'cloud'
          ? `${effective.resource.cloud.connector.label} · ${effective.resource.cloud.target.label}`
          : effective?.resource?.oneofKind === 'local'
            ? effective.resource.local.label
            : undefined

        return (
          <section key={capability} className={css.card}>
            <div className={css.headerRow}>
              <div className={css.headerCopy}>
                <h4 className={css.title}>{title}</h4>
                <p className={css.description}>
                  {capability}{activeTargetSummary ? ` · ${activeTargetSummary}` : ''}
                </p>
              </div>
              {effective && (
                <span className={css.pill} data-tone={stateTone}>{stateLabelFor(effective.state)}</span>
              )}
            </div>

            <div className={css.fieldGrid}>
              <div className={css.field}>
                <label className={css.label} htmlFor={`route-kind-${capability}`}>{t('nimi.models.routeLabel')}</label>
                <select
                  id={`route-kind-${capability}`}
                  className={css.select}
                  value={draft.routeKind}
                  disabled={loading || saving}
                  onChange={(event) => {
                    const kind = event.target.value as CapabilityDraft['routeKind']
                    updateDraft(capability, {
                      routeKind: kind,
                      loadoutRef: '',
                      connectorRef: '',
                      targetKey: '',
                      targetObj: undefined,
                      implementation: undefined,
                    })
                  }}
                >
                  <option value="none">{t('nimi.models.routeUnset')}</option>
                  <option value="local">{t('nimi.models.routeLocal')}</option>
                  <option value="cloud">{t('nimi.models.routeCloud')}</option>
                </select>
              </div>

              {draft.routeKind === 'local' && (
                <div className={css.field}>
                  <span className={css.label}>{t('nimi.models.loadoutLabel')}</span>
                  {capOptions.localLoadouts.length > 0 ? (
                    <div className={css.notice} data-tone={capOptions.localLoadouts[0]?.state === 'ready' ? 'success' : 'error'}>
                      {t('nimi.models.localActiveSummary', { label: capOptions.localLoadouts[0]?.label ?? '' })}
                    </div>
                  ) : (
                    <div className={css.notice}>
                      <div>{t('nimi.models.localAutoHint')}</div>
                      {openHome && (
                        <div style={{ marginTop: 8 }}>
                          <Button variant="outline" size="sm" onClick={() => { void openHome('ai-models').catch(() => undefined) }}>
                            {t('nimi.models.openLocalInHome')}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {draft.routeKind === 'cloud' && (
                <>
                  <div className={css.field}>
                    <label className={css.label} htmlFor={`connector-${capability}`}>{t('nimi.models.connectorLabel')}</label>
                    <select
                      id={`connector-${capability}`}
                      className={css.select}
                      value={draft.connectorRef}
                      disabled={loading || saving}
                      onChange={(event) => {
                        const connectorRef = event.target.value
                        setTargetFilter(prev => ({ ...prev, [capability]: '' }))
                        updateDraft(capability, { connectorRef, targetKey: '', targetObj: undefined, implementation: undefined })
                        void loadCloudTargets(capability, connectorRef)
                      }}
                    >
                      <option value="">{t('nimi.models.selectOption')}</option>
                      {capOptions.cloudConnectors.map(opt => (
                        <option key={opt.connectorRef} value={opt.connectorRef}>
                          {opt.label} ({opt.provider})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={css.field}>
                    <label className={css.label} htmlFor={`target-${capability}`}>{t('nimi.models.targetLabel')}</label>
                    {capOptions.cloudTargets.length > 6 && (
                      <input
                        className={css.input}
                        type="search"
                        value={targetFilter[capability]}
                        placeholder={t('nimi.models.targetFilterPlaceholder')}
                        aria-label={t('nimi.models.targetFilterPlaceholder')}
                        disabled={loading || saving || !draft.connectorRef}
                        onChange={(event) => {
                          const value = event.target.value
                          setTargetFilter(prev => ({ ...prev, [capability]: value }))
                        }}
                      />
                    )}
                    <select
                      id={`target-${capability}`}
                      className={css.select}
                      value={draft.targetKey}
                      disabled={loading || saving || !draft.connectorRef}
                      onChange={(event) => {
                        const key = event.target.value
                        const found = capOptions.cloudTargets.find(o => targetKeyOf(o.providerModelTarget) === key)
                        updateDraft(capability, {
                          targetKey: key,
                          targetObj: found?.providerModelTarget,
                          implementation: found?.implementation,
                        })
                      }}
                    >
                      <option value="">{t('nimi.models.selectOption')}</option>
                      {capOptions.cloudTargets
                        .filter((opt) => {
                          const q = targetFilter[capability].trim().toLowerCase()
                          if (!q) return true
                          const key = targetKeyOf(opt.providerModelTarget)
                          return key === draft.targetKey || opt.label.toLowerCase().includes(q)
                        })
                        .map((opt, idx) => {
                          const key = targetKeyOf(opt.providerModelTarget)
                          return (
                            <option key={`${key}-${idx}`} value={key}>
                              {opt.label}{opt.state !== 'ready' ? ` (${opt.state})` : ''}
                            </option>
                          )
                        })}
                    </select>
                  </div>
                </>
              )}
            </div>

            {effective && effective.reasons.length > 0 && (
              <div className={css.notice} data-tone="error">
                {effective.reasons.join(' · ')}
              </div>
            )}
          </section>
        )
      })}

      {error && (
        <div className={css.notice} data-tone="error" role="alert">
          <div>{error}</div>
          {conflict && (
            <div style={{ marginTop: 8 }}>
              <Button variant="outline" size="sm" onClick={() => {
                void (adoptLatestRevision ? adoptLatestRevision(selectedRef) : Promise.resolve())
                  .then(() => loadConfig(selectedRef))
              }}>
                {t('nimi.models.adoptRevision')}
              </Button>
            </div>
          )}
        </div>
      )}
      {notice && <div className={css.notice} data-tone="success" role="status">{notice}</div>}

      <div className={css.footerBar}>
        <Button
          variant="primary"
          disabled={loading || saving || !snapshot}
          onClick={() => {
            void runOverwrite(activeRecord ? { configRef: activeRecord.configRef, action: 'save' } : undefined)
          }}
        >
          {saving ? t('nimi.status.connecting') : t('nimi.models.saveAction')}
        </Button>
      </div>
    </div>
  )
}
