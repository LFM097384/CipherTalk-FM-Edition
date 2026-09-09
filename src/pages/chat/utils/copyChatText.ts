import type { ChatSession, Message } from '../../../types/models'
import { isGroupChat } from './messageGuards'

const VOICE_TRANSCRIBE_CONCURRENCY = 3
// 相邻两条被实际复制的消息间隔超过此秒数（1小时）时插入时间戳分隔线
const DIVIDER_GAP_SECONDS = 3600

interface FormattedEntry {
  name: string
  text: string
  createTime: number
}

function formatDividerLine(createTime: number): string {
  const date = new Date(createTime * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `—————— ${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())} ——————`
}

/**
 * 把消息格式化为"昵称: 内容"的纯文本，每行一条，按传入数组顺序（调用方保证从旧到新）。
 * 昵称规则与分享海报一致：自己→"我"；群聊成员逐个查 getContactAvatar（失败 fallback 到 username）；
 * 私聊对方→会话显示名。语音消息（localType 34）先查 STT 转写缓存，命中则把 "[语音]" 占位换成
 * "[语音] 转写文字"；未命中则现场转写（取语音数据 + STT，结果写入缓存），转写链路任一步失败都
 * 保持 "[语音]" 占位、不中断整体复制。现场转写以并发池（上限 3）执行，通过 onProgress 上报进度
 * （total 为需要现场转写的语音条数）。parsedContent 为空的消息（系统消息等）直接跳过。
 * 相邻两条被实际复制的消息 createTime 间隔超过 1 小时时，在两者之间插入一行独立的时间戳分隔线
 * （不计入返回的 count）。返回 count 为真正参与格式化的消息条数（不含分隔线）。
 */
export async function formatMessagesAsText(
  session: ChatSession,
  messages: Message[],
  onProgress?: (done: number, total: number) => void
): Promise<{ text: string; count: number }> {
  const group = isGroupChat(session.username)

  // 群聊：先解析所有唯一发送者的昵称
  const nameMap = new Map<string, string>()
  if (group) {
    const usernames = Array.from(new Set(
      messages
        .filter((m) => m.isSend !== 1 && m.senderUsername)
        .map((m) => m.senderUsername as string)
    ))
    await Promise.all(usernames.map(async (username) => {
      try {
        const result = await window.electronAPI.chat.getContactAvatar(username)
        nameMap.set(username, result?.displayName || username)
      } catch {
        nameMap.set(username, username)
      }
    }))
  }

  const entries: FormattedEntry[] = []
  const pendingVoice: { entry: FormattedEntry; msg: Message }[] = []

  for (const msg of messages) {
    const text = msg.parsedContent?.trim()
    if (!text) continue

    let name: string
    if (msg.isSend === 1) {
      name = '我'
    } else if (group && msg.senderUsername) {
      name = nameMap.get(msg.senderUsername) || msg.senderUsername
    } else {
      name = session.displayName || session.username
    }

    const entry: FormattedEntry = { name, text, createTime: msg.createTime }
    entries.push(entry)

    if (msg.localType === 34) {
      try {
        const cached = await window.electronAPI.stt.getCachedTranscript(session.username, msg.createTime, msg.localId)
        if (cached.success && cached.transcript) {
          entry.text = `[语音] ${cached.transcript}`
        } else {
          pendingVoice.push({ entry, msg })
        }
      } catch {
        // 查缓存失败，加入现场转写队列
        pendingVoice.push({ entry, msg })
      }
    }
  }

  if (pendingVoice.length > 0) {
    let done = 0
    onProgress?.(done, pendingVoice.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < pendingVoice.length) {
        const { entry, msg } = pendingVoice[cursor++]
        try {
          const result = await window.electronAPI.chat.getVoiceData(
            session.username,
            String(msg.localId),
            msg.createTime,
            msg.serverId
          )
          if (result.success && result.data) {
            const transcribeResult = await window.electronAPI.stt.transcribe(
              result.data,
              session.username,
              msg.createTime,
              false,
              msg.localId
            )
            if (transcribeResult.success && transcribeResult.transcript) {
              entry.text = `[语音] ${transcribeResult.transcript}`
            }
          }
        } catch {
          // 现场转写失败，保持占位
        }
        done++
        onProgress?.(done, pendingVoice.length)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(VOICE_TRANSCRIBE_CONCURRENCY, pendingVoice.length) }, () => worker())
    )
  }

  const lines: string[] = []
  entries.forEach((e, i) => {
    if (i > 0 && e.createTime - entries[i - 1].createTime > DIVIDER_GAP_SECONDS) {
      lines.push(formatDividerLine(e.createTime))
    }
    lines.push(`${e.name}: ${e.text}`)
  })

  return { text: lines.join('\n'), count: entries.length }
}
