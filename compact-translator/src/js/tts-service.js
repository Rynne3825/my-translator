import { invoke } from './tauri.js';
import { audioPlayer } from './audio-player.js';

export async function speakText(text, settings) {
  const value = String(text || '').trim();
  if (!value || !settings.tts_enabled) {
    return;
  }

  const provider = settings.tts_provider || 'edge';

  let base64Audio = '';
  if (provider === 'azure') {
    base64Audio = await invoke('azure_tts_speak', {
      text: value,
      voice: settings.azure_tts_voice || 'en-US-AvaMultilingualNeural',
      rate: Number(settings.azure_tts_speed || 0),
      keyOverride: settings.azure_speech_key || null,
      regionOverride: settings.azure_speech_region || null,
    });
  } else {
    base64Audio = await invoke('edge_tts_speak', {
      text: value,
      voice: settings.edge_tts_voice || 'vi-VN-HoaiMyNeural',
      rate: Number(settings.edge_tts_speed || 20),
    });
  }

  await audioPlayer.enqueue(base64Audio);
}
