import { GoogleGenAI, Type, Schema } from "@google/genai";
import { IntentResult, IntentType, NavigationPlan, WalkingHazard } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const modelName = 'gemini-2.5-flash';

// Helper: Exponential Backoff Retry
const generateContentWithRetry = async (model: string, params: any, retryCount = 3): Promise<any> => {
    let delay = 1000;
    for (let i = 0; i < retryCount; i++) {
        try {
            return await ai.models.generateContent({ model, ...params });
        } catch (error: any) {
             // If it's not a recoverable error (like 400 Bad Request), throw immediately
             const isRecoverable = error.status === 429 || error.status === 503 || error.status === 500 || error.message?.includes('quota') || error.message?.includes('Overloaded');
             
             if (!isRecoverable || i === retryCount - 1) {
                 throw error;
             }
             
             console.warn(`Gemini API Error (${error.status || 'unknown'}). Retrying in ${delay}ms...`);
             await new Promise(resolve => setTimeout(resolve, delay));
             delay *= 2; // Exponential backoff
        }
    }
};

// Fallback Rule-Based Classifier for Offline/Rate-Limit Support
const simpleIntentParser = (text: string): IntentResult | null => {
    const t = text.toLowerCase();
    
    // Safety / Emergency
    if (t.includes('safe') || t.includes('danger') || t.includes('watch out')) return { type: IntentType.SAFETY_CHECK, confidence: 0.9, originalQuery: text };
    
    // Stop / Cancel commands
    if (t.includes('stop') || t.includes('cancel') || t.includes('quit') || t.includes('exit')) {
        if (t.includes('navigation') || t.includes('route')) return { type: IntentType.STOP_NAVIGATION, confidence: 1, originalQuery: text };
        if (t.includes('walking') || t.includes('mode')) return { type: IntentType.WALKING_MODE_OFF, confidence: 1, originalQuery: text };
        return { type: IntentType.STOP_NAVIGATION, confidence: 0.8, originalQuery: text }; // Generic stop
    }

    // Walking Mode
    if ((t.includes('start') || t.includes('begin')) && (t.includes('walking') || t.includes('mode'))) return { type: IntentType.WALKING_MODE_ON, confidence: 0.9, originalQuery: text };
    
    // Navigation
    if (t.includes('navigate') || t.includes('go to') || t.includes('take me')) return { type: IntentType.NAVIGATE, confidence: 0.9, originalQuery: text };
    
    // Location
    if (t.includes('where am i') || t.includes('location') || t.includes('address')) return { type: IntentType.WHERE_AM_I, confidence: 0.9, originalQuery: text };

    // Reading (Document Mode triggers)
    if (t.includes('read') || t.includes('what does this say') || t.includes('what does it say') || t.includes('text') || t.includes('document')) {
        return { type: IntentType.READ_TEXT, confidence: 0.9, originalQuery: text };
    }

    // Companion
    if (t.includes('companion') || (t.includes('friend') && t.includes('be my'))) {
        if (t.includes('off') || t.includes('stop')) return { type: IntentType.COMPANION_MODE_OFF, confidence: 0.9, originalQuery: text };
        return { type: IntentType.COMPANION_MODE_ON, confidence: 0.9, originalQuery: text };
    }

    return null;
};

// 1. Natural Language Understanding (NLU)
export const classifyIntent = async (transcript: string, signal?: AbortSignal): Promise<IntentResult> => {
  if (!transcript || transcript.trim().length === 0) {
    return { type: IntentType.UNKNOWN, confidence: 0, originalQuery: '' };
  }
  
  if (signal?.aborted) throw new Error("Aborted");

  const prompt = `
    Classify the user's voice command into one of these categories.

    1. COMPANION_INTENTS:
       - COMPANION_MODE_ON: "Start companion mode", "Stay with me", "Talk to me", "Be my friend".
       - COMPANION_MODE_OFF: "Stop companion mode", "Quiet mode", "Leave me alone".

    2. VISUAL_INTENTS (Requires Camera):
       - DESCRIBE: "What is this?", "Describe the scene".
       - READ_TEXT: "Read this", "Read the document", "Read the page", "What does this say?", "Read what's in front of me".
       - SAFETY_CHECK: "Is it safe?", "Check for cars".
       - WHERE_AM_I: "Where am I?", "What is my location?".

    3. NAVIGATION_INTENTS:
       - NAVIGATE: "Take me to [Place]", "Go to [Place]".
       - STOP_NAVIGATION: "Stop navigation", "Cancel route".

    4. CONTROL_INTENTS:
       - WALKING_MODE_ON: "Start walking mode".
       - WALKING_MODE_OFF: "Stop walking mode".

    User said: "${transcript}"
  `;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      intent: { type: Type.STRING, enum: Object.values(IntentType) },
      destination: { type: Type.STRING },
      detailLevel: { type: Type.STRING, enum: ['simple', 'detailed'] },
    },
    required: ['intent'],
  };

  try {
    const result = await generateContentWithRetry(modelName, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0.1, 
      }
    });

    if (signal?.aborted) throw new Error("Aborted");

    const json = JSON.parse(result.text || "{}");
    return {
      type: json.intent as IntentType,
      confidence: 1,
      originalQuery: transcript,
      detailLevel: json.detailLevel || 'simple',
      destination: json.destination
    };

  } catch (error) {
    if (signal?.aborted || (error as Error).message === "Aborted") {
        throw new Error("Aborted");
    }
    console.warn("NLU Error (Gemini):", error);
    
    // FALLBACK: Use local regex parser if API fails (Rate Limit / Offline)
    const fallback = simpleIntentParser(transcript);
    if (fallback) {
        console.log("Using Fallback Intent Parser for:", transcript);
        return fallback;
    }

    // Default safe fallback
    return { type: IntentType.DESCRIBE, confidence: 0.5, originalQuery: transcript }; 
  }
};

// 2. Vision Analysis (Q&A)
export const analyzeImage = async (base64Image: string, intent: IntentResult, location?: GeolocationCoordinates, signal?: AbortSignal): Promise<string> => {
  if (signal?.aborted) throw new Error("Aborted");

  let systemInstruction = "You are SightMate, a gentle and supportive anime-style assistant. Respond with 2-4 clear, informative sentences. Be warm and encouraging.";
  let promptText = "";
  let temperature = 0.5;

  const base64Data = base64Image.split(',')[1]; 

  switch (intent.type) {
    case IntentType.WHERE_AM_I:
      promptText = `Tell me exactly where I am in 2-3 sentences. (GPS: ${location ? `${location.latitude},${location.longitude}` : 'Unknown'})`;
      break;
    
    case IntentType.SAFETY_CHECK:
      promptText = `Scan for danger. Describe the path's safety in 2-3 sentences.`;
      break;
    
    case IntentType.READ_TEXT:
      // Special Document Reading Mode
      systemInstruction = "You are a precise Document Reading Assistant. Your task is to perform OCR and read text exactly as it appears. Do not summarize unless explicitly asked. Do not add descriptions of the image.";
      temperature = 0.1; // Low temp for accuracy
      promptText = `
        Read the text in this image.
        
        Rules:
        1. If the text is hard to see (blur, low light, cut off), return EXACTLY: "I’m having trouble reading this. Please adjust the camera a little."
        2. If there is NO visible text, return EXACTLY: "I don’t see any readable text here."
        3. If text IS found, return ONLY the text content. Read it in natural order (top to bottom).
        4. Do NOT say "The text says". Just output the text.
      `;
      break;
      
    case IntentType.DESCRIBE:
    default:
      promptText = `Describe the scene in 3-4 warm, informative sentences. User asked: "${intent.originalQuery}"`;
      break;
  }

  const config: any = {
    systemInstruction: systemInstruction,
    temperature: temperature,
  };

  // Add Maps Tool for Location if needed
  if (intent.type === IntentType.WHERE_AM_I && location) {
       config.tools = [{googleMaps: {}}];
       config.toolConfig = { retrievalConfig: { latLng: { latitude: location.latitude, longitude: location.longitude } } };
  }

  try {
    const response = await generateContentWithRetry(modelName, {
      contents: {
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
          { text: promptText }
        ]
      },
      config: config
    });

    if (signal?.aborted) throw new Error("Aborted");
    return response.text || "I couldn't see clearly.";

  } catch (error) {
    if (signal?.aborted || (error as Error).message === "Aborted") throw error;
    // If quota exceeded, give a specific message
    if ((error as any).status === 429) return "I'm a bit overwhelmed right now. Please try again in a moment.";
    return "Connection error.";
  }
};

// 3. Walking Safety - Ultra Fast & Comprehensive
export const analyzeWalkingSafety = async (base64Image: string, signal?: AbortSignal): Promise<WalkingHazard | null> => {
    if (signal?.aborted) return null;
    const base64Data = base64Image.split(',')[1];
    
    // Condensed prompt for speed
    const prompt = `
      DETECT DANGER. FAST.
      Categories:
      - ground: holes, cracks, wet, steps, drop-offs, uneven.
      - obstacle: poles, walls, low headroom.
      - moving: cars, bikes, runners.
      - structural: glass, doors, debris.
      - animal: dogs, cattle.
      - personal: approaching person.
      - fall: camera on ground, sky only, sideways horizon, floor closeup.

      Output JSON for the SINGLE HIGHEST RISK.
      Priority: FALL > HIGH severity > NEAR distance > MOVING.
      If confidence < 0.35 or no danger, hazard_type="none".
      "message": MAX 3-5 words. Direct command.
    `;

    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        hazard_type: { type: Type.STRING },
        category: { type: Type.STRING, enum: ['ground', 'level_change', 'obstacle', 'moving', 'structural', 'environmental', 'animal', 'personal', 'fall', 'none'] },
        description: { type: Type.STRING },
        direction: { type: Type.STRING, enum: ["left", "center", "right", "unknown"] },
        distance: { type: Type.STRING, enum: ["near", "medium", "far", "unknown"] },
        severity: { type: Type.STRING, enum: ["high", "medium", "low"] },
        confidence: { type: Type.NUMBER },
        message: { type: Type.STRING }
      },
      required: ["hazard_type", "category", "description", "direction", "distance", "severity", "confidence", "message"]
    };

    try {
        // NO RETRIES for walking loop. Fail fast.
        // maxOutputTokens=200 is enough for this JSON, prevents long gen/truncation.
        const response = await ai.models.generateContent({
            model: modelName,
            contents: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: base64Data } }, { text: prompt }] },
            config: { 
                temperature: 0.1, 
                responseMimeType: "application/json", 
                responseSchema: schema, 
                maxOutputTokens: 200 
            }
        });

        if (signal?.aborted) return null;
        
        // ROBUST JSON PARSING (Extract JSON substring)
        const rawText = response.text || "{}";
        console.log("WalkingMode: Raw JSON:", rawText);

        try {
            // Find valid JSON object bounds
            const jsonStart = rawText.indexOf('{');
            const jsonEnd = rawText.lastIndexOf('}');
            
            if (jsonStart !== -1 && jsonEnd !== -1) {
                const jsonStr = rawText.substring(jsonStart, jsonEnd + 1);
                const result = JSON.parse(jsonStr) as WalkingHazard;
                console.log("WalkingMode: JSON parsed", result);
                return result;
            }
            // Fallback if structured mode fails completely (rare)
            return null;
        } catch (parseError) {
            console.warn("WalkingMode: JSON Parse Failed:", parseError);
            return null;
        }
    } catch (e) { 
        console.warn("WalkingMode: Analysis Error (Skipping Frame):", e);
        return null; 
    }
}

// 4. Navigation
export const getWalkingDirections = async (destination: string, currentCoords: GeolocationCoordinates | null, signal?: AbortSignal): Promise<NavigationPlan | null> => {
    if (signal?.aborted) return null;
    const locationStr = currentCoords ? `${currentCoords.latitude}, ${currentCoords.longitude}` : "my location";
    
    const prompt = `Navigate from ${locationStr} to ${destination}. JSON: { "destination": "", "steps": [""], "totalDistance": "", "totalTime": "" }`;
    const schema: Schema = {
        type: Type.OBJECT,
        properties: {
            destination: { type: Type.STRING },
            steps: { type: Type.ARRAY, items: { type: Type.STRING } },
            totalDistance: { type: Type.STRING },
            totalTime: { type: Type.STRING }
        },
        required: ["steps", "destination"]
    };

    try {
        const response = await generateContentWithRetry(modelName, {
            contents: prompt,
            config: { responseMimeType: "application/json", responseSchema: schema }
        });
        if (signal?.aborted) return null;
        return JSON.parse(response.text || "{}") as NavigationPlan;
    } catch (e) { return null; }
}

// 5. Companion Message Generation
export const getCompanionMessage = async (context: string = "general", signal?: AbortSignal): Promise<string> => {
    // Legacy function - we now use local phrases in App.tsx for zero latency.
    return "I'm with you.";
}