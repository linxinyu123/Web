
export interface CycleStats {
  average: number;
  shortest: number;
  longest: number;
}

export interface PredictionResult {
  stats: CycleStats;
  predictedDate: string;
  rangeStart: string;
  rangeEnd: string;
  cycleLengths: number[];
}

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

export interface PeriodRecord {
  id: string;
  startDate: string;
}
