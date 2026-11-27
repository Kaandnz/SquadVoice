import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.squadvoice.app',
  appName: 'SquadVoice',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    backgroundColor: '#111214',
    allowMixedContent: false,
  },
};

export default config;
