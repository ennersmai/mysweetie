/**
 * Character Default Voice Configuration
 * 
 * Maps character names to their default Resemble.ai voice UUIDs.
 */

import { getVoiceUuid } from './voices';

/**
 * Get default voice UUID for a character by name
 * Falls back to character's stored voice preference if exists
 */
export function getCharacterVoiceUuid(characterName: string, storedVoice?: string | null): string | undefined {
  // First, try to use stored voice preference if provided
  if (storedVoice) {
    const storedUuid = getVoiceUuid(storedVoice);
    if (storedUuid) {
      return storedUuid;
    }
  }

  // Otherwise, use character name to get default voice
  const normalizedName = characterName.toLowerCase().trim();
  return getVoiceUuid(normalizedName);
}

/**
 * Get default voice name for a character
 * Used for frontend display
 */
export function getCharacterDefaultVoiceName(characterName: string): string {
  const normalizedName = characterName.toLowerCase().trim();
  
  // Map character names to their voice names
  const characterVoiceMap: Record<string, string> = {
    'layla': 'layla',
    'ava': 'ava',
    'mia': 'mia',
    'emma': 'emma',
    'aria': 'aria',
    'natalia': 'natalia',
    'star': 'star',
    'natsuki': 'natsuki',
    'mary': 'mary',
    'lana': 'lana',
    'clover': 'clover',
    'chloe': 'chloe'
  };

  return characterVoiceMap[normalizedName] || 'luna'; // Default to Luna if not found
}

