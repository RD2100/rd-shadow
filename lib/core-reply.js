/**
 * What a target Session answered after one point in its log
 * (docs/decisions.md ADR-012, docs/detailed-design.md §4.6).
 *
 * Layer: core (pure). Imports: ./core-contract.js.
 * Reads `assistant/message` and `turn/end` events only. Shapes verified against
 * dsh 0.2.1-rc.3 logs: content blocks are `text` | `reasoning` | `tool-call`;
 * `turn/end.data.reason.kind` is `completed` | `aborted` | `error` | `blocked` |
 * `max-tokens`.
 */

import { REPLY_TEXT_MAX } from './core-contract.js'

/** Characters of a turn error message kept in the reply summary. */
const ERROR_TEXT_MAX = 300

/**
 * Join the visible text blocks of one assistant message. Reasoning is private
 * to the target and tool calls are counted, not shown.
 * @param message - `data.message` of an `assistant/message` event.
 * @returns the text, possibly empty.
 */
function visibleText(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Fold the target's reply after `afterSeq`.
 *
 * The reply is the latest assistant message with visible text; earlier
 * messages are only counted, because a working target narrates between tool
 * calls and the final message is the one that reports the outcome.
 * @param facts - `{events, afterSeq, maxChars?}`.
 * @returns `{messages, toolCalls, turnsEnded, lastTurnEnd, latest}` where
 *   `lastTurnEnd` is `{seq, kind, error?}` or null and `latest` is
 *   `{seq, text, chars, truncated, interrupted}` or null.
 */
export function collectReply({ events, afterSeq, maxChars = REPLY_TEXT_MAX }) {
  let messages = 0
  let toolCalls = 0
  let turnsEnded = 0
  let lastTurnEnd = null
  let latest = null
  let activeTurn
  for (const event of events) {
    if (event.seq <= afterSeq) continue
    if (event.type === 'turn/start') {
      activeTurn = event.data?.turn
      lastTurnEnd = null
    } else if (event.type === 'assistant/message') {
      activeTurn = event.data?.turn
      lastTurnEnd = null
      messages += 1
      const content = event.data?.message?.content ?? []
      toolCalls += content.filter((block) => block?.type === 'tool-call').length
      const text = visibleText(event.data?.message)
      if (text.length > 0) {
        latest = {
          seq: event.seq,
          text: text.length > maxChars ? text.slice(0, maxChars) : text,
          chars: text.length,
          truncated: text.length > maxChars,
          interrupted: event.data?.interrupted === true,
        }
      }
    } else if (event.type === 'turn/end') {
      turnsEnded += 1
      if (activeTurn !== undefined && event.data?.turn !== undefined && activeTurn !== event.data.turn) continue
      const reason = event.data?.reason
      const message = reason?.error?.message
      lastTurnEnd = {
        seq: event.seq,
        kind: typeof reason?.kind === 'string' ? reason.kind : 'unknown',
        ...typeof message === 'string' ? { error: message.slice(0, ERROR_TEXT_MAX) } : {},
      }
    }
  }
  return { messages, toolCalls, turnsEnded, lastTurnEnd, latest }
}
