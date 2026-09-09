import type { ChatSession, Message } from '../../../types/models'
import { isGroupChat } from './messageGuards'

/**
 * 把消息格式化为"昵称: 内容"的纯文本，每行一条，按传入数组顺序（调用方保证从旧到新）。
 * 昵称规则与分享海报一致：自己→"我"；群聊成员逐个查 getContactAvatar（失败 fallback 到 username）；
 * 私聊对方→会话显示名。语音消息（localType 34）查 STT 转写缓存，命中则把 "[语音]" 占位换成
 * "[语音] 转写文字"，失败保持占位、不现场转写。parsedContent 为空的消息（系统消息等）直接跳过。
 */
export async function formatMessagesAsText(session: ChatSession, messages: Message[]): Promise<string> {
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

  const lines: string[] = []
  for (const msg of messages) {
    let text = msg.parsedContent?.trim()
    if (!text) continue
    if (msg.localType === 34) {
      try {
        const cached = await window.electronAPI.stt.getCachedTranscript(session.username, msg.createTime, msg.localId)
        if (cached.success && cached.transcript) text = `[语音] ${cached.transcript}`
      } catch {
        // 查缓存失败保持占位
      }
    }
    let name: string
    if (msg.isSend === 1) {
      name = '我'
    } else if (group && msg.senderUsername) {
      name = nameMap.get(msg.senderUsername) || msg.senderUsername
    } else {
      name = session.displayName || session.username
    }
    lines.push(`${name}: ${text}`)
  }
  return lines.join('\n')
}
