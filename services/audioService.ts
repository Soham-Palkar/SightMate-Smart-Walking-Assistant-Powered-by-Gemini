import { EmergencySeverity } from "../types";

// AudioService handles Speech Recognition, Synthesis, and Sound Effects
export class AudioService {
  private synthesis: SpeechSynthesis;
  private recognition: any;
  private backgroundRecognition: any;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private microphone: MediaStreamAudioSourceNode | null = null;
  
  // Visualizer
  private visualizerStream: MediaStream | null = null;
  private visualizerSource: MediaStreamAudioSourceNode | null = null;
  private visualizerAnalyser: AnalyserNode | null = null;
  private visualizerDataArray: Uint8Array | null = null;

  // STT State
  private isListening: boolean = false;
  private isMonitoring: boolean = false;
  private intentionalStop: boolean = false; 
  private silenceTimer: any = null;
  private maxDurationTimer: any = null;
  private resolveRecording: ((text: string) => void) | null = null;
  
  // Transcripts
  private fullTranscript: string = "";
  private sessionTranscript: string = "";

  private voices: SpeechSynthesisVoice[] = [];
  public isSpeaking: boolean = false;
  private currentUtterance: SpeechSynthesisUtterance | null = null;

  // Distress Callback
  private onDistressCallback: ((type: string, severity: EmergencySeverity) => void) | null = null;
  private noiseCheckInterval: any = null;

  constructor() {
    this.synthesis = window.speechSynthesis;
    
    // Pre-load voices
    if (typeof window !== 'undefined') {
        this.synthesis.onvoiceschanged = () => {
            this.voices = this.synthesis.getVoices();
        };
        this.voices = this.synthesis.getVoices();
    }
    
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      // Background Recognition (Distress Keywords)
      this.backgroundRecognition = new SpeechRecognition();
      this.backgroundRecognition.continuous = true;
      this.backgroundRecognition.interimResults = true;
      this.backgroundRecognition.lang = 'en-US';
      this.backgroundRecognition.maxAlternatives = 1;

      this.setupBackgroundRecognition();
    }

    this.initAudioContext();
  }

  private initAudioContext() {
    if (!this.audioContext && typeof window !== 'undefined') {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
  }

  // --- Visualizer (Amplitude & Frequency) ---

  async startVisualizer() {
      if (!this.audioContext) this.initAudioContext();
      if (!this.audioContext) return;
      
      if (this.audioContext.state === 'suspended') {
          try { await this.audioContext.resume(); } catch(e) {}
      }

      // Avoid re-initializing if already active
      if (this.visualizerStream && this.visualizerStream.active) return;

      try {
          this.visualizerStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          this.visualizerAnalyser = this.audioContext.createAnalyser();
          this.visualizerAnalyser.fftSize = 256; // 128 bins for better resolution
          this.visualizerAnalyser.smoothingTimeConstant = 0.5;

          this.visualizerSource = this.audioContext.createMediaStreamSource(this.visualizerStream);
          this.visualizerSource.connect(this.visualizerAnalyser);
          
          this.visualizerDataArray = new Uint8Array(this.visualizerAnalyser.frequencyBinCount);
      } catch (e) {
          console.warn("Visualizer failed to start (likely permission or device conflict):", e);
      }
  }

  stopVisualizer() {
      if (this.visualizerStream) {
          this.visualizerStream.getTracks().forEach(track => track.stop());
          this.visualizerStream = null;
      }
      if (this.visualizerSource) {
          this.visualizerSource.disconnect();
          this.visualizerSource = null;
      }
      this.visualizerAnalyser = null;
  }

  getAmplitude(): number {
      if (!this.visualizerAnalyser || !this.visualizerDataArray) return 0;
      
      this.visualizerAnalyser.getByteFrequencyData(this.visualizerDataArray);
      
      // Calculate average volume level
      let sum = 0;
      const length = this.visualizerDataArray.length;
      for (let i = 0; i < length; i++) {
          sum += this.visualizerDataArray[i];
      }
      
      const average = sum / length; 
      // Normalize 0-255 to 0.0-1.0
      return Math.min(Math.max(average / 128.0, 0), 1.0); 
  }

  // --- Background Monitoring (Distress) ---

  private setupBackgroundRecognition() {
      if (!this.backgroundRecognition) return;

      this.backgroundRecognition.onresult = (event: any) => {
          if (!this.isMonitoring || this.isListening) return;
          
          const results = event.results;
          const lastResult = results[results.length - 1];
          const transcript = lastResult[0].transcript.toLowerCase().trim();

          // High Severity Keywords
          if (transcript.includes('help') || 
              transcript.includes('emergency') || 
              transcript.includes('call 911') ||
              transcript.includes('scream') || // Metaphorical, but sometimes STT picks up sounds
              transcript.includes('no no no')) {
              
              if (this.onDistressCallback) this.onDistressCallback('keyword_high', 'high');
              return;
          }

          // Medium Severity Keywords
          if (transcript.includes('ouch') || 
              transcript.includes('hurt') || 
              transcript.includes('pain') ||
              transcript.includes('fell') ||
              transcript.includes('falling') ||
              transcript.includes('stop it')) {
              
              if (this.onDistressCallback) this.onDistressCallback('keyword_med', 'medium');
          }
      };

      this.backgroundRecognition.onerror = (e: any) => {};
      
      this.backgroundRecognition.onend = () => {
          if (this.isMonitoring && !this.isListening) {
              try {
                  this.backgroundRecognition.start();
              } catch (e) {
                  setTimeout(() => {
                      if (this.isMonitoring && !this.isListening) try { this.backgroundRecognition.start(); } catch(e){}
                  }, 1000);
              }
          }
      };
  }

  // Monitor Amplitude for loud noises (Thuds, Screams, Crashes)
  private startNoiseListener() {
      if (this.noiseCheckInterval) clearInterval(this.noiseCheckInterval);
      
      // We need visualizer active for this
      this.startVisualizer();

      this.noiseCheckInterval = setInterval(() => {
          if (this.isSpeaking || this.isListening) return; // Don't trigger on self or during STT
          
          const amp = this.getAmplitude();
          
          // Thresholds
          // 0.8 is very loud (near clipping). 0.6 is loud speech.
          if (amp > 0.85) {
               console.log("LOUD NOISE DETECTED:", amp);
               if (this.onDistressCallback) this.onDistressCallback('loud_noise', 'medium');
               // Debounce
               clearInterval(this.noiseCheckInterval);
               setTimeout(() => this.startNoiseListener(), 5000); 
          }
      }, 200);
  }

  async startDistressListener(callback: (type: string, severity: EmergencySeverity) => void) {
      this.onDistressCallback = callback;
      this.isMonitoring = true;

      // Start Keyword Listener
      if (!this.isListening) {
          try { this.backgroundRecognition.start(); } catch (e) { }
      }

      // Start Noise/Amplitude Listener
      this.startNoiseListener();

      if (!this.audioContext) this.initAudioContext();
      if (this.audioContext && this.audioContext.state === 'suspended') {
          this.audioContext.resume().catch(() => {});
      }
  }

  stopDistressListener() {
      this.isMonitoring = false;
      if (this.noiseCheckInterval) clearInterval(this.noiseCheckInterval);
      try { this.backgroundRecognition.stop(); } catch (e) {}
  }

  // --- Sound Generation ---

  private playTone(freq: number, startTime: number, duration: number, vol: number = 0.1) {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    
    osc.type = 'sine'; 
    osc.frequency.setValueAtTime(freq, startTime);
    osc.connect(gain);
    gain.connect(this.audioContext.destination);

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(vol, startTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(vol * 0.1, startTime + duration);
    gain.gain.linearRampToValueAtTime(0, startTime + duration + 0.1);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.15);
  }

  async playSound(type: 'start' | 'end' | 'success' | 'error' | 'warning' | 'navigation') {
    if (!this.audioContext) this.initAudioContext();
    if (!this.audioContext) return;

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    const now = this.audioContext.currentTime;

    switch (type) {
      case 'start': 
        this.playTone(523.25, now, 0.4, 0.15); 
        this.playTone(659.25, now + 0.15, 0.8, 0.1); 
        break;
      case 'end': 
        this.playTone(659.25, now, 0.15, 0.1); 
        this.playTone(523.25, now + 0.15, 0.3, 0.1); 
        break;
      case 'success': 
        this.playTone(523.25, now, 0.2, 0.1); 
        this.playTone(659.25, now + 0.1, 0.2, 0.1); 
        this.playTone(783.99, now + 0.2, 0.4, 0.1); 
        break;
      case 'error': 
        this.playTone(220, now, 0.4, 0.15); 
        this.playTone(196, now + 0.3, 0.5, 0.15); 
        break;
      case 'warning': 
        this.playTone(880, now, 0.1, 0.05);
        this.playTone(880, now + 0.15, 0.1, 0.05);
        break;
      case 'navigation': 
        this.playTone(1046.5, now, 0.8, 0.08); 
        break;
    }
  }

  // --- TTS ---

  getPreferredVoice(): SpeechSynthesisVoice | null {
    if (this.voices.length === 0) {
        this.voices = this.synthesis.getVoices();
    }
    
    const preferredNames = ['Google US English', 'Samantha', 'Microsoft Zira', 'Karen', 'Victoria'];
    for (const name of preferredNames) {
        const found = this.voices.find(v => v.name.includes(name));
        if (found) return found;
    }
    return this.voices.find(v => v.lang === 'en-US') || null;
  }

  speak(text: string, priority: boolean = false): Promise<void> {
    const cleanText = text.replace(/<[^>]*>/g, ''); 

    // Ensure AudioContext is active (mobile browsers sometimes suspend it)
    if (this.audioContext && this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
    }

    return new Promise((resolve) => {
      // Immediate cancellation if priority
      if (priority || this.isSpeaking) {
        this.synthesis.cancel();
      }

      this.isSpeaking = true;
      const utterance = new SpeechSynthesisUtterance(cleanText);
      this.currentUtterance = utterance;
      
      const voice = this.getPreferredVoice();
      if (voice) utterance.voice = voice;
      
      utterance.rate = 1.1;  
      utterance.pitch = 1.0; 
      utterance.volume = 1.0; 

      utterance.onend = () => {
          this.isSpeaking = false;
          this.currentUtterance = null;
          resolve();
      };
      
      utterance.onerror = () => {
          this.isSpeaking = false;
          this.currentUtterance = null;
          // Even on error, resolve so chain continues
          resolve();
      };

      this.synthesis.speak(utterance);
    });
  }

  stopSpeaking() {
    // Synchronous immediate stop
    if (this.synthesis.speaking || this.synthesis.pending) {
        this.synthesis.cancel();
    }
    this.isSpeaking = false;
    this.currentUtterance = null;
  }

  // --- PTT Listening (Instant & Robust) ---
  
  stopListening() {
    if (!this.isListening) return;
    this.intentionalStop = true;
    
    // Do NOT stop visualizer here, as we might be in emergency mode needing noise detection
    // But for PTT standard cleanup, we usually stop. 
    // We will leave visualizer running if monitoring is true.
    if (!this.isMonitoring) this.stopVisualizer();

    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    if (this.recognition) {
        try { this.recognition.stop(); } catch(e) {}
    }
  }

  listen(maxDurationSeconds: number = 45): Promise<string> {
    return new Promise((resolve, reject) => {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) {
        reject(new Error("Speech recognition not supported"));
        return;
      }

      // 1. INSTANT INTERRUPT (No awaiting)
      this.stopSpeaking();
      if (this.isMonitoring) {
          try { this.backgroundRecognition.stop(); } catch(e){}
      }
      
      // Warm up audio context immediately (User Interaction)
      if (this.audioContext && this.audioContext.state === 'suspended') {
          this.audioContext.resume().catch(() => {});
      }

      // 2. Initialize State
      this.isListening = true;
      this.intentionalStop = false;
      this.fullTranscript = "";
      this.sessionTranscript = "";
      this.resolveRecording = resolve;

      // 3. Set Safety Timers
      if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = setTimeout(() => {
          this.stopListening();
      }, maxDurationSeconds * 1000); 
      
      // 4. Start Visualizer (Fire and forget, non-blocking)
      this.startVisualizer();

      // 5. Start Recognition Cycle
      this.playSound('start');
      this._startRecognitionCycle(SpeechRecognition);
    });
  }

  private _startRecognitionCycle(SpeechRecognition: any) {
      if (!this.isListening) return;

      try {
          this.recognition = new SpeechRecognition();
          this.recognition.continuous = true; 
          this.recognition.interimResults = true;
          this.recognition.lang = 'en-US';
          
          this.sessionTranscript = "";

          this.recognition.onstart = () => {
              this._resetSilenceTimer();
          };

          this.recognition.onresult = (event: any) => {
              // RESET SILENCE TIMER ON EVERY RESULT
              this._resetSilenceTimer(); 

              let interim = "";
              for (let i = 0; i < event.results.length; ++i) {
                  interim += event.results[i][0].transcript;
              }
              this.sessionTranscript = interim; 
          };

          this.recognition.onerror = (event: any) => {
              if (event.error === 'not-allowed') {
                  this._finalizeAndResolve();
                  this.speak("Microphone access denied.");
              } else if (event.error === 'no-speech') {
                  // Ignore, will just close or restart logic
              }
          };

          this.recognition.onend = () => {
              if (!this.isListening) return;

              if (this.intentionalStop) {
                  // User stopped or timer stopped
                  this._finalizeAndResolve();
              } else {
                  // Browser auto-stop (Stitching Logic)
                  // Capture what we have so far
                  if (this.sessionTranscript) {
                      this.fullTranscript += this.sessionTranscript + " ";
                  }
                  // Restart immediately
                  this._startRecognitionCycle(SpeechRecognition);
              }
          };

          this.recognition.start();

      } catch (e) {
          console.error("STT Start Error", e);
          setTimeout(() => {
             if (this.isListening && !this.intentionalStop) this._startRecognitionCycle(SpeechRecognition);
          }, 100);
      }
  }

  private _resetSilenceTimer() {
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => {
          // 2.5s of TRUE silence triggers stop
          this.stopListening();
      }, 2500);
  }

  private _finalizeAndResolve() {
      this.isListening = false;
      this.intentionalStop = true; // Ensure no restarts
      
      if (!this.isMonitoring) this.stopVisualizer();

      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);

      const finalResult = (this.fullTranscript + " " + this.sessionTranscript).trim();
      
      this.playSound('end');

      // Resume background monitoring
      if (this.isMonitoring) {
          // Restart noise detection if it was stopped
          this.startNoiseListener();
          setTimeout(() => {
              try { this.backgroundRecognition.start(); } catch(e){}
          }, 500);
      }

      if (this.resolveRecording) {
          this.resolveRecording(finalResult);
          this.resolveRecording = null;
      }
  }

  vibrate(pattern: number | number[]) {
    if (navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  }
}

export const audioService = new AudioService();