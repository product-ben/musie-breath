import type { CaptureStatus } from '../detect/status';
import type { DetectionVerdict } from '../detect/status';

/**
 * TWO CHIPS, NEVER ONE.
 *
 * This is the physical embodiment of the lesson in musie's
 * docs/VOICE-CAPTURE-FIX.md: "we stopped hearing" and "you are not breathing"
 * are different facts, and the production bug was one predicate reporting
 * both — with the flattering answer winning.
 *
 * Merging these two chips would reintroduce exactly that defect at the UI
 * layer. The left chip may never say anything about breathing; the right chip
 * may never say anything about the microphone.
 */

function captureText(status: CaptureStatus): string {
  switch (status.kind) {
    case 'idle': return 'not started';
    case 'opening': return 'opening microphone…';
    case 'reopening': return 'reopening…';
    case 'calibrating': return `listening to the room ${status.framesDone}/${status.framesNeeded}`;
    case 'measuringLeak': return `learning the track ${status.framesDone}/${status.framesNeeded}`;
    case 'listening': return 'capture live';
    case 'failed': return status.code;
  }
}

export function Chips({
  status,
  verdict,
  breaths,
}: {
  status: CaptureStatus;
  verdict: DetectionVerdict;
  breaths: number;
}) {
  const failed = status.kind === 'failed';

  /* `never-triggered` is NOT a failure. It is this spike's primary finding:
     the microphone worked, the room was fine, and a breath still did not
     register. It is styled as a finding, not as an error. */
  const detection =
    verdict === 'detecting' ? `breaths ${breaths}`
    : verdict === 'noise-rejected' ? 'continuous sound — treated as noise'
    : verdict === 'never-triggered' ? 'no breath detected yet'
    : 'waiting for a breath';

  return (
    <div className="breath-chips">
      <span className={`breath-chip ${failed ? 'is-bad' : status.kind === 'listening' ? 'is-good' : ''}`}>
        <span className="breath-chip-key">capture</span>
        {captureText(status)}
      </span>
      <span className={`breath-chip ${verdict === 'detecting' ? 'is-good' : verdict === 'noise-rejected' ? 'is-warn' : ''}`}>
        <span className="breath-chip-key">detection</span>
        {status.kind === 'listening' ? detection : '—'}
      </span>
    </div>
  );
}
