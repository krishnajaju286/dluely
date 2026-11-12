import { app, shell } from "electron"
import fs from "fs"
import path from "path"
import { LLMHelper } from "./LLMHelper"

export interface DetectedCard {
  id: string
  type: "question" | "term"
  detected_text: string
  direct_answer: string
  key_points: string[]
  timestamp: string
}

export class MeetingHelper {
  private llmHelper: LLMHelper
  private isMeetingActive: boolean = false
  private meetingTitle: string = "Interview Session"
  private meetingStartTime: Date | null = null
  private meetingFilePath: string | null = null
  private meetingsDir: string
  private transcriptHistory: Array<{ timestamp: string; text: string }> = []
  private detectedCards: DetectedCard[] = []

  constructor(llmHelper: LLMHelper) {
    this.llmHelper = llmHelper
    this.meetingsDir = path.join(app.getPath("documents"), "Dluely_Meetings")
    if (!fs.existsSync(this.meetingsDir)) {
      try {
        fs.mkdirSync(this.meetingsDir, { recursive: true })
      } catch (err) {
        console.error("[MeetingHelper] Error creating meetings dir:", err)
      }
    }
  }

  public getStatus() {
    return {
      isMeetingActive: this.isMeetingActive,
      meetingTitle: this.meetingTitle,
      meetingFilePath: this.meetingFilePath,
      startTime: this.meetingStartTime ? this.meetingStartTime.getTime() : null,
      questionsCount: this.detectedCards.length,
      meetingsDir: this.meetingsDir
    }
  }

  public async startMeeting(meetingName?: string): Promise<{ success: boolean; filePath: string }> {
    this.isMeetingActive = true
    this.meetingStartTime = new Date()
    this.meetingTitle = meetingName?.trim() || `Interview_${this.meetingStartTime.toISOString().slice(0, 10)}`
    this.transcriptHistory = []
    this.detectedCards = []

    const dateStr = this.meetingStartTime.toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const sanitizedTitle = this.meetingTitle.replace(/[^a-zA-Z0-9_-]/g, "_")
    const filename = `Meeting_${sanitizedTitle}_${dateStr}.md`
    this.meetingFilePath = path.join(this.meetingsDir, filename)

    const initialContent = `# Minutes of the Meeting: ${this.meetingTitle}
- **Date:** ${this.meetingStartTime.toLocaleDateString()}
- **Start Time:** ${this.meetingStartTime.toLocaleTimeString()}
- **Status:** In Progress
- **Saved Path:** \`${this.meetingFilePath}\`

---

## Real-Time Questions & Identified Terms
*(Live answers provided by Copilot during session)*

## Live Transcript Log
`
    try {
      await fs.promises.writeFile(this.meetingFilePath, initialContent, "utf-8")
      console.log(`[MeetingHelper] Meeting session started. Output: ${this.meetingFilePath}`)
    } catch (err) {
      console.error("[MeetingHelper] Error writing initial meeting file:", err)
    }

    return { success: true, filePath: this.meetingFilePath }
  }

  public async processAudioChunk(audioBase64: string, mimeType: string) {
    if (!this.isMeetingActive) {
      return { success: false, error: "No meeting active" }
    }

    try {
      const recentContext = this.transcriptHistory.slice(-5).map(t => t.text).join(" ")
      const result = await this.llmHelper.processLiveMeetingAudio(audioBase64, mimeType, recentContext)

      const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

      // 1. If transcript text found, append to history and file
      if (result.transcript && result.transcript.trim().length > 0) {
        const entry = { timestamp: timeNow, text: result.transcript.trim() }
        this.transcriptHistory.push(entry)
        
        // Append to markdown file
        if (this.meetingFilePath && fs.existsSync(this.meetingFilePath)) {
          const logLine = `\n> **[${timeNow}]** ${result.transcript.trim()}\n`
          await fs.promises.appendFile(this.meetingFilePath, logLine, "utf-8").catch(console.error)
        }
      }

      // 2. If question or term detected, create card
      let newCard: DetectedCard | null = null
      if (result.has_detection && result.detected_text && result.direct_answer) {
        newCard = {
          id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          type: result.detection_type === "term" ? "term" : "question",
          detected_text: result.detected_text.trim(),
          direct_answer: result.direct_answer.trim(),
          key_points: result.key_points || [],
          timestamp: timeNow
        }
        this.detectedCards.push(newCard)

        // Append to questions section in markdown file
        if (this.meetingFilePath && fs.existsSync(this.meetingFilePath)) {
          const cardEntry = `
### ${newCard.type === "question" ? "❓ Question" : "💡 Technical Term"}: ${newCard.detected_text}
*Timestamp: ${timeNow}*

**Copilot Spoken Answer:**
${newCard.direct_answer}

---
`
          await fs.promises.appendFile(this.meetingFilePath, cardEntry, "utf-8").catch(console.error)
        }
      }

      return {
        success: true,
        transcript: result.transcript || "",
        newCard,
        totalQuestions: this.detectedCards.length
      }
    } catch (err: any) {
      console.error("[MeetingHelper] Error processing audio chunk:", err)
      return { success: false, error: err?.message || String(err) }
    }
  }

  public async stopMeeting(): Promise<{ success: boolean; filePath: string; summary?: string; questionsCount: number }> {
    if (!this.isMeetingActive || !this.meetingFilePath) {
      return { success: false, filePath: this.meetingFilePath || "", questionsCount: 0 }
    }

    const endTime = new Date()
    this.isMeetingActive = false

    try {
      const fullTranscript = this.transcriptHistory.map(t => `[${t.timestamp}] ${t.text}`).join("\n")
      
      // Generate AI-synthesized Minutes of Meeting
      let finalizedMoM = ""
      try {
        finalizedMoM = await this.llmHelper.generateMeetingMinutes(
          this.meetingTitle,
          fullTranscript || "No audible dialogue recorded.",
          this.detectedCards
        )
      } catch (e) {
        console.warn("[MeetingHelper] Fallback to standard MoM markdown format:", e)
        finalizedMoM = `# Minutes of the Meeting: ${this.meetingTitle}
- **Date:** ${this.meetingStartTime?.toLocaleDateString()}
- **Duration:** ${this.meetingStartTime?.toLocaleTimeString()} to ${endTime.toLocaleTimeString()}
- **Total Questions / Concepts Detected:** ${this.detectedCards.length}

## Questions Asked & Real-Time Copilot Answers
${this.detectedCards.map(c => `### ${c.type === "question" ? "Question" : "Concept"}: ${c.detected_text}\n${c.direct_answer}\n`).join("\n\n")}

## Full Transcript Log
${fullTranscript}
`
      }

      await fs.promises.writeFile(this.meetingFilePath, finalizedMoM, "utf-8")
      console.log(`[MeetingHelper] Meeting finalized and saved to: ${this.meetingFilePath}`)

      return {
        success: true,
        filePath: this.meetingFilePath,
        summary: finalizedMoM,
        questionsCount: this.detectedCards.length
      }
    } catch (err: any) {
      console.error("[MeetingHelper] Error stopping meeting:", err)
      return {
        success: false,
        filePath: this.meetingFilePath,
        questionsCount: this.detectedCards.length
      }
    }
  }

  public openMeetingsFolder(): void {
    if (this.meetingFilePath && fs.existsSync(this.meetingFilePath)) {
      shell.showItemInFolder(this.meetingFilePath)
    } else {
      shell.openPath(this.meetingsDir)
    }
  }
}
