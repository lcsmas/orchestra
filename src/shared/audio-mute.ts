// Isolated instances (e2e rigs: ORCHESTRA_HOME set, fresh userData ⇒ default
// chime 'knock') play through the user's real speakers — mute them unless
// ORCHESTRA_AUDIO=1 (the `dev` script sets it).
export function shouldMuteAudio(env: Record<string, string | undefined>): boolean {
  return !!env.ORCHESTRA_HOME && env.ORCHESTRA_AUDIO !== '1';
}
