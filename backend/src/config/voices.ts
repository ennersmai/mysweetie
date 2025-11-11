/**
 * Resemble.ai Voice Configuration
 * 
 * Maps voice UUIDs to artistic names and assigns default voices to characters.
 */

export interface VoiceConfig {
  uuid: string;
  displayName: string;
  characterName?: string; // If assigned to a character
}

/**
 * Voice UUIDs from Resemble.ai
 * 16 total voices: 12 assigned to characters, 4 for general selection
 */
export const RESEMBLE_VOICES: Record<string, VoiceConfig> = {
  // Realistic character voices (6)
  'layla': {
    uuid: 'fb2d2858',
    displayName: 'Layla',
    characterName: 'Layla'
  },
  'ava': {
    uuid: '91b49260',
    displayName: 'Ava',
    characterName: 'Ava'
  },
  'mia': {
    uuid: 'cfb9967c',
    displayName: 'Mia',
    characterName: 'Mia'
  },
  'emma': {
    uuid: '55f5b8dc',
    displayName: 'Emma',
    characterName: 'Emma'
  },
  'aria': {
    uuid: '96d225a3',
    displayName: 'Aria',
    characterName: 'Aria'
  },
  'natalia': {
    uuid: '4e972f71',
    displayName: 'Natalia',
    characterName: 'Natalia'
  },
  
  // Anime character voices (6)
  'star': {
    uuid: '61fcb769',
    displayName: 'Star',
    characterName: 'Star'
  },
  'natsuki': {
    uuid: 'c49e1b04',
    displayName: 'Natsuki',
    characterName: 'Natsuki'
  },
  'mary': {
    uuid: '082cb68f',
    displayName: 'Mary',
    characterName: 'Mary'
  },
  'lana': {
    uuid: 'adb84c77',
    displayName: 'Lana',
    characterName: 'Lana'
  },
  'clover': {
    uuid: 'f453b918',
    displayName: 'Clover',
    characterName: 'Clover'
  },
  'chloe': {
    uuid: 'abbbc383',
    displayName: 'Chloe',
    characterName: 'Chloe'
  },
  
  // General selection voices (4) - artistic names
  'whisper': {
    uuid: 'c815cd7a',
    displayName: 'Whisper'
  },
  'celeste': {
    uuid: 'e28236ee',
    displayName: 'Celeste'
  },
  'aurora': {
    uuid: '0097f246',
    displayName: 'Aurora'
  },
  'luna': {
    uuid: 'c9ee13b4',
    displayName: 'Luna'
  }
};

/**
 * Get voice UUID by name (case-insensitive)
 */
export function getVoiceUuid(voiceName: string): string | undefined {
  const normalized = voiceName.toLowerCase().trim();
  return RESEMBLE_VOICES[normalized]?.uuid;
}

/**
 * Get all available voice names
 */
export function getAllVoiceNames(): string[] {
  return Object.keys(RESEMBLE_VOICES);
}

/**
 * Get voice config by name
 */
export function getVoiceConfig(voiceName: string): VoiceConfig | undefined {
  const normalized = voiceName.toLowerCase().trim();
  return RESEMBLE_VOICES[normalized];
}

/**
 * Check if a voice name exists
 */
export function isValidVoice(voiceName: string): boolean {
  const normalized = voiceName.toLowerCase().trim();
  return normalized in RESEMBLE_VOICES;
}

