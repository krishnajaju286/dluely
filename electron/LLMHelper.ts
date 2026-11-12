import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai"
import fs from "fs"

interface OllamaResponse {
  response: string
  done: boolean
}

export class LLMHelper {
  private model: GenerativeModel | null = null
  private geminiApiKey: string | null = null
  private readonly systemPrompt = `You are Dluely, an ultra-fast, intelligent copilot and direct problem-solving assistant.
YOUR ABSOLUTE DIRECTIVE: SOLVE, DO NOT DESCRIBE.
- NEVER describe the screenshot, image layout, UI buttons, screen contents, or say "In this image...", "This screenshot shows...", "Here is a LeetCode problem...".
- DIRECTLY SOLVE the question, coding problem, multiple-choice question, or situation on the screen immediately.
- If it is a coding / algorithmic problem: Provide the optimal, clean code solution immediately, followed by time/space complexity and 2-3 bullet points of explanation.
- If it is a multiple-choice question: State the correct option letter and answer immediately, followed by a concise 1-sentence explanation.
- If it is a math, logic, or technical question: Output the direct solution, step-by-step formula or calculation, and final result highlighted.
- If it is an interview / professional / conversational question: Provide the exact, high-impact answer or talking points to say.
Always prioritize providing the direct, executable, and actionable solution as fast and clearly as possible.`

  private useOllama: boolean = false
  private ollamaModel: string = "llama3.2"
  private ollamaUrl: string = "http://localhost:11434"

  // Ordered fallback models: fastest and most compatible first
  private readonly geminiModelQueue: string[] = [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-1.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-2.0-flash-exp",
    "gemini-2.0-pro-exp-02-05",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite"
  ]

  // Track winning model: if a model works, subsequent questions start with this model
  private currentWinningModel: string = "gemini-2.0-flash"
  private quotaLimitedModels = new Set<string>()
  private quotaResetDate = new Date().toDateString()

  constructor(apiKey?: string, useOllama: boolean = false, ollamaModel?: string, ollamaUrl?: string) {
    this.useOllama = useOllama
    
    if (useOllama) {
      this.ollamaUrl = ollamaUrl || "http://localhost:11434"
      this.ollamaModel = ollamaModel || "llama3.2"
      console.log(`[LLMHelper] Using Ollama with model: ${this.ollamaModel}`)
      this.initializeOllamaModel()
    } else if (apiKey) {
      this.geminiApiKey = apiKey
      this.currentWinningModel = "gemini-2.0-flash"
      const genAI = new GoogleGenerativeAI(apiKey)
      this.model = genAI.getGenerativeModel({ model: this.currentWinningModel })
      console.log("[LLMHelper] Using Google Gemini, initial model:", this.currentWinningModel)
    } else {
      console.warn("[LLMHelper] Warning: No GEMINI_API_KEY provided in .env and Ollama not enabled. App will launch in setup mode.")
    }
  }

  private async fileToGenerativePart(imagePath: string) {
    const imageData = await fs.promises.readFile(imagePath)
    return {
      inlineData: {
        data: imageData.toString("base64"),
        mimeType: "image/png"
      }
    }
  }

  private cleanJsonResponse(text: string): string {
    text = text.trim()
    if (text.startsWith("```json")) {
      text = text.slice(7)
    } else if (text.startsWith("```")) {
      text = text.slice(3)
    }
    if (text.endsWith("```")) {
      text = text.slice(0, -3)
    }
    text = text.trim()

    // Isolate JSON object between outermost braces
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1)
    }
    return text.trim()
  }

  private async callOllama(prompt: string, imagesBase64?: string[]): Promise<string> {
    try {
      const body: any = {
        model: this.ollamaModel,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
        }
      }
      if (imagesBase64 && imagesBase64.length > 0) {
        body.images = imagesBase64
      }

      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
      }

      const data: OllamaResponse = await response.json()
      return data.response
    } catch (error: any) {
      console.error("[LLMHelper] Error calling Ollama:", error)
      throw new Error(`Failed to connect to Ollama: ${error.message}. Make sure Ollama is running on ${this.ollamaUrl}`)
    }
  }

  private async checkOllamaAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`)
      return response.ok
    } catch {
      return false
    }
  }

  private async initializeOllamaModel(): Promise<void> {
    try {
      const availableModels = await this.getOllamaModels()
      if (availableModels.length === 0) {
        console.warn("[LLMHelper] No Ollama models found")
        return
      }

      if (!availableModels.includes(this.ollamaModel)) {
        this.ollamaModel = availableModels[0]
        console.log(`[LLMHelper] Auto-selected first available Ollama model: ${this.ollamaModel}`)
      }
    } catch (error: any) {
      console.error(`[LLMHelper] Failed to initialize Ollama model: ${error?.message}`)
    }
  }

  private resetGeminiQuotaStateIfNeeded(): void {
    const today = new Date().toDateString()
    if (today !== this.quotaResetDate) {
      console.log("[LLMHelper] New day detected - resetting Gemini model quota limitations")
      this.quotaLimitedModels.clear()
      this.quotaResetDate = today
    }
  }

  private isQuotaError(error: any): boolean {
    const message = String(error?.message || error).toLowerCase()
    return (
      message.includes("429") ||
      message.includes("resource_exhausted") ||
      message.includes("resource exhausted") ||
      message.includes("quota exceeded") ||
      message.includes("quota has been exceeded") ||
      message.includes("daily limit") ||
      message.includes("rate limit") ||
      message.includes("too many requests") ||
      message.includes("out of tokens") ||
      message.includes("token limit")
    )
  }

  private isTemporaryGeminiError(error: any): boolean {
    const message = String(error?.message || error).toLowerCase()
    return (
      message.includes("503") ||
      message.includes("service unavailable") ||
      message.includes("high demand") ||
      message.includes("overloaded") ||
      message.includes("500") ||
      message.includes("internal server error") ||
      message.includes("502") ||
      message.includes("bad gateway") ||
      message.includes("504") ||
      message.includes("gateway timeout")
    )
  }

  /**
   * Returns models in priority order, starting with the last successful (winning) model,
   * rotating through the queue, skipping models currently marked as quota-exhausted.
   */
  private getOrderedGeminiModels(): string[] {
    this.resetGeminiQuotaStateIfNeeded()

    const activeModels = this.geminiModelQueue.filter(
      m => !this.quotaLimitedModels.has(m)
    )

    if (activeModels.length === 0) {
      console.warn("[LLMHelper] All models were quota-flagged; resetting quota cache")
      this.quotaLimitedModels.clear()
      return [...this.geminiModelQueue]
    }

    // Start with currentWinningModel and wrap around
    if (this.currentWinningModel && activeModels.includes(this.currentWinningModel)) {
      const winIdx = activeModels.indexOf(this.currentWinningModel)
      return [
        ...activeModels.slice(winIdx),
        ...activeModels.slice(0, winIdx)
      ]
    }

    return activeModels
  }

  /**
   * Generates content with strict 10-second timeout.
   */
  private async generateWithTimeout(
    modelName: string,
    content: any,
    timeoutMs: number = 10000
  ): Promise<string> {
    if (!this.geminiApiKey) {
      throw new Error("Gemini API key is not available")
    }

    const genAI = new GoogleGenerativeAI(this.geminiApiKey)
    const model = genAI.getGenerativeModel({ model: modelName })

    const request = (async () => {
      const result = await model.generateContent(content)
      const response = await result.response
      return response.text()
    })()

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`MODEL_TIMEOUT:${modelName}`)),
        timeoutMs
      )
    })

    return Promise.race([request, timeout])
  }

  /**
   * Smart sequential fallback router:
   * - Starts with current winning model
   * - Switches immediately if model takes > 10s, returns 429, or 503
   * - On success, updates winning model so next question starts with it
   */
  private async generateWithGeminiFallback(content: any): Promise<string> {
    if (!this.geminiApiKey) {
      throw new Error("Gemini API key is not configured. Please set GEMINI_API_KEY in your .env file or switch to Ollama.")
    }

    const models = this.getOrderedGeminiModels()
    let lastError: any = null

    console.log(`[LLMHelper] Model router sequence: ${models.slice(0, 4).join(" -> ")} ...`)

    for (const modelName of models) {
      try {
        console.log(`[LLMHelper] Trying model: ${modelName} (10s max limit)`)
        const text = await this.generateWithTimeout(modelName, content, 10000)

        if (text && text.trim().length > 0) {
          // Success! Keep this model as the starting model for subsequent questions
          if (this.currentWinningModel !== modelName) {
            console.log(`[LLMHelper] Model ${modelName} gave smooth output -> set as primary for next question`)
            this.currentWinningModel = modelName
          }
          return text
        }
      } catch (error: any) {
        lastError = error
        const errorText = String(error?.message || error)

        if (errorText.includes("MODEL_TIMEOUT:")) {
          console.warn(`[LLMHelper] ${modelName} exceeded 10s limit -> switching to next model`)
          continue
        }

        if (this.isQuotaError(error)) {
          console.warn(`[LLMHelper] ${modelName} quota/rate limit reached -> disabled for today, switching to next model`)
          this.quotaLimitedModels.add(modelName)
          continue
        }

        if (this.isTemporaryGeminiError(error)) {
          console.warn(`[LLMHelper] ${modelName} temporary error (${errorText}) -> switching to next model`)
          continue
        }

        console.warn(`[LLMHelper] ${modelName} failed (${errorText}) -> switching to next model`)
      }
    }

    throw new Error(
      `All Gemini models failed or timed out. Last error: ${lastError?.message || lastError || "Unknown error"}`
    )
  }

  public async extractProblemFromImages(imagePaths: string[]) {
    try {
      const prompt = `${this.systemPrompt}

Analyze the provided screenshot(s) and directly extract the problem and its immediate solution intuition.
Do NOT describe the image visuals.
Return strictly in this JSON format:
{
  "problem_statement": "Concise statement of the exact question or problem to be solved.",
  "context": "Key constraints, inputs, or critical context.",
  "suggested_responses": ["Direct answer / key intuition point 1", "Direct answer / key intuition point 2"],
  "reasoning": "Direct concise explanation of how to solve it."
}
Return ONLY the raw JSON object, without markdown formatting or code blocks.`

      let rawText: string
      if (this.useOllama) {
        const imagesBase64 = await Promise.all(
          imagePaths.map(async (path) => {
            const data = await fs.promises.readFile(path)
            return data.toString("base64")
          })
        )
        rawText = await this.callOllama(prompt, imagesBase64)
      } else {
        const imageParts = await Promise.all(imagePaths.map(path => this.fileToGenerativePart(path)))
        rawText = await this.generateWithGeminiFallback([prompt, ...imageParts])
      }

      const text = this.cleanJsonResponse(rawText)
      return JSON.parse(text)
    } catch (error) {
      console.error("[LLMHelper] Error extracting problem from images:", error)
      throw error
    }
  }

  public async generateSolution(problemInfo: any) {
    const prompt = `${this.systemPrompt}

Given this problem or situation:
${JSON.stringify(problemInfo, null, 2)}

Directly solve it. Return strictly in this JSON format:
{
  "solution": {
    "code": "The complete, optimal solution code, direct answer, or exact response here.",
    "problem_statement": "The exact question or problem.",
    "context": "Key constraints and inputs.",
    "thoughts": ["Solution step 1", "Solution step 2", "Key insight"],
    "suggested_responses": ["Actionable takeaway or talking point 1", "Actionable takeaway 2"],
    "time_complexity": "Time complexity if applicable (e.g. O(n)) or N/A",
    "space_complexity": "Space complexity if applicable (e.g. O(1)) or N/A",
    "reasoning": "Concise justification of the solution approach."
  }
}
Return ONLY the valid JSON object, without any markdown formatting or code blocks.`

    console.log("[LLMHelper] Generating direct solution...")
    try {
      let rawText: string
      if (this.useOllama) {
        rawText = await this.callOllama(prompt)
      } else {
        rawText = await this.generateWithGeminiFallback(prompt)
      }
      const text = this.cleanJsonResponse(rawText)
      const parsed = JSON.parse(text)
      return parsed
    } catch (error) {
      console.error("[LLMHelper] Error in generateSolution:", error)
      throw error
    }
  }

  public async debugSolutionWithImages(problemInfo: any, currentCode: string, debugImagePaths: string[]) {
    try {
      const prompt = `${this.systemPrompt}

Given:
1. The original problem: ${JSON.stringify(problemInfo, null, 2)}
2. The current solution: ${currentCode}
3. The error/debug screenshots

Diagnose the bug or error and provide the corrected solution in this JSON format:
{
  "solution": {
    "code": "The corrected code or revised answer.",
    "problem_statement": "Restatement of the problem.",
    "context": "Explanation of the error identified.",
    "thoughts": ["Root cause of error", "How the fix addresses it"],
    "suggested_responses": ["Key fix 1", "Key fix 2"],
    "time_complexity": "Updated time complexity or N/A",
    "space_complexity": "Updated space complexity or N/A",
    "reasoning": "Why this correction works."
  }
}
Return ONLY the valid JSON object, without markdown formatting or code blocks.`

      let rawText: string
      if (this.useOllama) {
        const imagesBase64 = await Promise.all(
          debugImagePaths.map(async (path) => {
            const data = await fs.promises.readFile(path)
            return data.toString("base64")
          })
        )
        rawText = await this.callOllama(prompt, imagesBase64)
      } else {
        const imageParts = await Promise.all(debugImagePaths.map(path => this.fileToGenerativePart(path)))
        rawText = await this.generateWithGeminiFallback([prompt, ...imageParts])
      }

      const text = this.cleanJsonResponse(rawText)
      const parsed = JSON.parse(text)
      return parsed
    } catch (error) {
      console.error("[LLMHelper] Error debugging solution with images:", error)
      throw error
    }
  }

  public async analyzeImageFile(imagePath: string) {
    try {
      const prompt = `${this.systemPrompt}

Look at this screenshot and DIRECTLY SOLVE the question or task shown.
Do NOT describe what the screen or image looks like. Go straight to solving it:
1. **Direct Answer / Solution**: (Code, final answer, or exact talking points)
2. **Key Steps / Reasoning**: (Concise, high-impact explanation)
3. **Complexity / Next Actions**: (If applicable)`

      let text: string
      if (this.useOllama) {
        const data = await fs.promises.readFile(imagePath)
        text = await this.callOllama(prompt, [data.toString("base64")])
      } else {
        const imagePart = await this.fileToGenerativePart(imagePath)
        text = await this.generateWithGeminiFallback([prompt, imagePart])
      }
      return { text, timestamp: Date.now() }
    } catch (error) {
      console.error("[LLMHelper] Error analyzing/solving image file:", error)
      throw error
    }
  }

  public async analyzeAudioFile(audioPath: string) {
    try {
      if (this.useOllama) {
        throw new Error("Audio analysis requires Google Gemini API (Ollama local audio is not supported).")
      }
      const audioData = await fs.promises.readFile(audioPath)
      const audioPart = {
        inlineData: {
          data: audioData.toString("base64"),
          mimeType: "audio/mp3"
        }
      }
      const prompt = `${this.systemPrompt}\n\nListen to this audio and DIRECTLY SOLVE or answer what was asked or discussed. Give the direct response and action items concisely.`
      const text = await this.generateWithGeminiFallback([prompt, audioPart])
      return { text, timestamp: Date.now() }
    } catch (error) {
      console.error("[LLMHelper] Error analyzing audio file:", error)
      throw error
    }
  }

  public async analyzeAudioFromBase64(data: string, mimeType: string) {
    try {
      if (this.useOllama) {
        throw new Error("Audio analysis requires Google Gemini API (Ollama local audio is not supported).")
      }
      const audioPart = {
        inlineData: {
          data,
          mimeType
        }
      }
      const prompt = `${this.systemPrompt}\n\nListen to this audio and DIRECTLY SOLVE or answer what was asked or discussed. Give the direct response and action items concisely.`
      const text = await this.generateWithGeminiFallback([prompt, audioPart])
      return { text, timestamp: Date.now() }
    } catch (error) {
      console.error("[LLMHelper] Error analyzing audio from base64:", error)
      throw error
    }
  }

  public async processLiveMeetingAudio(
    data: string,
    mimeType: string,
    previousContext: string = ""
  ): Promise<{
    transcript: string
    has_detection: boolean
    detection_type: "question" | "term" | "none"
    detected_text: string
    direct_answer: string
    key_points: string[]
  }> {
    try {
      if (this.useOllama) {
        throw new Error("Live audio transcription requires Google Gemini API (Ollama local audio is not supported).")
      }

      const audioPart = {
        inlineData: {
          data,
          mimeType: mimeType || "audio/webm"
        }
      }

      const prompt = `You are Dluely's Real-Time Interview Copilot listening to a live call/interview audio snippet.
Previous recent dialogue context: "${previousContext.slice(-300)}"

TASK:
1. Accurately transcribe what is being spoken in this audio snippet.
2. Determine if the speaker asked an INTERVIEW QUESTION, technical question, or introduced an UNFAMILIAR/SPECIALIZED TECHNICAL TERM or concept that needs explanation.
   - Ignore general small talk, acknowledgements, greetings, filler words, or statement of facts.
   - Trigger has_detection ONLY if a question was asked or a specific technical term needs clarification.
3. If has_detection is true:
   - Provide a DIRECT, CRISP ANSWER designed specifically to be SPOKEN ALOUD to the interviewer in SECONDS.
   - Format with 2-3 high-impact, natural bullet points.
   - No conversational filler (do NOT say "Here is the answer:"). Start directly with the answer points.

Return STRICTLY in this JSON format:
{
  "transcript": "Verbatim text of what was spoken (or empty string if silence)",
  "has_detection": true,
  "detection_type": "question" or "term" or "none",
  "detected_text": "Exact question asked or term mentioned",
  "direct_answer": "Direct spoken answer in 2-3 crisp bullet points",
  "key_points": ["Point 1 to say", "Point 2 to say"]
}
Return ONLY the raw JSON object, without markdown code fences or introductory text.`

      const rawText = await this.generateWithGeminiFallback([prompt, audioPart])
      const cleaned = this.cleanJsonResponse(rawText)
      const parsed = JSON.parse(cleaned)

      return {
        transcript: parsed.transcript || "",
        has_detection: Boolean(parsed.has_detection),
        detection_type: parsed.detection_type || (parsed.has_detection ? "question" : "none"),
        detected_text: parsed.detected_text || "",
        direct_answer: parsed.direct_answer || "",
        key_points: Array.isArray(parsed.key_points) ? parsed.key_points : []
      }
    } catch (error: any) {
      console.error("[LLMHelper] Error in processLiveMeetingAudio:", error)
      return {
        transcript: "",
        has_detection: false,
        detection_type: "none",
        detected_text: "",
        direct_answer: "",
        key_points: []
      }
    }
  }

  public async generateMeetingMinutes(
    meetingTitle: string,
    fullTranscript: string,
    detectedCards: any[]
  ): Promise<string> {
    const prompt = `You are an expert technical secretary and interview coach.
Generate formal, highly organized Minutes of the Meeting (MoM) in clean Markdown based on this session:

Meeting Title: ${meetingTitle}
Date: ${new Date().toLocaleDateString()}
Duration / Time: ${new Date().toLocaleTimeString()}

DETECTED QUESTIONS & COPILOT ANSWERS DURING SESSION:
${JSON.stringify(detectedCards, null, 2)}

FULL SESSION TRANSCRIPT:
${fullTranscript}

Format the document professionally using GitHub-flavored Markdown:
# Minutes of the Meeting: ${meetingTitle}
**Date:** ${new Date().toLocaleDateString()} | **Recorded By:** Dluely AI Copilot

## 1. Executive Summary
(Crisp summary of the discussion, interview flow, and key highlights)

## 2. Key Topics & Technical Themes
(Bulleted overview of the subjects discussed)

## 3. Interview Questions Asked & Key Answers Given
(List each question that was asked, followed by the answer points delivered)

## 4. Key Terminology & Concepts Clarified
(Any technical terms, architecture patterns, or acronyms covered)

## 5. Decisions, Commitments & Next Action Items
(Clear, actionable takeaways)

---

## 6. Complete Chronological Transcript Log
${fullTranscript}
`

    try {
      if (this.useOllama) {
        return await this.callOllama(prompt)
      }
      return await this.generateWithGeminiFallback(prompt)
    } catch (error) {
      console.error("[LLMHelper] Error generating meeting minutes:", error)
      throw error
    }
  }

  public async chatWithGemini(message: string): Promise<string> {
    if (this.useOllama) {
      return this.callOllama(message)
    }
    return this.generateWithGeminiFallback(message)
  }

  public async chat(message: string): Promise<string> {
    return this.chatWithGemini(message)
  }

  public isUsingOllama(): boolean {
    return this.useOllama
  }

  public async getOllamaModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`)
      if (!response.ok) return []
      const data = await response.json()
      return data.models?.map((model: any) => model.name) || []
    } catch (error) {
      console.error("[LLMHelper] Error fetching Ollama models:", error)
      return []
    }
  }

  public getCurrentProvider(): "ollama" | "gemini" {
    return this.useOllama ? "ollama" : "gemini"
  }

  public getCurrentModel(): string {
    return this.useOllama ? this.ollamaModel : this.currentWinningModel
  }

  public async switchToOllama(model?: string, url?: string): Promise<void> {
    this.useOllama = true
    if (url) this.ollamaUrl = url
    
    if (model) {
      this.ollamaModel = model
    } else {
      await this.initializeOllamaModel()
    }
    
    console.log(`[LLMHelper] Switched to Ollama: ${this.ollamaModel} at ${this.ollamaUrl}`)
  }

  public async switchToGemini(apiKey?: string, model?: string): Promise<void> {
    if (apiKey) {
      this.geminiApiKey = apiKey
    }
    if (!this.geminiApiKey) {
      throw new Error("No Gemini API key provided and no existing API key available")
    }

    if (model) {
      this.currentWinningModel = model
    }
    const genAI = new GoogleGenerativeAI(this.geminiApiKey)
    this.model = genAI.getGenerativeModel({ model: this.currentWinningModel })
    this.useOllama = false
    console.log(`[LLMHelper] Switched to Gemini: ${this.currentWinningModel}`)
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.useOllama) {
        const available = await this.checkOllamaAvailable()
        if (!available) {
          return { success: false, error: `Ollama not available at ${this.ollamaUrl}` }
        }
        await this.callOllama("Hello")
        return { success: true }
      } else {
        if (!this.geminiApiKey) {
          return { success: false, error: "No Gemini API key configured" }
        }
        const text = await this.generateWithGeminiFallback("Respond with 'OK' if you can read this.")
        if (text) {
          return { success: true }
        } else {
          return { success: false, error: "Empty response from Gemini" }
        }
      }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  }
}
