import { create } from 'zustand';

interface MicLevelState {
  /** Mic level on the 0..100 meter scale (dB based, -80 dBFS → 0). */
  micLevel: number;
  /** Where the noise gate currently opens, same scale (moves in auto mode). */
  gateThreshold: number;
  setMicLevel: (level: number) => void;
  setGateThreshold: (threshold: number) => void;
}

export const useMicLevelStore = create<MicLevelState>((set) => ({
  micLevel: 0,
  gateThreshold: 38, // -50 dB, the starting auto threshold
  setMicLevel: (micLevel) => set({ micLevel }),
  setGateThreshold: (gateThreshold) => set({ gateThreshold }),
}));
