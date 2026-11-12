import React, { useState, useEffect, useRef } from "react"
import { DualAudioMixer, MixerStatus } from "../../lib/audioMixer"
import {
  IoMic,
  IoVolumeHigh,
  IoStopCircle,
  IoFolderOpenOutline,
  IoCheckmark,
  IoCopyOutline,
  IoSparkles,
  IoHelpCircleOutline,
  IoTimeOutline,
  IoClose,
  IoChevronDown,
  IoChevronUp
} from "react-icons/io5"

export interface DetectedCard {
  id: string
  type: "question" | "term"
  detected_text: string
  direct_answer: string
  key_points: string[]
  timestamp: string
}

interface InterviewCopilotProps {
  isOpen: boolean
  onClose: () => void
  onToast?: (title: string, desc: string, variant: "neutral" | "success" | "error") => void
}

export const InterviewCopilot: React.FC<InterviewCopilotProps> = ({
  isOpen,
  onClose,
  onToast
}) => {
  const [isRecording, setIsRecording] = useState(false)
  const [meetingTitle, setMeetingTitle] = useState("Interview Session")
  const [meetingFilePath, setMeetingFilePath] = useState<string | null>(null)
  const [durationSeconds, setDurationSeconds] = useState(0)
  const [mixerStatus, setMixerStatus] = useState<MixerStatus>({
    isRecording: false,
    hasMic: false,
    hasCallAudio: false,
    statusText: "Idle"
  })

  // Full history of detected questions/terms
  const [cards, setCards] = useState<DetectedCard[]>([])
  const [isProcessingChunk, setIsProcessingChunk] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [summaryMessage, setSummaryMessage] = useState<string | null>(null)

  const mixerRef = useRef<DualAudioMixer | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  // Format seconds to mm:ss
  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60)
    const remaining = secs % 60
    return `${mins.toString().padStart(2, "0")}:${remaining.toString().padStart(2, "0")}`
  }

  // Handle start session
  const startSession = async () => {
    try {
      // 1. Initialize meeting in backend
      const res = await window.electronAPI.startMeeting(meetingTitle)
      if (res && res.filePath) {
        setMeetingFilePath(res.filePath)
      }

      setCards([])
      setSummaryMessage(null)
      setDurationSeconds(0)

      // 2. Start timer
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = setInterval(() => {
        setDurationSeconds(s => s + 1)
      }, 1000)

      // 3. Initialize Dual Audio Mixer
      const mixer = new DualAudioMixer({
        chunkIntervalMs: 5000,
        onStatusChange: (status) => setMixerStatus(status),
        onError: (err) => {
          console.error("[Copilot UI] Mixer error:", err)
          if (onToast) onToast("Audio Error", err.message || "Failed to capture audio stream", "error")
        },
        onAudioChunk: async (base64, mimeType) => {
          setIsProcessingChunk(true)
          try {
            const chunkRes = await window.electronAPI.processMeetingAudioChunk(base64, mimeType)
            if (chunkRes && chunkRes.newCard) {
              setCards(prev => [...prev, chunkRes.newCard!])
              // Play a very subtle feedback pulse or sound if desired
            }
          } catch (e: any) {
            console.error("[Copilot UI] Audio chunk error:", e)
          } finally {
            setIsProcessingChunk(false)
          }
        }
      })

      mixerRef.current = mixer
      const started = await mixer.start()
      if (started) {
        setIsRecording(true)
        if (onToast) {
          onToast(
            "Copilot Active",
            "Listening to ongoing call and microphone. Questions & direct answers will appear in real time.",
            "success"
          )
        }
      } else {
        if (onToast) onToast("Capture Warning", "Could not start dual audio mixer. Please check microphone permissions.", "error")
        if (timerRef.current) clearInterval(timerRef.current)
      }
    } catch (err: any) {
      console.error("[Copilot UI] Error starting session:", err)
      if (onToast) onToast("Error", err.message || "Failed to start meeting session", "error")
    }
  }

  // Handle stop session & save MoM
  const stopSession = async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    if (mixerRef.current) {
      mixerRef.current.stop()
      mixerRef.current = null
    }

    setIsRecording(false)

    try {
      const result = await window.electronAPI.stopMeeting()
      if (result.success) {
        setSummaryMessage(`Saved ${result.questionsCount} questions to MoM document: ${result.filePath}`)
        if (onToast) {
          onToast(
            "Meeting Minutes Saved",
            `Comprehensive MoM saved to ~/Documents/Dluely_Meetings/ (${result.questionsCount} questions detected)`,
            "success"
          )
        }
      }
    } catch (err: any) {
      console.error("[Copilot UI] Error stopping meeting:", err)
      if (onToast) onToast("Error", "Failed to finalize meeting minutes", "error")
    }
  }

  const handleOpenFolder = async () => {
    try {
      await window.electronAPI.openMeetingsFolder()
    } catch (err) {
      console.error("[Copilot UI] Error opening folder:", err)
    }
  }

  const handleCopyAnswer = (id: string, text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (mixerRef.current) {
        mixerRef.current.stop()
        mixerRef.current = null
      }
    }
  }, [])

  if (!isOpen) return null

  // Display rule: Maintain at least the past 2 answers on screen
  const visibleCards = showAllHistory ? cards : cards.slice(-2)
  const archivedCount = Math.max(0, cards.length - 2)

  return (
    <div className="w-full mt-3 liquid-glass rounded-xl p-4 text-white/90 shadow-2xl border border-white/20 backdrop-blur-xl">
      {/* Top Header Bar */}
      <div className="flex items-center justify-between pb-3 border-b border-white/10 flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <div className="relative flex items-center justify-center">
            {isRecording ? (
              <>
                <span className="w-3 h-3 rounded-full bg-emerald-400 animate-ping absolute" />
                <span className="w-3 h-3 rounded-full bg-emerald-500" />
              </>
            ) : (
              <span className="w-3 h-3 rounded-full bg-gray-400" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold tracking-wide text-white uppercase">
                Live Interview Copilot
              </span>
              {isRecording && (
                <span className="bg-emerald-500/20 text-emerald-300 text-[10px] px-2 py-0.5 rounded-full border border-emerald-500/30 font-medium">
                  Active
                </span>
              )}
            </div>
            <div className="text-[10px] text-white/60 flex items-center gap-1.5 mt-0.5">
              <IoTimeOutline className="w-3 h-3" />
              <span>{formatTime(durationSeconds)}</span>
              <span>•</span>
              <span>{cards.length} {cards.length === 1 ? "question" : "questions"} captured</span>
            </div>
          </div>
        </div>

        {/* Audio Input Badges */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <div
            className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] border ${
              mixerStatus.hasMic
                ? "bg-emerald-950/60 border-emerald-500/40 text-emerald-300"
                : "bg-white/5 border-white/10 text-white/40"
            }`}
            title="User Microphone Capture"
          >
            <IoMic className="w-3 h-3" />
            <span>Mic</span>
          </div>

          <div
            className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] border ${
              mixerStatus.hasCallAudio
                ? "bg-cyan-950/60 border-cyan-500/40 text-cyan-300"
                : "bg-white/5 border-white/10 text-white/40"
            }`}
            title="Call / System Audio Loopback (Zoom, Teams, Meet)"
          >
            <IoVolumeHigh className="w-3 h-3" />
            <span>{mixerStatus.hasCallAudio ? "Call Audio" : "Room Audio"}</span>
          </div>

          {/* Action Buttons */}
          <button
            onClick={handleOpenFolder}
            className="flex items-center gap-1 bg-white/10 hover:bg-white/20 transition-colors rounded-md px-2 py-1 text-[11px] text-white/80"
            title="Open Minutes of Meeting folder"
          >
            <IoFolderOpenOutline className="w-3.5 h-3.5" />
            <span>Minutes</span>
          </button>

          {isRecording ? (
            <button
              onClick={stopSession}
              className="flex items-center gap-1 bg-red-600/80 hover:bg-red-600 transition-colors rounded-md px-2.5 py-1 text-[11px] font-medium text-white shadow-md"
            >
              <IoStopCircle className="w-3.5 h-3.5" />
              <span>End & Save MoM</span>
            </button>
          ) : (
            <button
              onClick={startSession}
              className="flex items-center gap-1 bg-emerald-600/80 hover:bg-emerald-600 transition-colors rounded-md px-2.5 py-1 text-[11px] font-medium text-white shadow-md"
            >
              <IoSparkles className="w-3.5 h-3.5" />
              <span>Start Copilot</span>
            </button>
          )}

          <button
            onClick={onClose}
            className="text-white/40 hover:text-white transition-colors p-1"
            title="Minimize Copilot Window"
          >
            <IoClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Session Title Input (Editable before or during session) */}
      <div className="mt-2.5 flex items-center gap-2">
        <label className="text-[10px] text-white/50 uppercase tracking-wider font-semibold">
          Meeting:
        </label>
        <input
          type="text"
          value={meetingTitle}
          onChange={(e) => setMeetingTitle(e.target.value)}
          disabled={isRecording}
          placeholder="e.g. Google System Design Interview"
          className="bg-black/20 border border-white/10 rounded px-2 py-0.5 text-xs text-white focus:outline-none focus:border-white/30 flex-1 max-w-sm"
        />
        {isProcessingChunk && (
          <span className="flex items-center gap-1 text-[10px] text-cyan-300 animate-pulse ml-auto">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
            Analyzing speech...
          </span>
        )}
      </div>

      {/* Summary / Notification Message */}
      {summaryMessage && (
        <div className="mt-2.5 p-2 rounded-lg bg-emerald-950/70 border border-emerald-500/30 text-emerald-200 text-xs flex items-center justify-between">
          <span className="truncate">{summaryMessage}</span>
          <button
            onClick={handleOpenFolder}
            className="underline ml-2 text-emerald-300 hover:text-emerald-100 flex-shrink-0"
          >
            Open File
          </button>
        </div>
      )}

      {/* Cards Area: Stack of past 2 questions & direct spoken answers */}
      <div className="mt-3 space-y-3">
        {cards.length === 0 ? (
          <div className="p-4 rounded-lg bg-white/5 border border-white/10 text-center">
            <div className="flex justify-center mb-2">
              <div className="w-8 h-8 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center">
                <IoHelpCircleOutline className="w-5 h-5 animate-pulse" />
              </div>
            </div>
            <p className="text-xs font-medium text-white/80">
              {isRecording
                ? "Listening to call and microphone in real time..."
                : "Ready to start live interview session."}
            </p>
            <p className="text-[11px] text-white/50 mt-1 max-w-md mx-auto leading-relaxed">
              Full dialogue is automatically transcribed and recorded into Minutes of Meeting in the background.
              Whenever an <strong>interview question</strong> or <strong>technical concept</strong> is detected,
              spontaneous, directly answerable bullet points will pop up right here.
            </p>
          </div>
        ) : (
          <>
            {/* Notification when older cards are archived into MoM */}
            {archivedCount > 0 && !showAllHistory && (
              <div className="flex items-center justify-between px-2 py-1 bg-white/5 rounded-md text-[10px] text-white/60 border border-white/10">
                <span>
                  📁 {archivedCount} earlier {archivedCount === 1 ? "question has" : "questions have"} been archived into your Minutes of Meeting document.
                </span>
                <button
                  onClick={() => setShowAllHistory(true)}
                  className="text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5 underline"
                >
                  Show all {cards.length}
                  <IoChevronDown className="w-3 h-3" />
                </button>
              </div>
            )}

            {showAllHistory && archivedCount > 0 && (
              <div className="flex justify-end">
                <button
                  onClick={() => setShowAllHistory(false)}
                  className="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5 underline px-2 py-0.5"
                >
                  Pin latest 2 cards
                  <IoChevronUp className="w-3 h-3" />
                </button>
              </div>
            )}

            {/* The 2 Visible Cards (or all if expanded) */}
            {visibleCards.map((card, idx) => {
              const isLatest = idx === visibleCards.length - 1
              return (
                <div
                  key={card.id}
                  className={`rounded-lg border p-3.5 transition-all shadow-lg ${
                    isLatest
                      ? "bg-gradient-to-b from-gray-900/90 to-gray-950/90 border-cyan-500/50 ring-1 ring-cyan-500/20"
                      : "bg-gray-900/70 border-white/15 opacity-90"
                  }`}
                >
                  {/* Card Header */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                          card.type === "question"
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                            : "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                        }`}
                      >
                        {card.type === "question" ? "❓ Question Asked" : "💡 Technical Term"}
                      </span>
                      <span className="text-[10px] text-white/50">{card.timestamp}</span>
                      {isLatest && (
                        <span className="text-[10px] bg-cyan-500/20 text-cyan-300 px-1.5 py-0.2 rounded font-medium">
                          Latest
                        </span>
                      )}
                    </div>

                    <button
                      onClick={() => handleCopyAnswer(card.id, card.direct_answer)}
                      className="text-white/50 hover:text-white transition-colors p-1 rounded hover:bg-white/10 flex items-center gap-1 text-[11px]"
                      title="Copy answer to clipboard"
                    >
                      {copiedId === card.id ? (
                        <>
                          <IoCheckmark className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-400 text-[10px]">Copied</span>
                        </>
                      ) : (
                        <>
                          <IoCopyOutline className="w-3.5 h-3.5" />
                          <span className="text-[10px]">Copy</span>
                        </>
                      )}
                    </button>
                  </div>

                  {/* Detected Question or Concept */}
                  <div className="mb-2.5">
                    <h4 className="text-xs font-semibold text-white/95 leading-snug">
                      "{card.detected_text}"
                    </h4>
                  </div>

                  {/* Direct Spoken Answer (Fast, instant, actionable bullet points) */}
                  <div className="bg-white/10 rounded-md p-2.5 border border-white/10">
                    <div className="text-[10px] font-medium text-cyan-300/90 uppercase tracking-wider mb-1 flex items-center gap-1">
                      <IoSparkles className="w-3 h-3 text-cyan-400" />
                      <span>Direct Spoken Answer (Read aloud in seconds):</span>
                    </div>

                    <div className="text-xs text-white leading-relaxed space-y-1 font-normal whitespace-pre-line select-text">
                      {card.direct_answer}
                    </div>

                    {card.key_points && card.key_points.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-white/10 flex flex-wrap gap-1.5">
                        {card.key_points.map((point, pIdx) => (
                          <span
                            key={pIdx}
                            className="bg-black/30 text-white/80 px-2 py-0.5 rounded text-[10px] border border-white/10"
                          >
                            • {point}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}

export default InterviewCopilot
