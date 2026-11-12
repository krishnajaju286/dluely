/**
 * DualAudioMixer: Captures dual-channel audio simultaneously:
 * 1. User microphone (via getUserMedia)
 * 2. Ongoing call/meeting audio (via getDisplayMedia system loopback)
 * 
 * Mixes both channels using the Web Audio API (AudioContext) into a single unified stream
 * and feeds it to MediaRecorder, slicing chunks every 5 seconds for real-time AI transcription & Q&A analysis.
 */

export interface DualAudioMixerOptions {
  chunkIntervalMs?: number // Default: 5000ms
  onAudioChunk: (base64Data: string, mimeType: string) => Promise<void> | void
  onStatusChange?: (status: MixerStatus) => void
  onError?: (error: Error) => void
}

export interface MixerStatus {
  isRecording: boolean
  hasMic: boolean
  hasCallAudio: boolean
  statusText: string
}

export class DualAudioMixer {
  private audioContext: AudioContext | null = null
  private micStream: MediaStream | null = null
  private callStream: MediaStream | null = null
  private mixedStream: MediaStream | null = null
  private mediaRecorder: MediaRecorder | null = null
  private options: DualAudioMixerOptions
  private isRecording: boolean = false
  private hasMic: boolean = false
  private hasCallAudio: boolean = false

  constructor(options: DualAudioMixerOptions) {
    this.options = {
      chunkIntervalMs: 5000,
      ...options
    }
  }

  public getStatus(): MixerStatus {
    return {
      isRecording: this.isRecording,
      hasMic: this.hasMic,
      hasCallAudio: this.hasCallAudio,
      statusText: this.getStatusText()
    }
  }

  private getStatusText(): string {
    if (!this.isRecording) return "Stopped"
    if (this.hasMic && this.hasCallAudio) return "Dual Audio (Mic + Call Audio Active)"
    if (this.hasMic) return "Mic Active (Speaker/Room Audio Fallback)"
    if (this.hasCallAudio) return "Call Audio Active"
    return "Listening..."
  }

  private notifyStatus(customText?: string) {
    if (this.options.onStatusChange) {
      this.options.onStatusChange({
        isRecording: this.isRecording,
        hasMic: this.hasMic,
        hasCallAudio: this.hasCallAudio,
        statusText: customText || this.getStatusText()
      })
    }
  }

  public async start(): Promise<boolean> {
    if (this.isRecording) return true

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
      this.audioContext = new AudioCtx()

      // 1. Acquire User Microphone
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: true
          }
        })
        this.hasMic = true
      } catch (err: any) {
        console.warn("[DualAudioMixer] Failed to acquire microphone:", err)
        this.hasMic = false
      }

      // 2. Attempt to Acquire System / Meeting Call Audio (getDisplayMedia)
      try {
        const displayMedia = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        })

        // Stop video tracks immediately to conserve 100% CPU/GPU resources
        displayMedia.getVideoTracks().forEach(track => {
          track.stop()
          displayMedia.removeTrack(track)
        })

        const audioTracks = displayMedia.getAudioTracks()
        if (audioTracks.length > 0) {
          this.callStream = new MediaStream(audioTracks)
          this.hasCallAudio = true
          console.log("[DualAudioMixer] Successfully acquired call loopback audio track.")
        } else {
          console.log("[DualAudioMixer] No audio track returned by getDisplayMedia; falling back to mic.")
          this.hasCallAudio = false
        }
      } catch (displayErr) {
        // User may cancel display capture or OS doesn't support display audio without virtual device
        console.log("[DualAudioMixer] Call audio capture was skipped or declined. Continuing with high-gain mic:", displayErr)
        this.hasCallAudio = false
      }

      // Ensure we have at least one valid audio source
      if (!this.micStream && !this.callStream) {
        throw new Error("No audio inputs could be captured. Please verify microphone permissions.")
      }

      // 3. Mix sources using Web Audio API
      const destination = this.audioContext.createMediaStreamDestination()

      if (this.micStream && this.micStream.getAudioTracks().length > 0) {
        const micSource = this.audioContext.createMediaStreamSource(this.micStream)
        micSource.connect(destination)
      }

      if (this.callStream && this.callStream.getAudioTracks().length > 0) {
        const callSource = this.audioContext.createMediaStreamSource(this.callStream)
        callSource.connect(destination)
      }

      this.mixedStream = destination.stream

      // 4. Determine supported MIME type for MediaRecorder
      const preferredMimeTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg"
      ]
      let selectedMimeType = ""
      for (const mime of preferredMimeTypes) {
        if (MediaRecorder.isTypeSupported(mime)) {
          selectedMimeType = mime
          break
        }
      }

      this.mediaRecorder = selectedMimeType
        ? new MediaRecorder(this.mixedStream, { mimeType: selectedMimeType })
        : new MediaRecorder(this.mixedStream)

      const recordingMime = this.mediaRecorder.mimeType || selectedMimeType || "audio/webm"

      this.mediaRecorder.ondataavailable = async (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          try {
            const base64Data = await this.blobToBase64(event.data)
            if (base64Data) {
              await this.options.onAudioChunk(base64Data, recordingMime)
            }
          } catch (chunkErr: any) {
            console.error("[DualAudioMixer] Error processing audio chunk:", chunkErr)
          }
        }
      }

      this.mediaRecorder.onerror = (event: any) => {
        console.error("[DualAudioMixer] MediaRecorder error:", event.error)
        if (this.options.onError) {
          this.options.onError(event.error)
        }
      }

      // Start recording with timeslice (chunkIntervalMs)
      this.mediaRecorder.start(this.options.chunkIntervalMs || 5000)
      this.isRecording = true
      this.notifyStatus()

      console.log(`[DualAudioMixer] Started dual audio recording with ${this.options.chunkIntervalMs}ms chunks (Mime: ${recordingMime})`)
      return true
    } catch (err: any) {
      this.cleanup()
      console.error("[DualAudioMixer] Failed to start:", err)
      if (this.options.onError) {
        this.options.onError(err)
      }
      return false
    }
  }

  public stop(): void {
    if (!this.isRecording) return
    this.cleanup()
    this.notifyStatus("Stopped")
    console.log("[DualAudioMixer] Stopped and cleaned up audio resources.")
  }

  private cleanup(): void {
    this.isRecording = false

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      try {
        this.mediaRecorder.stop()
      } catch (e) {
        console.warn("[DualAudioMixer] Error stopping recorder:", e)
      }
    }
    this.mediaRecorder = null

    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop())
      this.micStream = null
    }

    if (this.callStream) {
      this.callStream.getTracks().forEach(t => t.stop())
      this.callStream = null
    }

    if (this.mixedStream) {
      this.mixedStream.getTracks().forEach(t => t.stop())
      this.mixedStream = null
    }

    if (this.audioContext && this.audioContext.state !== "closed") {
      try {
        this.audioContext.close()
      } catch (e) {
        console.warn("[DualAudioMixer] Error closing AudioContext:", e)
      }
      this.audioContext = null
    }

    this.hasMic = false
    this.hasCallAudio = false
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const result = reader.result as string
        if (result && result.includes(",")) {
          resolve(result.split(",")[1])
        } else {
          resolve(result || "")
        }
      }
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }
}
