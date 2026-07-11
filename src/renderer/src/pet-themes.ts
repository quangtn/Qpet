import type { PetTheme } from '@shared'
import type { PetMood } from './model'

export interface PetThemeDefinition {
  id: PetTheme
  name: string
  description: string
  brandImage: string
  stateDirectory: string
}

export const petThemes: readonly PetThemeDefinition[] = [
  {
    id: 'classic',
    name: 'Classic',
    description: 'Original pixel companion',
    brandImage: './pet/glasses-pet-master-256.png',
    stateDirectory: './pet/states'
  },
  {
    id: 'qmini',
    name: 'Qmini',
    description: 'Smooth coffee-and-code mascot',
    brandImage: './pets/qmini/qmini-master-256.png',
    stateDirectory: './pets/qmini/states'
  }
] as const

export function petThemeDefinition(theme: PetTheme): PetThemeDefinition {
  return petThemes.find((candidate) => candidate.id === theme) ?? petThemes[0]
}

export function petBrandImage(theme: PetTheme): string {
  return petThemeDefinition(theme).brandImage
}

export function petStateImage(theme: PetTheme, mood: PetMood): string {
  const file: Record<PetMood, string> = {
    sleeping: 'sleeping.png',
    running: 'working.png',
    needs_input: 'awaiting-input.png',
    ready: 'success.png',
    blocked: 'error.png'
  }
  return `${petThemeDefinition(theme).stateDirectory}/${file[mood]}`
}
