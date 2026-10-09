/**
 * Which microphone, and — the part that matters — which one we actually got.
 *
 * ── THE PROBLEM THIS EXISTS FOR ────────────────────────────────────────────
 * Listening on headphones while capturing on the phone's own microphone is the
 * configuration the exercise wants: the track goes straight into your ears, so
 * nothing leaks into the capture, and the built-in microphone keeps its full
 * bandwidth.
 *
 * iOS does not volunteer that combination. Connecting headphones normally moves
 * the CAPTURE route to the headset microphone as well, and over Bluetooth that
 * means HFP — narrowband, 8 or 16 kHz, so the 4–8 kHz band simply does not
 * exist and the sibilant rejector is dead.
 *
 * Whether a web page can override it is an open question, and the honest
 * answer may be no: iOS Safari has historically ignored `deviceId` for audio
 * input, and may expose a single input whose physical route the system alone
 * decides. So this module ASKS, and then reports what came back — the same
 * asked-versus-got discipline the processing constraints already get, because
 * it is the only way to find out.
 */

export type MicKind = 'builtIn' | 'headset' | 'unknown';

export type MicDevice = {
  readonly deviceId: string;
  readonly label: string;
  readonly kind: MicKind;
};

/**
 * Classify by label, which is all a browser offers.
 *
 * Labels are EMPTY until microphone permission has been granted, so this is
 * only meaningful on a re-enumeration after `getUserMedia` has resolved — see
 * listInputs' note.
 */
export function classify(label: string): MicKind {
  const l = label.toLowerCase();
  if (/airpods|headset|headphone|kopfh|bluetooth|wired|earbud|buds/.test(l)) {
    return 'headset';
  }
  if (/built-?in|iphone|ipad|telefon|bottom|front|back|default/.test(l)) {
    return 'builtIn';
  }
  return 'unknown';
}

/**
 * The audio inputs the browser admits to.
 *
 * Call this AFTER permission, or every label is an empty string and every
 * device classifies as unknown. That is a privacy rule rather than a bug, and
 * it is why the picker only becomes useful once capture has started once.
 */
export async function listInputs(): Promise<MicDevice[]> {
  if (navigator.mediaDevices?.enumerateDevices === undefined) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label === '' ? '(unnamed — grant the microphone first)' : d.label,
        kind: classify(d.label),
      }));
  } catch {
    return [];
  }
}

/** The built-in one if it can be identified, else nothing rather than a guess. */
export function preferBuiltIn(devices: readonly MicDevice[]): MicDevice | null {
  return devices.find((d) => d.kind === 'builtIn') ?? null;
}

/**
 * What a capture rate implies about the route. The strongest tell there is.
 *
 * Bluetooth HFP cannot carry more than 16 kHz, so a rate at or below that is
 * near-proof of a headset microphone whatever the labels claim — and it is
 * also the exact condition under which the high band, and with it the /s/
 * rejector, does not exist.
 */
export function routeFromRate(sampleRate: number): {
  likely: MicKind;
  narrowband: boolean;
} {
  if (sampleRate <= 16000) return { likely: 'headset', narrowband: true };
  if (sampleRate < 32000) return { likely: 'unknown', narrowband: true };
  return { likely: 'builtIn', narrowband: false };
}
