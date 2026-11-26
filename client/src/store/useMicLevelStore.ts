import { create } from 'zustand';

interface MicLevelState {
  micLevel: number;
  setMicLevel: (level: number) => void;
}

export const useMicLevelStore = create<MicLevelState>((set) => ({
  micLevel: 0,
  setMicLevel: (micLevel) => set({ micLevel }),
}));
