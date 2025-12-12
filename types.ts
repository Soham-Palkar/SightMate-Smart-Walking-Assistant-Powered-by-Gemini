export enum AppState {
  IDLE = 'IDLE',
  LISTENING = 'LISTENING',
  PROCESSING_INTENT = 'PROCESSING_INTENT',
  CAPTURING = 'CAPTURING',
  ANALYZING = 'ANALYZING',
  SPEAKING = 'SPEAKING',
  WALKING = 'WALKING',
  NAVIGATING = 'NAVIGATING',
  EMERGENCY_CHECK = 'EMERGENCY_CHECK',
  EMERGENCY_ACTING = 'EMERGENCY_ACTING',
  ERROR = 'ERROR'
}

export enum IntentType {
  DESCRIBE = 'DESCRIBE',
  READ_TEXT = 'READ_TEXT',
  SAFETY_CHECK = 'SAFETY_CHECK',
  HANDS_FREE_ON = 'HANDS_FREE_ON',
  HANDS_FREE_OFF = 'HANDS_FREE_OFF',
  WALKING_MODE_ON = 'WALKING_MODE_ON',
  WALKING_MODE_OFF = 'WALKING_MODE_OFF',
  NAVIGATE = 'NAVIGATE',
  STOP_NAVIGATION = 'STOP_NAVIGATION',
  WHERE_AM_I = 'WHERE_AM_I',
  COMPANION_MODE_ON = 'COMPANION_MODE_ON',
  COMPANION_MODE_OFF = 'COMPANION_MODE_OFF',
  UNKNOWN = 'UNKNOWN'
}

export interface IntentResult {
  type: IntentType;
  confidence: number;
  originalQuery: string;
  detailLevel?: 'simple' | 'detailed';
  destination?: string; // For navigation intents
}

export interface AnalysisResult {
  text: string;
  suggestedAction?: string;
}

export interface AudioFeedbackOptions {
  rate?: number;
  pitch?: number;
}

export interface NavigationPlan {
    destination: string;
    steps: string[];
    totalDistance: string;
    totalTime: string;
}

export interface WalkingHazard {
    hazard_type: string;
    category: 'ground' | 'level_change' | 'obstacle' | 'moving' | 'structural' | 'environmental' | 'animal' | 'personal' | 'fall' | 'none';
    description: string;
    direction: 'left' | 'center' | 'right' | 'unknown';
    distance: 'near' | 'medium' | 'far' | 'unknown';
    severity: 'low' | 'medium' | 'high';
    message: string;
    confidence: number;
}

export type EmergencySeverity = 'low' | 'medium' | 'high';