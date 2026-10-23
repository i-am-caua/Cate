import path from 'node:path'
import type { AgentConversationMessage } from '../../contract'
import { SAFE_SESSION_ID, exists, forEachJsonlRecord } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore, AgentUsage } from './types'

async function locateTranscript({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  const { sessionId } = session
  if (!sessionId || !SAFE_SESSION_ID.test(sessionId)) return null
  const candidate = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl')
  if (await exists(candidate)) return candidate
  return null
}

async function title({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  const { sessionId } = session
  if (!sessionId) return null
  const historyFile = path.join(homeDir, '.gemini', 'antigravity-cli', 'history.jsonl')
  let found: string | null = null
  await forEachJsonlRecord(historyFile, (record) => {
    if (record.conversationId === sessionId && typeof record.display === 'string' && record.display.trim()) {
      found = record.display.trim().split('\n')[0].slice(0, 80)
    }
  })
  return found
}

async function conversation(context: AgentSessionContext): Promise<AgentConversationMessage[] | null> {
  const file = await locateTranscript(context)
  if (!file) return null
  const messages: AgentConversationMessage[] = []
  const read = await forEachJsonlRecord(file, (record) => {
    const type = record.type
    const content = typeof record.content === 'string' ? record.content : ''
    const createdAt = typeof record.created_at === 'string' ? record.created_at : undefined

    if (type === 'USER_INPUT') {
      let text = content
      const userRequestMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content)
      if (userRequestMatch) text = userRequestMatch[1].trim()
      messages.push({ role: 'user', text, createdAt })
    } else if (type === 'PLANNER_RESPONSE' && content) {
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        last.text += `\n\n${content}`
      } else {
        messages.push({ role: 'assistant', text: content, createdAt })
      }
    }
  })
  return read ? messages : null
}

const files = async (context: AgentSessionContext): Promise<string[]> => {
  const file = await locateTranscript(context)
  return file ? [file] : []
}

const agyUsage: AgentUsage = {
  source: {
    kind: 'none',
    location: (homeDir) => path.join(homeDir, '.gemini', 'antigravity-cli'),
    note: async () => 'Antigravity keeps no token counts on this machine.',
  },
}

export const agySessionStore: AgentSessionStore = { title, conversation, files, usage: agyUsage }
