import { describe, expect, it } from 'vitest';
import { captureVerdict, detectionVerdict, isRecoverable } from './status';

/**
 * The separation these tests exist to protect: "we stopped hearing" and "you
 * are not breathing" are different facts with different remedies, and musie's
 * production bug was one predicate answering both.
 */

describe('captureVerdict', () => {
  const live = { now: 10000, lastFrameAt: 9990, lastSignalAt: 9980, hidden: false };

  it('is live while both clocks are fresh', () => {
    expect(captureVerdict(live)).toBe('live');
  });

  it('calls a hidden page paused, not broken — rAF stopping is expected', () => {
    expect(captureVerdict({ ...live, lastFrameAt: 0, lastSignalAt: 0, hidden: true })).toBe('paused');
  });

  it('separates the main thread stopping from the audio thread stopping', () => {
    /* No rAF ticks: the main thread. */
    expect(captureVerdict({ ...live, lastFrameAt: 8000 })).toBe('noFrames');
    /* Ticks arriving, every sample zero: the audio thread. */
    expect(captureVerdict({ ...live, lastSignalAt: 8000 })).toBe('captureLost');
  });

  it('reports noFrames ahead of captureLost when both are stale', () => {
    /* If rAF is not running we cannot know anything about the audio thread,
       so the main-thread fact is the honest one to report. */
    expect(captureVerdict({ ...live, lastFrameAt: 1000, lastSignalAt: 1000 })).toBe('noFrames');
  });
});

describe('detectionVerdict', () => {
  it('waits before concluding anything', () => {
    expect(detectionVerdict({ listeningForMs: 3000, completed: 0, blocked: false })).toBe('waiting');
  });

  /** The spike's primary finding, and it is not an error. */
  it('promotes a long silence to never-triggered', () => {
    expect(detectionVerdict({ listeningForMs: 25000, completed: 0, blocked: false }))
      .toBe('never-triggered');
  });

  it('reports sustained noise as its own verdict, not as a breath or a failure', () => {
    expect(detectionVerdict({ listeningForMs: 25000, completed: 4, blocked: true }))
      .toBe('noise-rejected');
  });

  it('is detecting once anything has been counted', () => {
    expect(detectionVerdict({ listeningForMs: 1000, completed: 1, blocked: false })).toBe('detecting');
  });
});

describe('isRecoverable', () => {
  it('treats permission and missing hardware as terminal', () => {
    expect(isRecoverable('permissionDenied')).toBe(false);
    expect(isRecoverable('noDevice')).toBe(false);
    expect(isRecoverable('insecureContext')).toBe(false);
  });

  it('treats everything iOS can take away as retryable', () => {
    expect(isRecoverable('trackMuted')).toBe(true);
    expect(isRecoverable('contextInterrupted')).toBe(true);
    expect(isRecoverable('roomTooLoud')).toBe(true);
  });
});
