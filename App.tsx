import React, { useState, useEffect, useRef, useCallback } from 'react';
import Camera, { CameraHandle } from './components/Camera';
import AudioRing from './components/AudioRing';
import { audioService } from './services/audioService';
import { classifyIntent, analyzeImage, analyzeWalkingSafety, getWalkingDirections } from './services/geminiService';
import { AppState, IntentType, NavigationPlan, EmergencySeverity } from './types';

// Constants
const WELCOME_MESSAGE = "SightMate ready. Press to speak.";
const WALKING_LOOP_DELAY = 100; // 100ms - Effectively continuous, limited by API speed

// Companion Phrases (Local Fallback for low latency & reliability)
const COMPANION_PHRASES = [
  "I'm walking right here with you.",
  "You're doing great, stay confident.",
  "I'm watching out for you.",
  "Everything looks good, keep going.",
  "I'm here, just let me know if you need anything.",
  "Nice and steady.",
  "You are doing wonderful.",
  "The path ahead seems clear."
];

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  
  // -- Feature Toggles --
  const [isWalkingFeatureActive, setIsWalkingFeatureActive] = useState<boolean>(false);
  const [isNavigating, setIsNavigating] = useState<boolean>(false);
  const [isCompanionMode, setIsCompanionMode] = useState<boolean>(false);

  // -- Navigation State --
  const [navPlan, setNavPlan] = useState<NavigationPlan | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0);
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -- Emergency State --
  const emergencyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emergencySeverityRef = useRef<EmergencySeverity>('low');
  
  const cameraRef = useRef<CameraHandle>(null);
  
  // -- Interruption & State Management --
  const abortControllerRef = useRef<AbortController | null>(null);
  const interactionIdRef = useRef<number>(0); 
  const lastButtonPressRef = useRef<number>(0); 
  
  // Companion Timer Ref
  const lastCompanionMsgRef = useRef<number>(Date.now());
  // Watchdog Timer Ref
  const lastLoopTimeRef = useRef<number>(Date.now());
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // -- Animation Refs --
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Refs for async loops
  const isWalkingFeatureActiveRef = useRef(isWalkingFeatureActive);
  const isNavigatingRef = useRef(isNavigating);
  const isCompanionModeRef = useRef(isCompanionMode);
  const appStateRef = useRef(appState);
  const navPlanRef = useRef(navPlan);
  const stepIndexRef = useRef(currentStepIndex);
  const isAnalyzingFrameRef = useRef(false); 

  // Sync refs
  useEffect(() => {
    isWalkingFeatureActiveRef.current = isWalkingFeatureActive;
    isNavigatingRef.current = isNavigating;
    isCompanionModeRef.current = isCompanionMode;
    appStateRef.current = appState;
    navPlanRef.current = navPlan;
    stepIndexRef.current = currentStepIndex;

    // Automatic State Inference
    if (appState === AppState.IDLE) {
        if (isNavigating) setAppState(AppState.NAVIGATING);
        else if (isWalkingFeatureActive) setAppState(AppState.WALKING);
    }
  }, [isWalkingFeatureActive, isNavigating, isCompanionMode, appState, navPlan, currentStepIndex]);

  // --- Watchdog Logic (Prevent Freezing) ---
  useEffect(() => {
      if (watchdogTimerRef.current) clearInterval(watchdogTimerRef.current);
      
      watchdogTimerRef.current = setInterval(() => {
          const isActive = appStateRef.current === AppState.WALKING || appStateRef.current === AppState.NAVIGATING;
          // If active AND no activity for 2 seconds -> Restart
          if (isActive && (Date.now() - lastLoopTimeRef.current > 2000)) {
              console.warn("WalkingMode: Watchdog restart.");
              isAnalyzingFrameRef.current = false; // Reset lock
              runWalkingLoop(); // Restart
              audioService.speak("Walking mode active."); // Failsafe notification
          }
      }, 2000); // Check every 2s

      return () => { if (watchdogTimerRef.current) clearInterval(watchdogTimerRef.current); };
  }, []);

  // --- Distress Detection Setup ---
  useEffect(() => {
      // 1. Continuous Monitoring Callback
      const handleDistress = (type: string, severity: EmergencySeverity) => {
          // If already handling emergency, ignore unless escalation (e.g., keyword_high vs noise)
          if (appStateRef.current === AppState.EMERGENCY_CHECK || 
              appStateRef.current === AppState.EMERGENCY_ACTING) {
              return;
          }
          
          // Don't interrupt user speaking to AI
          if (appStateRef.current === AppState.LISTENING) return;

          console.warn(`Distress Detected: ${type} [${severity}]`);
          
          // Trigger Emergency Protocol
          triggerEmergencyCheck(severity);
      };

      audioService.startDistressListener(handleDistress);

      return () => {
          audioService.stopDistressListener();
      };
  }, []);

  // --- EMERGENCY PROTOCOL LOGIC ---
  const triggerEmergencyCheck = async (severity: EmergencySeverity) => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
      audioService.stopSpeaking();
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
      if (emergencyTimerRef.current) clearTimeout(emergencyTimerRef.current);

      emergencySeverityRef.current = severity;
      setAppState(AppState.EMERGENCY_CHECK);
      
      // Step 1: Verification
      await audioService.speak("It sounds like something is wrong. Are you okay?", true);

      // Start Listening for response (active 30s listen)
      performEmergencyVerification(1);
  };

  const performEmergencyVerification = async (attempt: number) => {
       if (appStateRef.current !== AppState.EMERGENCY_CHECK) return;

       try {
           // We use a shorter timeout for HIGH severity
           const timeout = emergencySeverityRef.current === 'high' ? 20 : 30;
           
           // We use the regular listen but interpret results specifically
           const response = await audioService.listen(timeout);
           
           if (!response || response.trim().length === 0) {
               // Silence / Timeout
               handleNoResponse(attempt);
           } else {
               const cleaned = response.toLowerCase();
               if (cleaned.includes("ok") || cleaned.includes("fine") || cleaned.includes("good") || cleaned.includes("safe") || cleaned.includes("yes")) {
                   // SAFE
                   await audioService.speak("I'm glad you are safe. Resuming.");
                   restoreState();
               } else if (cleaned.includes("no") || cleaned.includes("help") || cleaned.includes("hurt") || cleaned.includes("pain") || cleaned.includes("call")) {
                   // CONFIRMED DANGER
                   triggerEmergencyAction();
               } else {
                   // Ambiguous -> Treat as no response if high severity, or retry
                   handleNoResponse(attempt);
               }
           }
       } catch (e) {
           // Listen error or timeout rejection
           handleNoResponse(attempt);
       }
  };

  const handleNoResponse = async (attempt: number) => {
      if (appStateRef.current !== AppState.EMERGENCY_CHECK) return;

      // If High Severity -> Alert faster (only 1 attempt usually, or immediate fallback)
      // If Low/Med -> 2 attempts (60s total)
      const maxAttempts = emergencySeverityRef.current === 'high' ? 1 : 2;

      if (attempt < maxAttempts) {
          await audioService.speak("I didn't hear you. Please say 'I'm okay' if you are safe.", true);
          performEmergencyVerification(attempt + 1);
      } else {
          // TIMEOUT REACHED -> ALERT
          triggerEmergencyAction();
      }
  };

  const triggerEmergencyAction = async () => {
      setAppState(AppState.EMERGENCY_ACTING);
      
      // Simulate Alert
      audioService.playSound('warning'); // distinct alert sound
      await audioService.speak("Emergency help has been contacted. Sending your location now.", true);
      
      // Keep state in Emergency Acting to prevent auto-resume
      // In real app, this would make API call to backend
      console.log("SENDING ALERT: Location sent. Last severity: " + emergencySeverityRef.current);

      // Optional: keep monitoring
  };

  useEffect(() => {
    if (appState === AppState.WALKING || appState === AppState.NAVIGATING) {
        if (!isAnalyzingFrameRef.current) {
            runWalkingLoop();
        }
        
        if (isNavigating && navPlan) {
            if (navTimerRef.current) clearTimeout(navTimerRef.current);
            startNavigationLoop(); 
        }
    } else {
        if (navTimerRef.current) clearTimeout(navTimerRef.current);
    }
  }, [appState, isNavigating, navPlan]);

  useEffect(() => {
    audioService.speak(WELCOME_MESSAGE);
    return () => {
        if (navTimerRef.current) clearTimeout(navTimerRef.current);
        if (emergencyTimerRef.current) clearTimeout(emergencyTimerRef.current);
        if (abortControllerRef.current) abortControllerRef.current.abort();
    }
  }, []);

  // --- Navigation Logic ---
  const startNavigationLoop = () => {
      if (!isNavigatingRef.current || !navPlanRef.current || appStateRef.current !== AppState.NAVIGATING) return;

      const steps = navPlanRef.current.steps;
      const index = stepIndexRef.current;

      if (index >= steps.length) {
          audioService.speak("You have arrived.");
          setIsNavigating(false);
          setNavPlan(null);
          setAppState(isWalkingFeatureActiveRef.current ? AppState.WALKING : AppState.IDLE);
          return;
      }

      const stepText = steps[index];
      
      if (!audioService.isSpeaking) {
        audioService.playSound('navigation');
        audioService.speak(stepText).then(() => {
            if (appStateRef.current !== AppState.NAVIGATING) return;
            const waitTime = 14000; 
            navTimerRef.current = setTimeout(() => {
                if (isNavigatingRef.current && appStateRef.current === AppState.NAVIGATING) {
                    setCurrentStepIndex(prev => prev + 1);
                    startNavigationLoop(); 
                }
            }, waitTime);
        });
      } else {
          navTimerRef.current = setTimeout(startNavigationLoop, 3000);
      }
  };


  // --- Walking / Safety / Companion Loop ---
  const runWalkingLoop = async () => {
    // 1. UPDATE WATCHDOG TIMESTAMP
    lastLoopTimeRef.current = Date.now();

    const validState = appStateRef.current === AppState.WALKING || appStateRef.current === AppState.NAVIGATING;
    const featuresActive = isWalkingFeatureActiveRef.current || isNavigatingRef.current;
    
    // Stop if we are listening or in emergency
    if (appStateRef.current === AppState.LISTENING || 
        appStateRef.current === AppState.PROCESSING_INTENT ||
        appStateRef.current === AppState.EMERGENCY_CHECK || 
        appStateRef.current === AppState.EMERGENCY_ACTING) return;

    if (!validState || !featuresActive) return;
    
    // Skip if busy ("Drop frame" logic)
    if (isAnalyzingFrameRef.current) return;
    
    isAnalyzingFrameRef.current = true;

    try {
        // 2. FORCE FRAME CAPTURE
        let frame = await cameraRef.current?.capture(true, true);
        if (!frame) {
            // Retry once immediately
            await new Promise(r => setTimeout(r, 100));
            frame = await cameraRef.current?.capture(true, true);
        }
        
        if (!frame) {
            console.log("WalkingMode: Frame capture failed.");
            return; // Skip cycle, finally will run next loop
        }
        console.log("WalkingMode: Frame captured.");

        // 3. HAZARD REQUEST
        console.log("WalkingMode: Hazard request sent.");
        const hazard = await analyzeWalkingSafety(frame, abortControllerRef.current?.signal);

        // Visual Fall Detection Check
        if (hazard && hazard.hazard_type && hazard.category === 'fall') {
             triggerEmergencyCheck('high');
             return; // Stop loop logic here, emergency state takes over
        }

        if (appStateRef.current === AppState.WALKING || appStateRef.current === AppState.NAVIGATING) {
            if (hazard && hazard.hazard_type !== 'none' && hazard.message) {
                // HAZARD DETECTED: Priority Speak (Interrupt)
                console.log("WalkingMode: Speaking hazard ->", hazard.message);
                
                // 5. OVERRIDE COMPANION
                audioService.stopSpeaking();
                await audioService.speak(hazard.message, true); // True = Priority
                
                // Reset Companion Timer so we don't speak immediately after a warning
                lastCompanionMsgRef.current = Date.now(); 
            } 
            else {
                // COMPANION MODE LOGIC
                // Check: Active? Time elapsed? Not speaking?
                if (isCompanionModeRef.current && !audioService.isSpeaking) {
                    const now = Date.now();
                    if (now - lastCompanionMsgRef.current > 15000) { // Every 15s roughly
                        const phrase = COMPANION_PHRASES[Math.floor(Math.random() * COMPANION_PHRASES.length)];
                        audioService.speak(phrase); // Standard priority, will queue if busy
                        lastCompanionMsgRef.current = now;
                    }
                } else if (!isCompanionModeRef.current && Math.random() > 0.95 && !audioService.isSpeaking) { 
                    // Rare "Path clear" confirmation if companion mode is OFF
                    await audioService.speak("Path clear.");
                }
            }
        }
    } catch (e) {
        console.warn("WalkingMode: Loop Error", e);
    } finally {
        isAnalyzingFrameRef.current = false;
        
        // Ensure we loop again if still active
        if ((appStateRef.current === AppState.WALKING || appStateRef.current === AppState.NAVIGATING) &&
            appStateRef.current !== AppState.LISTENING) {
            setTimeout(runWalkingLoop, WALKING_LOOP_DELAY);
        }
    }
  };

  const handleError = useCallback((message: string) => {
    setAppState(AppState.ERROR);
    audioService.playSound('error');
    audioService.speak(message);
    setTimeout(restoreState, 3000);
  }, []);

  const restoreState = () => {
    if (isNavigatingRef.current) setAppState(AppState.NAVIGATING);
    else if (isWalkingFeatureActiveRef.current) setAppState(AppState.WALKING);
    else setAppState(AppState.IDLE);
  };

  const processCommand = async (transcript: string, commandId: number, signal: AbortSignal) => {
    if (interactionIdRef.current !== commandId) return;

    if (!transcript) {
        audioService.speak("I didn't hear you.");
        restoreState();
        return;
    }

    setAppState(AppState.PROCESSING_INTENT);
    audioService.playSound('end'); // Confirm received

    try {
      const intent = await classifyIntent(transcript, signal);
      if (interactionIdRef.current !== commandId) return;
      
      console.log("Detected Intent:", intent);

      if (intent.type === IntentType.COMPANION_MODE_ON) {
          setIsCompanionMode(true);
          await audioService.speak("I'm here with you now. Let's go together.");
          lastCompanionMsgRef.current = Date.now(); // Reset timer
          if (!isWalkingFeatureActiveRef.current) {
              setIsWalkingFeatureActive(true);
              setAppState(AppState.WALKING);
          } else {
              restoreState();
          }
          return;
      }
      if (intent.type === IntentType.COMPANION_MODE_OFF) {
          setIsCompanionMode(false);
          await audioService.speak("Quiet mode enabled.");
          restoreState();
          return;
      }

      if (intent.type === IntentType.NAVIGATE) {
          if (!intent.destination) {
              await audioService.speak("Where would you like to go?");
              restoreState();
              return;
          }

          audioService.speak(`Calculating walking route to ${intent.destination}.`);
          let coords: GeolocationCoordinates | null = null;
          try {
              const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
                  navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 4000 });
              });
              coords = pos.coords;
          } catch (e) {}

          if (interactionIdRef.current !== commandId) return;
          const plan = await getWalkingDirections(intent.destination, coords, signal);
          if (interactionIdRef.current !== commandId) return;
          
          if (plan) {
              setNavPlan(plan);
              setCurrentStepIndex(0);
              setIsNavigating(true);
              setIsWalkingFeatureActive(true);
              setIsCompanionMode(true); // AUTO-ENABLE COMPANION ON NAV
              lastCompanionMsgRef.current = Date.now(); // Reset timer

              setAppState(AppState.NAVIGATING); 
              await audioService.speak(`Route found. ${plan.totalTime}. Starting navigation.`);
          } else {
              audioService.speak("I couldn't find that location.");
              restoreState();
          }
          return;
      }

      if (intent.type === IntentType.STOP_NAVIGATION) {
          setIsNavigating(false);
          setNavPlan(null);
          await audioService.speak("Navigation stopped.");
          if (isWalkingFeatureActiveRef.current) setAppState(AppState.WALKING);
          else setAppState(AppState.IDLE);
          return;
      }

      if (intent.type === IntentType.WALKING_MODE_ON) {
        setIsWalkingFeatureActive(true);
        setIsCompanionMode(true); // AUTO-ENABLE COMPANION ON WALKING
        lastCompanionMsgRef.current = Date.now(); // Reset timer
        await audioService.speak("Walking mode active. I'm with you.");
        setAppState(AppState.WALKING); 
        return; 
      }
      if (intent.type === IntentType.WALKING_MODE_OFF) {
        setIsWalkingFeatureActive(false);
        setIsCompanionMode(false); // AUTO-DISABLE COMPANION
        await audioService.speak("Walking mode disabled.");
        setAppState(AppState.IDLE);
        return; 
      }

      const isVisualIntent = 
        intent.type === IntentType.DESCRIBE || 
        intent.type === IntentType.READ_TEXT || 
        intent.type === IntentType.SAFETY_CHECK || 
        intent.type === IntentType.WHERE_AM_I ||
        intent.type === IntentType.UNKNOWN;

      if (isVisualIntent) {
          let location: GeolocationCoordinates | undefined;
          if (intent.type === IntentType.WHERE_AM_I) {
             setAppState(AppState.PROCESSING_INTENT);
             audioService.speak("Locating...");
             try {
                 const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
                     navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 6000 });
                 });
                 location = pos.coords;
             } catch (e) {
                 audioService.speak("GPS signal lost. Checking visual cues.");
             }
          }

          if (interactionIdRef.current !== commandId) return;
          setAppState(AppState.CAPTURING);
          if (intent.type !== IntentType.WHERE_AM_I) audioService.speak("Checking..."); 
          
          await new Promise(r => setTimeout(r, 400)); 
          if (interactionIdRef.current !== commandId) return;

          const imageBase64 = await cameraRef.current?.capture(false, false);
          if (!imageBase64) {
            handleError("Camera error.");
            return;
          }

          setAppState(AppState.ANALYZING);
          
          const analysis = await analyzeImage(imageBase64, intent, location, signal);
          if (interactionIdRef.current !== commandId) return;
          
          setAppState(AppState.SPEAKING);
          await audioService.speak(analysis);
          restoreState();
          return; 
      }

    } catch (err) {
      if ((err as Error).message === "Aborted") return;
      if (interactionIdRef.current !== commandId) return;
      handleError("Error processing request.");
    }
  };

  const handleButtonPress = async () => {
    const now = Date.now();
    if (now - lastButtonPressRef.current < 300) return;
    lastButtonPressRef.current = now;

    if (appStateRef.current === AppState.EMERGENCY_CHECK) {
        // User manually cancelled emergency check
        audioService.speak("Emergency check cancelled.");
        restoreState();
        return;
    }
    
    if (appStateRef.current === AppState.EMERGENCY_ACTING) {
        // Reset from triggered state
        audioService.speak("Emergency mode reset.");
        restoreState();
        return;
    }

    if (appStateRef.current === AppState.LISTENING) {
        audioService.stopListening();
        return; 
    }

    const currentInteractionId = now;
    interactionIdRef.current = currentInteractionId;

    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    audioService.stopSpeaking();
    if (navTimerRef.current) clearTimeout(navTimerRef.current);
    
    setAppState(AppState.LISTENING);
    audioService.vibrate(50);
    
    try {
        let transcript = await audioService.listen();
        
        if (interactionIdRef.current !== currentInteractionId) return;

        if (!transcript || transcript.trim().length < 2) {
             await audioService.speak("I didn’t hear you, please try again.", true);
             restoreState();
             return;
        }

        await processCommand(transcript, currentInteractionId, signal);

    } catch (e) {
        if (interactionIdRef.current === currentInteractionId) restoreState();
    }
  };

  // --- UI Helpers ---

  const getButtonStyles = () => {
    if (appState === AppState.EMERGENCY_CHECK || appState === AppState.EMERGENCY_ACTING) 
        return 'bg-red-600 animate-ping shadow-[0_0_80px_rgba(220,38,38,0.8)] border-4 border-white';
        
    if (appState === AppState.NAVIGATING) return 'bg-emerald-500 shadow-[0_0_60px_rgba(16,185,129,0.6)] animate-pulse scale-105 border-4 border-blue-400';
    if (appState === AppState.WALKING) return 'bg-amber-400 shadow-[0_0_50px_rgba(251,191,36,0.5)] animate-pulse scale-105';
    switch (appState) {
      case AppState.LISTENING: return 'bg-rose-500 shadow-rose-400'; 
      case AppState.PROCESSING_INTENT: 
      case AppState.CAPTURING: 
      case AppState.ANALYZING: return 'bg-blue-500 shadow-blue-400 animate-pulse';
      case AppState.SPEAKING: return 'bg-emerald-500 shadow-emerald-400';
      default: return 'bg-indigo-500 shadow-indigo-400';
    }
  };

  const getStatusText = () => {
      if (appState === AppState.EMERGENCY_CHECK) return "ARE YOU OKAY? LISTENING...";
      if (appState === AppState.EMERGENCY_ACTING) return "EMERGENCY ALERT SENT";
      if (appState === AppState.NAVIGATING) return "Navigating & Safe Walking";
      if (appState === AppState.WALKING) return "Walking Mode Active";
      if (appState === AppState.LISTENING) return "Listening...";
      return "SightMate";
  }

  return (
    <div className={`h-screen w-full flex flex-col items-center justify-center overflow-hidden relative ${appState === AppState.EMERGENCY_CHECK || appState === AppState.EMERGENCY_ACTING ? 'bg-red-50' : 'bg-gradient-to-br from-indigo-50 to-purple-100'}`}>
      <Camera ref={cameraRef} />
      
      {/* Background Blobs */}
      {appState !== AppState.EMERGENCY_CHECK && appState !== AppState.EMERGENCY_ACTING && (
          <>
            <div className="absolute top-10 left-10 w-48 h-48 bg-purple-200 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-blob"></div>
            <div className="absolute bottom-10 right-10 w-64 h-64 bg-teal-200 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-blob animation-delay-2000"></div>
          </>
      )}

      <div className="relative z-10 flex flex-col items-center">
        <div className="relative">
            {(appState === AppState.WALKING || appState === AppState.NAVIGATING) && (
                 <div className={`absolute -inset-4 border-4 rounded-full animate-ping ${appState === AppState.NAVIGATING ? 'border-emerald-400/30' : 'border-amber-400/30'}`}></div>
            )}
            
            {/* NEW: Audio Visualizer Ring - Passed full AppState */}
            <AudioRing state={appState} size={600} />

            <button
            ref={buttonRef}
            onClick={handleButtonPress}
            className={`
                relative w-72 h-72 rounded-full flex flex-col items-center justify-center
                transition-transform duration-75 ease-out shadow-2xl z-10
                ${getButtonStyles()}
            `}
            style={{
                willChange: 'transform, box-shadow' 
            }}
            >
            {appState === AppState.EMERGENCY_CHECK || appState === AppState.EMERGENCY_ACTING ? (
                <div className="flex flex-col items-center">
                    <span className="text-4xl font-bold text-white">I'M OK</span>
                    <span className="text-sm text-white mt-2 font-semibold tracking-wider">TAP TO CANCEL</span>
                </div>
            ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-32 w-32 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={appState === AppState.LISTENING ? "M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" : "M13 10V3L4 14h7v7l9-11h-7z"} />
                </svg>
            )}
            </button>
        </div>

        <div className="mt-12 text-center opacity-80">
             <h1 className="text-2xl font-bold text-slate-700 tracking-wide">
                 {getStatusText()}
             </h1>
             {isCompanionMode && appState !== AppState.EMERGENCY_CHECK && appState !== AppState.EMERGENCY_ACTING && (
                 <p className="text-sm text-pink-500 mt-2 font-bold">♥ Companion Mode Active</p>
             )}
        </div>
      </div>
    </div>
  );
};

export default App;