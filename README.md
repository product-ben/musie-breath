# musie-breath

A feasibility spike. One question:

> **Can a phone microphone tell, on its own, that you are breathing out
> through your mouth — well enough to drive something on screen in real time?**

Nothing here is a product. No design system, no i18n, no CI. If detection
works, the question of what it should look like gets asked elsewhere.

## Why there is reason to doubt it

The [`musie`](https://github.com/product-ben/musie) repo has an open question
nobody has answered. `echoCancellation` and `noiseSuppression` are switched on
in its production capture path and **were never measured**. On iOS they select
voice-processing mode, which changes the input route.

Noise suppression is tuned to classify non-speech as noise and discard it. A
breath is not speech. So the plausible failure mode is that **iOS deletes the
signal before we ever see it** — which is why all three processing constraints
are off by default here, and exposed as toggles that show what iOS actually
applied rather than what was asked for.

## Running it

```sh
pnpm install
pnpm dev          # :5180, strictPort
```

`pnpm check` is `tsc --noEmit && vitest run`.

### On a phone, which is the only test that counts

`getUserMedia` needs a secure context, and **a LAN address is not one** — iOS
Safari simply refuses the microphone at `http://192.168.x.x:5180`, which reads
as a broken app rather than as a missing certificate. So:

```sh
pnpm dev
cloudflared tunnel --url http://localhost:5180
```

Open the `trycloudflare.com` URL on the phone. The dev server allows that
domain and its subdomains; nothing else.

Port 5180 is pinned with `strictPort` on purpose: musie's dev server owns 5173,
and a Vite that quietly moves to 5174 means a tunnel that verifies the wrong
application.

## What to look at, in order

1. **Does `getSettings()` show `noiseSuppression: false` honoured?** The
   constraints section says `got true` / `got false` per constraint and flags a
   constraint iOS ignored. This is the headline measurement.
2. **What does an exhale do to the four features** — with suppression off, and
   then with it on. Watch the history strip rather than the numbers: during a
   breath the phone is under your chin and you can read nothing.
3. **Tune** `onset dB over floor`, `min low ratio` and `max flatness dB`
   against the strip, at a natural holding distance. Tuning persists across
   reloads and `Copy diagnostics` puts the whole state on the clipboard.
4. **Try to fool it.** Speak at it, cough at it, hold a long `ssss`. Each must
   leave the breath count unchanged.
5. **Switch apps mid-exhale.** It must report that *it* stopped hearing, never
   that you stopped breathing.

## How it works

```
src/detect/     pure, tested, no audio objects and no React
  config.ts     every dial, each marked DERIVED or GUESS with its reasoning
  features.ts   one analyser frame -> four numbers
  decide.ts     the state machine. Everything that can be wrong is in here
  calibrate.ts  1.5 s of room -> a floor every threshold is relative to
  status.ts     two verdicts that are never allowed to answer each other's
src/audio/
  openMicrophone.ts   the ONLY effectful file
```

### The four features, and what each one rejects

A mouth exhale is broadband turbulent noise with no harmonic structure and a
slow envelope, and at phone distance it carries strong sub-300 Hz content from
air hitting the diaphragm directly.

| feature | rejects |
|---|---|
| `excessDb` — RMS over the calibrated floor | a quiet room. Alone it cannot tell breath from anything loud, which is why the other three exist |
| `lowRatio` — share of new energy below 300 Hz | sound from across the room. This is the "blown at the phone" evidence |
| `flatnessDb` — **detrended** spectral flatness, 300–3000 Hz | **voiced speech**, which is tonal. See below for why the detrending is not optional |
| `highRatio` — share of new energy above 4 kHz | **sibilants**. `/s/` is also noise-like, but lives where breath does not |

### Why flatness is detrended, which is the one thing here worth reading

Spectral flatness as a geometric-over-arithmetic mean ratio conflates two
unrelated things: **tonality** (harmonic peaks, which is what separates a voice
from noise) and **spectral tilt** (the overall slope, which says nothing about
tonality). Over a band of N octaves, a perfectly smooth spectrum with R dB of
tilt costs roughly R/3 dB of flatness all by itself.

That confound is fatal here, because **breath is inherently tilted** — it is the
entire premise of the `lowRatio` feature. Driven through a fake capture device,
the plain measure produced an ordering that is simply wrong:

| signal | plain flatness | detrended |
|---|---|---|
| realistic breath (gentle tilt) | −3.6 dB | **−2.5 dB** |
| steeply tilted noise (no tonality at all) | −12.8 dB | **−2.7 dB** |
| voiced speech | −10.5 dB | **−6.7 dB** |

Plain flatness ranks a smooth tilted noise as *more tonal than a human voice*.
No single threshold on it can work. After least-squares removing the slope in
dB and measuring the residual, both noises converge on ≈ −2.5 dB — the
theoretical ceiling, since for exponentially distributed bin power
`E[ln X] = ln(mean) − γ` gives `exp(−γ) ≈ 0.56` — while speech stays 4 dB
below. The feature finally measures what it was chosen to measure.

Plain flatness is still carried in `extras.plainFlatnessDb`, because the gap
between the two *is* the spectral tilt, which is itself a measurement of how
close the phone is to the mouth.

Shape features are computed on **excess energy over the floor**, not on total
energy, so the ratios describe only what is new in the room. That is what makes
a steady fan survivable.

### Headphones out, phone microphone in

The configuration the exercise actually wants: the track goes straight into
your ears so nothing leaks into the capture, and the built-in microphone keeps
its full bandwidth.

**iOS does not offer that combination by default.** Connecting headphones
normally moves the *capture* route to the headset microphone as well, and over
Bluetooth that means HFP — 8 or 16 kHz, so there is no 4–8 kHz band at all and
the sibilant rejector does not exist. A long `/s/` then reads as a breath.

Whether a web page can override the route is an open question, and the honest
answer may be no: iOS Safari has historically ignored `deviceId` for audio
input and may expose a single input whose physical route the system alone
picks. So the app asks and then reports:

- Every enumerated input, classified `builtIn` / `headset` / `unknown`.
  **Labels are empty strings until microphone permission is granted**, so the
  picker only fills in after the first start — before that, anonymous entries
  would be worse than none.
- `deviceId: { exact: … }` is requested, so a refusal throws rather than
  silently handing over a different microphone. A refusal is then **retried
  without the constraint and remembered**, so the app still works and the
  diagnostics still say it was not what was asked for.
- **Asked for / got / capture rate / route**, in four lines.

### The capture rate is the strongest tell

HFP cannot carry more than 16 kHz, so a rate at or below that identifies a
Bluetooth headset microphone whatever the labels claim — and it is the exact
condition under which the high band disappears. `routeFromRate` encodes that,
and the app warns on it.

### And the leak measurement doubles as a route detector

Once there are headphones, the pink-noise burst answers a second question for
free:

| capture route | expected leak |
|---|---|
| phone's own microphone | ≈ none — the drivers are in your ears, the mic is on the phone |
| headset microphone | real — the mic sits inches from its own driver |

So **full-band capture with a measurable leak** means the track is going into
the microphone rather than only into your ears, which is the headset-mic
signature on wired earbuds. The app says so when it sees it.

If the route cannot be chosen on your device, the only lever left is which
headphones you use — wired, and ideally without a microphone of their own,
should hand capture back to the phone.

## Playing a track while listening

The point of the exercise: you listen to something while it watches for your
out-breath. That is the hard version, because **music looks a great deal like
breath to these four features** — a full mix is broadband, bass-weighted (so it
passes `lowRatio`) and noise-like in aggregate (so it passes detrended
flatness). Through the phone's own speaker it arrives at the phone's own
microphone a few centimetres away and the detector fires on the track.

`echoCancellation` is the obvious fix and the one thing that cannot be used,
because switching it on puts iOS into voice-processing mode — the exact
variable this spike exists to measure.

So instead: **the playback signal is ours, so we can subtract what it
predicts.** Calibration has three phases:

1. **The room**, in silence. Also the proof the audio graph renders at all.
2. **The speaker leak** — the track's own first seconds. Its dynamics are the
   excitation, so no test signal is ever played at you.
3. **Listening**, with the floor now `room + coupling × live track spectrum`,
   delayed by the output latency because the microphone hears the past.

The playback analyser is tapped **after** the volume gain, which makes the
coupling coefficients volume-independent: turn the track down and the measured
spectrum moves while the transfer function stays valid. With headphones the
coupling measures ≈0 and everything degrades to the static-floor case that
already works.

### The leak is measured as a slope, not a ratio

Two versions came before this one, and both were wrong in instructive ways.

The first computed `c = (heard − room) / played` per frame and took the median.
Driven in a headless browser — where there is **no acoustic path whatsoever**,
since the fake microphone reads a file — it confidently reported **32 dB of
speaker leak**, because the measurement overlapped a loud passage in that file.
The estimator had no way to tell *the speaker caused this* from *something else
happened at the same time*.

On a phone that is the failure mode, not a curiosity: anyone who breathes,
speaks or shuts a door during the measurement inflates the coefficient, and the
detector then over-subtracts for the rest of the session and silently disarms
itself. A median survives one transient; it does not survive a sustained one.

So coupling is the least-squares **slope** of heard against played:

```
heard_b = intercept_b + c_b · played_b
```

Anything the speaker did not cause is constant across the window, lands in
`intercept_b`, and leaves the slope alone. It measures what the speaker
*causes* rather than what merely *coincides* with it. The room floor stops
being a parameter for the same reason.

The second version fed that regression a level-stepped pink-noise burst,
because a slope needs its input to vary and pink noise is stationary. It
worked, and it sounded like a stuttering *krrr krrr* immediately before a calm
breathing exercise — the wrong first impression for this of all products.

**Music is not stationary.** It varies far more than any burst, so the track is
now its own excitation: the first three seconds of playback are the
measurement, and nothing is ever played at you to take it.

The fit's r² is reported, and below 0.5 the coefficients are **discarded rather
than trusted** — the floor stays static and the screen says why. A track with
too little dynamic range is one of the two reasons that happens, and the app
keeps watching up to nine seconds before giving up.

### Four outcomes, not two

Collapsing these was a mistake made twice, and the second time it broke the
very configuration the exercise is for.

| verdict | means | and so |
|---|---|---|
| `none` | the slope implies a leak far below the room floor | **the headphone case, and the good one.** r² is meaningless — there is no relationship to fit — and waiting cannot change it |
| `measured` | a real leak, fitted well | subtract it |
| `unmeasurable` | the track is a drone; the level never moved | nothing to regress against, ever |
| `untrusted` | real slope, poor fit | something uncorrelated is interfering — the one case where more frames might help |

Treating `none` as a failed measurement made headphones-out-phone-mic-in wait
the full nine-second extension for a fit that could never succeed, and then
apologise for it. It now arms in about five seconds and says *no measurable
leak* as the success it is.

The window also extends while there are **too few usable frames**, which is a
separate reason waiting helps: every frame with a breath in it is discarded, so
someone breathing steadily can leave only a handful behind. Eight frames is
enough to compute a slope and nowhere near enough to trust one.

### The one way this can still be fooled

A breath is normally uncorrelated with the music and lands in the intercept.
But **in a guided breathing exercise people breathe in time with the track**,
and a breath rising and falling *with* the level biases the slope upward —
which would over-subtract and disarm the detector, while the fit still looks
excellent. That is what makes it dangerous.

So frames where a breath looks to be in progress are excluded from the fit, and
there is a test asserting that correlated interference *does* bias the estimate,
so the exclusion is never quietly removed as redundant.

## Thresholds are relative, always

Absolute thresholds cannot work: the same exhale differs by an order of
magnitude between a bedroom and a train. So 1.5 s of the room is measured first
and every threshold is expressed over that floor. The statistic is a **median**,
because a door closing during calibration would drag a mean up permanently and
silently disarm the detector for the rest of the session.

That same 1.5 s window doubles as the proof that the audio graph is rendering
at all — a live microphone always has at least an LSB of noise, so a window in
which every sample is exactly `0.0` means capture never started, which is a
completely different fact from a quiet room.

### Two verdicts that never merge

The lesson `musie` paid a day to learn: **one predicate reporting two different
facts is the defect.** A microphone that opened and produced nothing was
indistinguishable from a quiet room, so the app told people they had gone
silent.

So there are two status chips and they may never be combined. The left one may
say nothing about breathing; the right one may say nothing about the
microphone. And `no breath detected yet` is **not an error** — it is this
spike's primary finding, and it is styled as one.

## What has already been measured

Not on a phone — through Chromium's fake capture device
(`--use-file-for-fake-audio-capture`) with synthesised signals, driving the real
app end to end. So these validate the **pipeline and the feature set**, and the
thresholds remain provisional until a real iPhone moves them.

- The chain works: permission, graph, 1.5 s calibration, floor, detection loop.
- Measured room floor **−82.3 dBFS**, IQR 1.2 dB, floor flatness **−3.5 dB** —
  close to the −2.5 dB theoretical noise ceiling, which validates that
  derivation independently.
- A 2.5 s synthetic exhale is detected as **one** breath of **2535 ms**.
- With a track playing and no acoustic path, the leak verdict is `none`, the
  detector arms in ~5 s, and nothing is reported as a fault.
- With a track playing, all three calibration phases run in order and detection
  still works. In the headless case the leak fit correctly reports r² ≈ 0.04 and
  refuses to subtract — see above.
- Synthesised voiced speech at a comparable level is **rejected**, by `lowRatio`
  *and* by detrended flatness.
- A steeply tilted smooth noise is **detected**, which the plain flatness
  measure got wrong — see above.

Two things theory got wrong, both recorded in `src/detect/config.ts`:

1. **Voiced speech reads −6.8 dB detrended flatness, not the −20 to −35 dB
   predicted.** At 23 Hz bins a 120 Hz F0 puts harmonics ~5 bins apart and the
   Blackman main lobe spans roughly ±3, so adjacent harmonics smear together
   and fill the nulls the prediction assumed. A larger `fftSize` would deepen
   them, at the cost of a longer window.
2. **The margins are thinner than they look.** `minLowRatio` separates breath
   from speech by 0.02, and `maxFlatnessDb` by about 0.3 dB. Each is affordable
   only because the other also rejects speech — a false positive must pass
   both gates.

## Inherited iOS findings

Measured in `musie`, not rediscovered here, and load-bearing:

- **A capturing document is exempt from WebKit's Web Audio autoplay gate**, so
  the `AudioContext` is constructed *after* the `getUserMedia` await. Moving
  that line earlier breaks iOS in a way no test here would catch.
- **`context.state` immediately after construction is `suspended` on every
  engine**, because rendering starts asynchronously. Reading it there proves
  nothing, so `resume()` is belt-and-braces and never throws.
- **A node only runs while connected to `destination`**, hence the zero-gain
  hop. The cost: capture is coupled to whatever iOS is doing with audio output.
- **`getUserMedia` can resolve with a track already `ended`**, and calls that
  success.
- iPhone 13 Pro and later tick `requestAnimationFrame` at **120 Hz**, so every
  smoothing coefficient derives from `dt` rather than from a frame count.

## Known limits, stated rather than discovered

- **It will trigger on whispering.** A whisper is acoustically a breath with a
  vocal tract on it.
- **It needs the phone near your mouth.** The low-frequency component only
  appears within ~15 cm. If it turns out to be absent at a natural holding
  distance, `minLowRatio` has to come out of the decision and the detector
  loses its only proximity evidence.
- **It cannot work backgrounded.** Features are sampled on
  `requestAnimationFrame`, which iOS stops when the page is hidden. For a
  biofeedback visual that is arguably correct — if you cannot see it there is
  nothing to drive — and a hidden page is reported as `paused`, not as a fault.
- **Coughs are the weak spot.** The 350 ms minimum duration rejects taps with
  certainty and most coughs; the flatness gate catches the rest only when the
  cough is voiced.
- **Speaker playback is unproven.** The subtraction is verified by unit test
  and the measurement refuses to lie when it cannot fit, but **no real acoustic
  leak has ever been through it** — a headless browser cannot produce one. The
  first phone session is where speaker mode is either viable or is not.
- **A Bluetooth headset mic breaks the sibilant rejector.** iOS routes capture
  to HFP, which is narrowband, so there is no 4–8 kHz band and a long `/s/`
  will read as a breath. The app warns when the capture rate drops below
  32 kHz.
- **Choosing the capture route may be impossible from a web page.** The app
  asks for the built-in microphone with an `exact` constraint and reports a
  refusal, but iOS may simply not allow it. That is a finding the first phone
  session returns, not something this repo can fix.
