/** Masked credential presentation with a per-value reveal control in interactive text. */
import { useState } from 'react'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import { MASK } from './credential-masks.ts'
import css from './SecretText.module.css'

const EYE_CONTOUR = 'M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z'
const EYE_PATH = `${EYE_CONTOUR}M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z`
/** The struck-through glyph drops the pupil so it stays distinct at text size. */
const EYE_OFF_PATH = `${EYE_CONTOUR}M2.5 2.5L13.5 13.5`
const MASK_RUNS = new RegExp(`(\\${MASK}+)`, 'u')
const PLAIN = /^[\x20-\x7e]+$/u
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function EyeGlyph({ path }: { readonly path: string }) {
  return (
    <svg className={css.icon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true">
      <path d={path} />
    </svg>
  )
}

/**
 * Use one run for printable ASCII, including long keys. Variable-width graphemes
 * get the same cell and wrap point in both states, even for fallback emoji fonts.
 */
function HiddenRun({ source, revealed }: { readonly source: string; readonly revealed: boolean }) {
  const plainRun = (start: number, end: number) => <span key={start} className={revealed ? undefined : css.mask}>
    {revealed ? source.slice(start, end) : MASK.repeat(end - start)}
  </span>
  if (PLAIN.test(source)) return plainRun(0, source.length)
  const runs = []
  let start = 0
  for (const { index, segment } of GRAPHEMES.segment(source)) {
    if (PLAIN.test(segment)) continue
    if (start < index) runs.push(plainRun(start, index))
    const marks = Array.from(segment).length
    runs.push(<span key={index} className={css.cell} style={{ inlineSize: `max(1em, ${Math.max(2, marks)}ch)` }}>
      <span className={revealed ? undefined : css.mask}>{revealed ? segment : MASK.repeat(marks)}</span>
    </span>)
    start = index + segment.length
  }
  if (start < source.length) runs.push(plainRun(start, source.length))
  return runs
}

/** Keep the same text-run boundaries so rounding each inline fragment gives the same geometry. */
function CredentialText({ masked, raw, revealed }: { readonly masked: string; readonly raw: string; readonly revealed: boolean }) {
  // A non-BMP character occupies two code units in the original and one mark in the mask.
  const original = raw.length === masked.length ? undefined : Array.from(raw)
  let offset = 0
  return masked.split(MASK_RUNS).map((part, index) => {
    if (part === '') return null
    const start = offset
    offset += original === undefined ? part.length : Array.from(part).length
    if (!part.startsWith(MASK)) return <span key={index}>{part}</span>
    const source = original === undefined ? raw.slice(start, offset) : original.slice(start, offset).join('')
    return <HiddenRun key={index} source={source} revealed={revealed} />
  })
}

type SecretTextProps = UserTextNodeProps<'secret'> & PropsLocale<typeof NS>

/**
 * Draw one credential masked; interactive text adds a control that reveals or hides this value.
 * Every mount, and every different original value at the same position, starts masked.
 * @param props - masked node, original spelling, interaction mode, and locale seat.
 * @returns an inline masked run with an optional reveal control.
 */
export function SecretText({ node, raw, interactive, t }: SecretTextProps) {
  // Holding the revealed value instead of a flag re-masks a different credential that reuses this element.
  const [revealedRaw, setRevealedRaw] = useState<string | undefined>()
  const revealed = interactive && revealedRaw === raw
  return (
    <span className={css.secret} data-secret="">
      <span className={css.value}><CredentialText masked={node.data.masked} raw={raw} revealed={revealed} /></span>
      {interactive && (
        <button
          type="button"
          className={css.toggle}
          aria-pressed={revealed}
          aria-label={t(revealed ? 'secret.hide' : 'secret.reveal')}
          onClick={() => { setRevealedRaw(revealed ? undefined : raw) }}
        >
          <EyeGlyph path={revealed ? EYE_OFF_PATH : EYE_PATH} />
        </button>
      )}
    </span>
  )
}
