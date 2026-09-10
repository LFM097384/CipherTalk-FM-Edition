import { Calendar, CircleDashed } from '@gravity-ui/icons'
import { useEffect, useState } from 'react'
import { Button, Label, Modal, ProgressBar } from '@heroui/react'
import type { ChatSession } from '../../../types/models'
import { formatMessagesAsText } from '../utils/copyChatText'
import { useTopToast } from '../hooks/useTopToast'

const pad2 = (value: number) => String(value).padStart(2, '0')

function todayValue(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/** 'YYYY-MM-DD' -> 当天 00:00:00 / 23:59:59 的秒级时间戳 */
function dateStrToRangeSeconds(dateStr: string): { startSec: number; endSec: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!match) return null
  const [, y, m, d] = match.map(Number) as unknown as [number, number, number, number]
  const startSec = Math.floor(new Date(y, m - 1, d, 0, 0, 0).getTime() / 1000)
  const endSec = Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000)
  return { startSec, endSec }
}

interface CopyDateRangeModalProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  session: ChatSession | null
  sessionId: string | null
}

/** 按日期范围复制聊天记录为纯文本（ChatHeader"批量工具"下拉触发）。 */
export function CopyDateRangeModal({ isOpen, onOpenChange, session, sessionId }: CopyDateRangeModalProps) {
  const [startDate, setStartDate] = useState(todayValue())
  const [endDate, setEndDate] = useState(todayValue())
  const [isCopying, setIsCopying] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const { showTopToast } = useTopToast()

  useEffect(() => {
    if (isOpen) {
      const today = todayValue()
      setStartDate(today)
      setEndDate(today)
      setProgress({ done: 0, total: 0 })
    }
  }, [isOpen])

  const range = dateStrToRangeSeconds(startDate)
  const endRange = dateStrToRangeSeconds(endDate)
  const isRangeInvalid = !range || !endRange || startDate > endDate

  const handleConfirm = async () => {
    if (isCopying || isRangeInvalid || !range || !endRange || !session || !sessionId) return
    setIsCopying(true)
    setProgress({ done: 0, total: 0 })
    try {
      const result = await window.electronAPI.chat.getMessagesByTimeRange(
        sessionId,
        range.startSec,
        endRange.endSec,
        20000
      )
      if (!result.success) {
        showTopToast(result.error || '获取消息失败', false)
        return
      }
      const messages = result.messages || []
      if (messages.length === 0) {
        showTopToast('该时间段没有消息', false)
        return
      }
      const { text, count } = await formatMessagesAsText(session, messages, (done, total) => {
        setProgress({ done, total })
      })
      await navigator.clipboard.writeText(text)
      const displayName = session.displayName || session.username
      const safeName = displayName.replace(/[<>:"/\\|?*]/g, '')
      const fileName = `聊天记录_${safeName}_${startDate}_${endDate}.txt`
      try {
        const downloadsPath = await window.electronAPI.app.getDownloadsPath()
        const writeResult = await window.electronAPI.file.writeTextFile(`${downloadsPath}\\${fileName}`, text)
        if (writeResult.success) {
          showTopToast(`已复制 ${count} 条消息，并存到 下载\\${fileName}`, true)
        } else {
          showTopToast(`已复制 ${count} 条消息，txt 保存失败`, true)
        }
      } catch (writeError) {
        console.error('[CopyDateRangeModal] 保存 txt 失败', writeError)
        showTopToast(`已复制 ${count} 条消息，txt 保存失败`, true)
      }
      if (result.hasMore) {
        showTopToast('消息过多，仅复制了最近 20000 条', false)
      }
      onOpenChange(false)
    } catch (error) {
      console.error('[CopyDateRangeModal] 按日期复制失败', error)
      showTopToast('复制失败', false)
    } finally {
      setIsCopying(false)
      setProgress({ done: 0, total: 0 })
    }
  }

  const [sy, sm, sd] = startDate.split('-').map(Number)
  const [, em, ed] = endDate.split('-').map(Number)

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => { if (!isCopying) onOpenChange(open) }}>
      <Modal.Container>
        <Modal.Dialog className="sm:max-w-100">
          <Modal.CloseTrigger isDisabled={isCopying} />
          <Modal.Header>
            <Modal.Icon className="bg-default text-foreground">
              <Calendar className="size-5" />
            </Modal.Icon>
            <Modal.Heading>按日期复制记录</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            {!isCopying ? (
              <>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    className="flex-1 rounded-md border border-default-300 bg-background px-2 py-1.5 text-sm"
                    value={startDate}
                    max={endDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                  <span className="text-sm text-muted">至</span>
                  <input
                    type="date"
                    className="flex-1 rounded-md border border-default-300 bg-background px-2 py-1.5 text-sm"
                    value={endDate}
                    min={startDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
                <p className="mt-3 text-sm text-muted">
                  将复制 {sy}年{sm}月{sd}日 00:00 至 {em}月{ed}日 23:59 的全部消息
                </p>
                {isRangeInvalid && (
                  <p className="mt-2 text-xs text-danger">开始日期不能晚于结束日期</p>
                )}
              </>
            ) : (
              <>
                <ProgressBar aria-label="转写进度" value={progress.done} maxValue={Math.max(1, progress.total)}>
                  <Label>{progress.total > 0 ? `转写中 ${progress.done}/${progress.total}` : '正在获取消息…'}</Label>
                  <ProgressBar.Output />
                  <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
                </ProgressBar>
              </>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button slot="close" variant="secondary" isDisabled={isCopying}>取消</Button>
            <Button onPress={handleConfirm} isDisabled={isCopying || isRangeInvalid}>
              {isCopying ? <CircleDashed className="size-4 animate-spin" /> : <Calendar className="size-4" />}
              复制
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
