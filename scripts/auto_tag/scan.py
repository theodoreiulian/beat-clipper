"""Local, label-blind dance tempo proposals. Never reads or writes the manifest.

Every audible soundtrack is analyzed independently of dancer movement.
Silent clips fall back to detailed visual tempo analysis. Human review is always required.
Confidence is an evidence score, not a calibrated probability of correctness.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

# Bound native thread pools: one scan runs at a time alongside the Vite server.
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '3')
import cv2
import numpy as np
from scipy import signal, ndimage

VERSION = 'beta-2'
ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / '.auto-tag'
MIN_BPM, MAX_BPM = 30.0, 300.0
BPM_GRID = np.arange(MIN_BPM, MAX_BPM + .125, .25)
JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]


def emit(stage: str, progress: float, message: str) -> None:
    print(json.dumps({'type': 'progress', 'stage': stage, 'progress': progress, 'message': message}), flush=True)


def number(x: float, digits=3):
    return round(float(x), digits) if np.isfinite(x) else 0.0


def normalized(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    if x.ndim == 1:
        x = x[:, None]
    if x.size == 0:
        return np.empty((x.shape[0], 0))
    x = np.nan_to_num(x)
    x = signal.detrend(x, axis=0)
    scale = np.std(x, axis=0)
    return x[:, scale > 1e-7] / np.maximum(scale[scale > 1e-7], 1e-7)


def spectrum(x: np.ndarray, rate: float, bpms=BPM_GRID) -> np.ndarray:
    """Multi-channel, normalized sinusoidal evidence, with no tempo-label prior."""
    x = normalized(x)
    if len(x) < 8 or x.shape[1] == 0:
        return np.zeros(len(bpms))
    times = np.arange(len(x)) / rate
    window = np.hanning(len(x))
    weighted = x * window[:, None]
    # Chunk the matrix to keep a 60-second audio scan comfortably bounded.
    power = []
    for chunk in np.array_split(np.asarray(bpms), max(1, len(bpms) // 100)):
        z = np.exp(-2j * np.pi * chunk[:, None] / 60 * times[None, :]) @ weighted
        p = np.abs(z) ** 2 / max(1, np.sum(window) ** 2)
        power.append(np.mean(np.sort(p, axis=1)[:, -min(8, p.shape[1]):], axis=1))
    return np.concatenate(power)


def autocorrelation_curve(x: np.ndarray, rate: float, bpms=BPM_GRID) -> np.ndarray:
    x = normalized(x)
    if x.size == 0:
        return np.zeros(len(bpms))
    ac = signal.fftconvolve(x, x[::-1], mode='full', axes=0)[len(x) - 1:]
    ac /= np.maximum(np.arange(len(x), 0, -1)[:, None], 1)
    ac /= np.maximum(ac[0], 1e-8)
    lags = 60 * rate / np.asarray(bpms)
    values = np.stack([np.interp(lags, np.arange(len(ac)), col, left=0, right=0) for col in ac.T], axis=1)
    return np.maximum(0, np.mean(np.sort(values, axis=1)[:, -min(8, values.shape[1]):], axis=1))


def motion_curves(features: np.ndarray, rate: float):
    # Slow changes of stance dominate raw pose spectra but are not dance beats.
    x = normalized(features)
    x = signal.sosfiltfilt(signal.butter(3, .7, btype='highpass', fs=rate, output='sos'), x, axis=0)
    velocity = np.abs(np.gradient(ndimage.gaussian_filter1d(x, .07 * rate, axis=0), axis=0)) * rate
    events = np.zeros_like(velocity)
    for j in range(velocity.shape[1]):
        indices, props = signal.find_peaks(-velocity[:, j], prominence=max(.01, np.std(velocity[:, j]) * .2), distance=max(1, int(rate * .2)))
        events[indices, j] = props['prominences']
    # Kinematic beats: stops/reversals of joint motion. Both event recurrence and
    # Fourier evidence must contribute; no single largest slow limb wins outright.
    components = [spectrum(events, rate), autocorrelation_curve(events, rate), spectrum(x, rate), spectrum(x, rate, BPM_GRID / 2), spectrum(np.mean(velocity, axis=1), rate)]
    weights = [.35, .2, .1, .2, .15]
    curve = sum(w * c / max(np.max(c), 1e-8) for w, c in zip(weights, components))
    return curve, np.sum(events, axis=1), x


def phase_offset(envelope: np.ndarray, rate: float, bpm: float, start=0.) -> float:
    """Fold transient/motion accents onto the grid; never use first sound as phase."""
    period = 60 / bpm
    env = np.maximum(np.asarray(envelope).ravel(), 0)
    if not len(env) or np.sum(env) <= 1e-8:
        return float(start % period)
    bins = 256
    phase = ((np.arange(len(env)) / rate + start) % period) / period
    hist = np.bincount((phase * bins).astype(int).clip(0, bins - 1), weights=env, minlength=bins)
    hist = ndimage.gaussian_filter1d(hist, max(1, .025 / period * bins), mode='wrap')
    return float(np.argmax(hist) / bins * period)


def ranked_tempos(features: np.ndarray, rate: float, energy=None, start=0., power_override=None) -> dict:
    x = normalized(features)
    if len(x) < rate * 2 or x.shape[1] == 0:
        return {'candidates': [], 'confidence': 0., 'stability': 0., 'strength': 0.}
    if power_override is not None:
        power = np.asarray(power_override)
        envelope = np.mean(np.maximum(x, 0), axis=1)
    elif energy is not None:
        power, envelope, x = motion_curves(x, rate)
    else:
        fourier = spectrum(x, rate)
        ac = autocorrelation_curve(x, rate)
        power = .45 * fourier / max(np.max(fourier), 1e-9) + .55 * ac / max(np.max(ac), 1e-9)
        envelope = np.mean(np.maximum(x, 0), axis=1)
    peaks, _ = signal.find_peaks(power, distance=12)
    if not len(peaks):
        return {'candidates': [], 'confidence': 0., 'stability': 0., 'strength': 0.}
    # A broad, disclosed convention preference resolves otherwise equal octave peaks.
    # No saved tag, filename, genre or benchmark target enters this calculation.
    prior = np.ones_like(BPM_GRID) if power_override is not None else .4 + .6 * np.exp(-.5 * (np.log2(BPM_GRID / 125) / .65) ** 2)
    order = sorted(peaks, key=lambda i: power[i] * prior[i], reverse=True)
    candidates = []
    for i in order:
        bpm = float(BPM_GRID[i])
        if any(abs(c['bpm'] - bpm) < 3 for c in candidates):
            continue
        # Refine the peak by local parabolic interpolation (not an integer BPM).
        if 0 < i < len(power) - 1:
            den = power[i - 1] - 2 * power[i] + power[i + 1]
            if abs(den) > 1e-10:
                bpm += float(np.clip(.5 * (power[i - 1] - power[i + 1]) / den, -1, 1)) * .25
        candidates.append({'bpm': number(bpm), 'offset': number(phase_offset(envelope, rate, bpm, start), 4), 'score': number(power[i] / max(np.max(power), 1e-9))})
        if len(candidates) == 6:
            break
    top = candidates[0]
    # Compare independent temporal sections. Short clips cannot supply this evidence.
    duration = len(x) / rate
    matches = []
    if duration >= 6:
        width = min(len(x) // 2, int(rate * 8))
        for lo in [0, (len(x) - width) // 2, len(x) - width]:
            local = motion_curves(x[lo:lo + width], rate)[0] if energy is not None else spectrum(x[lo:lo + width], rate)
            near = np.abs(BPM_GRID - top['bpm']) < max(3, top['bpm'] * .035)
            matches.append(float(np.max(local[near]) / max(np.max(local), 1e-9)))
    stability = float(np.mean(matches)) if matches else .35
    strength = float(np.clip((power[order[0]] - np.median(power)) / max(power[order[0]], 1e-8), 0, 1))
    confidence = strength * (.45 + .55 * stability) * min(1, duration * top['bpm'] / 60 / 8)
    return {'candidates': candidates, 'confidence': number(confidence), 'stability': number(stability), 'strength': number(strength)}


def refine_audio_grid(envelope: np.ndarray, rate: float, candidate: dict, start: float) -> dict:
    """Fit observed musical transients to a regular clock to remove spectral-bin bias."""
    period, offset = 60 / candidate['bpm'], candidate['offset']
    peaks, _ = signal.find_peaks(envelope, distance=max(1, round(rate * .08)), prominence=max(1e-8, np.std(envelope) * .15))
    times = peaks / rate + start
    indices = np.rint((times - offset) / period).astype(int)
    residual = np.abs(times - (offset + indices * period))
    keep = residual < min(.065, period * .18)
    times, indices, weights = times[keep], indices[keep], envelope[peaks[keep]]
    # One onset per beat: a kick and snare/flam must not count as two observations.
    chosen = [np.flatnonzero(indices == k)[np.argmax(weights[indices == k])] for k in np.unique(indices)]
    times, indices, weights = times[chosen], indices[chosen], weights[chosen]
    if len(times) < 6 or np.ptp(indices) < 6:
        return candidate
    for _ in range(3):
        if len(times) < 6:
            return candidate
        slope, intercept = np.polyfit(indices, times, 1, w=np.sqrt(np.maximum(weights, 1e-8)))
        errors = np.abs(times - (intercept + indices * slope))
        keep = errors <= max(.018, min(.05, float(np.median(errors)) * 3))
        if np.all(keep):
            break
        times, indices, weights = times[keep], indices[keep], weights[keep]
    if slope <= 0 or abs(slope / period - 1) > .02 or not MIN_BPM <= 60 / slope <= MAX_BPM:
        return candidate
    return {**candidate, 'bpm': number(60 / slope), 'offset': number(intercept % slope, 4)}


def audio_analysis(path: Path, start: float, duration: float) -> tuple[dict, np.ndarray | None, float]:
    import librosa
    rate, hop = 22050, 256
    command = ['ffmpeg', '-nostdin', '-v', 'error', '-ss', str(start), '-i', str(path), '-t', str(duration), '-vn', '-ac', '1', '-ar', str(rate), '-f', 'f32le', 'pipe:1']
    p = subprocess.run(command, capture_output=True, timeout=90)
    if p.returncode or not p.stdout:
        return {'available': False, 'reason': 'No decodable audio track', 'candidates': [], 'confidence': 0}, None, rate / hop
    y = np.frombuffer(p.stdout, dtype='<f4').copy()
    if not len(y) or float(np.max(np.abs(y))) < 5e-5:
        return {'available': False, 'reason': 'Audio is silent', 'candidates': [], 'confidence': 0}, None, rate / hop
    if len(y) < 2 * rate:
        return {'available': True, 'reason': 'Soundtrack is too short to establish a steady BPM', 'candidates': [], 'confidence': 0}, None, rate / hop
    mel = librosa.feature.melspectrogram(y=y, sr=rate, n_fft=2048, hop_length=hop, n_mels=96)
    db = librosa.power_to_db(mel, ref=np.max)
    # Low, middle and upper spectral flux, separately whitened so a loud vocal
    # cannot drown every drum onset. Median local flooring suppresses steady noise.
    bands = []
    for lo, hi in [(0, 18), (18, 48), (48, 96)]:
        env = librosa.onset.onset_strength(S=db[lo:hi], sr=rate, hop_length=hop, lag=1, max_size=3)
        env = np.maximum(0, env - ndimage.median_filter(env, size=31) * .5)
        bands.append(env)
    features = np.stack(bands, axis=1)
    envelope_rate = rate / hop
    fourier = spectrum(features, envelope_rate)
    recurrence = autocorrelation_curve(features, envelope_rate)
    curve = .45 * fourier / max(np.max(fourier), 1e-9) + .55 * recurrence / max(np.max(recurrence), 1e-9)
    # Log-band whitening makes quiet hi-hats as salient as loud kicks. Preserve
    # physical low-band dynamics as independent evidence for the main pulse so
    # eighth-note hats don't automatically double the reported musical BPM.
    bass_fraction = float(np.sum(mel[:8]) / max(np.sum(mel), 1e-9))
    if bass_fraction >= .02:
        bass = np.mean(np.sqrt(mel[:8]), axis=0)
        bass_onsets = np.maximum(0, np.diff(bass, prepend=bass[0]))
        bass_fourier = spectrum(bass_onsets, envelope_rate)
        bass_recurrence = autocorrelation_curve(bass_onsets, envelope_rate)
        bass_curve = .35 * bass_fourier / max(np.max(bass_fourier), 1e-9) + .65 * bass_recurrence / max(np.max(bass_recurrence), 1e-9)
        curve = .55 * curve + .45 * bass_curve
    summary = ranked_tempos(features, envelope_rate, start=start, power_override=curve)
    env = np.mean(features / np.maximum(np.std(features, axis=0), 1e-8), axis=1)
    for candidate in summary['candidates']:
        candidate['offset'] = number(phase_offset(env, rate / hop, candidate['bpm'], start), 4)
        candidate.update(refine_audio_grid(env, rate / hop, candidate, start))
    return {'available': True, **summary}, env, rate / hop


def pose_features(path: Path, start: float, duration: float, quick: bool) -> tuple[np.ndarray, np.ndarray, float, dict]:
    import mediapipe as mp
    rate = 12. if quick else 24.
    model = RUNTIME / 'models' / f'pose_landmarker_{"lite" if quick else "full"}.task'
    stat = path.stat()
    key = hashlib.sha256(f'pose-stabilized-v2|{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}|{start}|{duration}|{quick}|stabilized-v2'.encode()).hexdigest()
    cache = RUNTIME / 'features' / f'{key}.npz'
    if cache.exists():
        with np.load(cache, allow_pickle=False) as saved:
            return saved['features'], saved['energy'], float(saved['rate']), json.loads(str(saved['quality']))
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model), delegate=mp.tasks.BaseOptions.Delegate.CPU),
        running_mode=mp.tasks.vision.RunningMode.VIDEO, num_poses=2 if quick else 3,
        min_pose_detection_confidence=.45, min_pose_presence_confidence=.45, min_tracking_confidence=.5)
    cap = cv2.VideoCapture(str(path))
    fps = float(cap.get(cv2.CAP_PROP_FPS))
    if not cap.isOpened() or not np.isfinite(fps) or fps <= 0:
        cap.release()
        raise RuntimeError('Cannot decode video frames')
    rate = min(rate, fps)
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    frame_index = 0
    next_sample = 0.
    rows, times, visibility = [], [], []
    prev_center = None
    previous_gray, previous_mask = None, None
    camera_shift = np.zeros(2)
    body_centers, body_scales, camera_valid = [], [], []
    switches = 0
    last_progress = 0.
    try:
        with mp.tasks.vision.PoseLandmarker.create_from_options(options) as tracker:
            while frame_index / fps < duration:
                if not cap.grab():
                    break
                t = frame_index / fps
                frame_index += 1
                if t + .5 / fps < next_sample:
                    continue
                next_sample += 1 / rate
                ok, frame = cap.retrieve()
                if not ok:
                    break
                h, w = frame.shape[:2]
                if max(h, w) > 640:
                    frame = cv2.resize(frame, (round(w * 640 / max(h, w)), round(h * 640 / max(h, w))))
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                camera_ok = previous_gray is None
                if previous_gray is not None:
                    corners = cv2.goodFeaturesToTrack(previous_gray, maxCorners=100, qualityLevel=.02, minDistance=7, mask=previous_mask)
                    if corners is not None and len(corners) >= 8:
                        tracked, good, _ = cv2.calcOpticalFlowPyrLK(previous_gray, gray, corners, None)
                        if tracked is not None and good is not None and np.sum(good) >= 8:
                            displacement = (tracked - corners).reshape(-1, 2)[good.ravel() == 1]
                            median = np.median(displacement, axis=0)
                            if np.mean(np.linalg.norm(displacement - median, axis=1) < 3) >= .65:
                                camera_shift += median / frame.shape[0]
                                camera_ok = True
                camera_valid.append(camera_ok)
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result = tracker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)), max(0, round((start + t) * 1000)))
                chosen = None
                best = -1e9
                for pose in result.pose_landmarks:
                    p = np.array([[v.x * w / h, v.y, v.visibility] for v in pose])
                    center = (p[23, :2] + p[24, :2]) / 2
                    size = np.linalg.norm((p[11, :2] + p[12, :2]) / 2 - center)
                    track_distance = np.linalg.norm(center - prev_center) if prev_center is not None else 0.
                    score = np.mean(p[JOINTS, 2]) + min(size, .6) - 2 * track_distance - .2 * abs(center[0] - w / h / 2)
                    if score > best:
                        best, chosen = score, p
                if chosen is None:
                    rows.append(np.full((len(JOINTS), 2), np.nan));visibility.append(0.)
                    body_centers.append([np.nan, np.nan]);body_scales.append(np.nan)
                    previous_mask = np.full(gray.shape, 255, dtype=np.uint8)
                else:
                    center = (chosen[23, :2] + chosen[24, :2]) / 2
                    if prev_center is not None and np.linalg.norm(center - prev_center) > .35:
                        switches += 1
                    prev_center = center
                    torso = max(.04, np.linalg.norm((chosen[11, :2] + chosen[12, :2]) / 2 - center))
                    relative = chosen[JOINTS, :2] - center
                    relative[chosen[JOINTS, 2] < .5] = np.nan
                    # Torso-relative coordinates remove pan/zoom. Absolute camera
                    # motion and scene-wide pixel differences are never tempo evidence.
                    rows.append(relative)
                    body_scales.append(torso)
                    shoulder = (chosen[11, :2] + chosen[12, :2]) / 2
                    body_centers.append(shoulder - camera_shift if camera_ok and min(chosen[11, 2], chosen[12, 2]) > .65 else [np.nan, np.nan])
                    previous_mask = np.full(gray.shape, 255, dtype=np.uint8)
                    observed = chosen[chosen[:, 2] > .5, :2] * frame.shape[0]
                    if len(observed):
                        lower = np.maximum(0, np.min(observed, axis=0) - 25).astype(int)
                        upper = np.minimum([frame.shape[1], frame.shape[0]], np.max(observed, axis=0) + 25).astype(int)
                        previous_mask[lower[1]:upper[1], lower[0]:upper[0]] = 0
                    visibility.append(float(np.mean(chosen[JOINTS, 2] > .5)))
                previous_gray = gray
                times.append(t)
                if t - last_progress > 1.5:
                    emit('quick-motion' if quick else 'visual', .18 + .65 * t / duration, f'{"Checking dance/music agreement" if quick else "Tracking body movement"} · {t:.0f}/{duration:.0f}s')
                    last_progress = t
    finally:
        cap.release()
    if len(rows) < 8:
        return np.empty((0, 0)), np.array([]), rate, {'coverage': 0., 'duration': 0., 'trackSwitches': switches}
    raw = np.asarray(rows).reshape(len(rows), -1)
    scales = np.asarray(body_scales)
    valid_scales = np.isfinite(scales)
    if np.any(valid_scales):
        scales = np.interp(np.arange(len(scales)), np.flatnonzero(valid_scales), scales[valid_scales])
        scales = ndimage.median_filter(scales, size=max(3, int(rate) | 1))
        raw /= np.maximum(scales[:, None], .04)
        # Camera-compensated body bounce preserves a pulse that torso-relative
        # limbs alone lose. Use it only when the background was independently tracked.
        if np.mean(camera_valid) >= .65:
            raw = np.column_stack([raw, np.asarray(body_centers) / max(float(np.median(scales)), .04)])
    times = np.asarray(times)
    uniform = np.arange(0, times[-1] + .1 / rate, 1 / rate)
    features = []
    feature_coverage = []
    for col in raw.T:
        valid = np.isfinite(col)
        if np.mean(valid) < .65:
            continue
        # Do not bridge long occlusions as if they were observed dance motion.
        gaps = np.diff(np.r_[0, np.flatnonzero(valid), len(col) - 1])
        if np.max(gaps) / rate > 1.:
            continue
        filled = np.interp(uniform, times[valid], col[valid])
        filled = ndimage.gaussian_filter1d(filled, .04 * rate)
        if np.std(filled) < .018:
            continue
        features.append(filled)
        feature_coverage.append(float(np.mean(valid)))
    if not features:
        return np.empty((0, 0)), np.array([]), rate, {'coverage': number(np.mean(visibility)), 'duration': number(times[-1]), 'trackSwitches': switches, 'channels': 0}
    features = np.stack(features, axis=1)
    features = np.clip(features, -5, 5)
    velocity = np.abs(np.gradient(features, axis=0) * rate)
    scales = np.maximum(np.percentile(velocity, 85, axis=0), .1)
    energy = np.mean(np.minimum(velocity / scales, 3), axis=1)
    quality = {'coverage': number(np.mean(visibility)), 'duration': number(times[-1]), 'trackSwitches': switches, 'channels': features.shape[1]}
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, features=features, energy=energy, rate=rate, quality=json.dumps(quality))
    return features, energy, rate, quality


def soundtrack_result(audio: dict, analyzed_seconds: float, began: float) -> dict:
    candidates = audio.get('candidates', [])
    selected = candidates[0] if candidates else None
    evidence = float(audio.get('confidence', 0))
    warnings = []
    if not audio.get('available'):
        warnings.append(audio.get('reason', 'No audible soundtrack.'))
    elif not selected:
        warnings.append('The soundtrack has no measurable steady pulse. Set a grid manually after listening.')
    elif evidence < .5:
        warnings.append('The musical pulse is uncertain. A best estimate is shown; listen and check the alternatives before approving.')
    if analyzed_seconds < 6:
        warnings.append('Short soundtrack: verify tempo and half/double-time alternatives carefully.')
    ambiguous = bool(candidates and any(c['score'] > .7 * selected['score'] and min(abs(c['bpm'] / selected['bpm'] - .5), abs(c['bpm'] / selected['bpm'] - 2)) < .05 for c in candidates[1:]))
    if ambiguous:
        warnings.append('A half/double-time pulse is also plausible; choose the musical beat you hear.')
    return {'version': VERSION, 'status': 'suggested' if selected else 'needs-manual',
            'bpm': selected['bpm'] if selected else None, 'offset': selected['offset'] if selected else None,
            'method': 'audio', 'confidence': 'high' if evidence >= .8 and analyzed_seconds >= 8 and not ambiguous else 'medium' if evidence >= .5 else 'low',
            'evidenceScore': number(evidence), 'candidates': candidates, 'audio': audio,
            'warnings': warnings, 'analyzedSeconds': number(analyzed_seconds), 'elapsedSeconds': number(time.monotonic() - began)}


def analyze_clip(path: Path, start=0., end=None, audio_only=False) -> dict:
    began = time.monotonic()
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS); count = cap.get(cv2.CAP_PROP_FRAME_COUNT); cap.release()
    total = count / fps if fps > 0 else 0
    if not np.isfinite(total) or total <= 0:
        raise RuntimeError('Video duration could not be read')
    start = max(0., start)
    end = min(total, end if end is not None else total)
    duration = min(60., end - start)
    # Measure the entire source soundtrack, even when the chosen usable window is
    # short or silent. Offsets remain in absolute source-video time (start=0).
    # No pose/visibility, dance agreement or confidence gate may suppress this grid.
    emit('audio', .05, 'Measuring the full soundtrack BPM and beat timing')
    audio, _, _ = audio_analysis(path, 0., total)
    if audio.get('available') or audio_only:
        result = soundtrack_result(audio, total, began)
        emit('complete', 1., 'Soundtrack grid ready for human review' if result['bpm'] else 'No steady soundtrack pulse detected')
        return result
    if duration < 2.5:
        return {'version': VERSION, 'status': 'needs-manual', 'bpm': None, 'offset': None, 'method': 'visual', 'confidence': 'low', 'evidenceScore': 0., 'candidates': [], 'audio': audio,
                'warnings': ['No audible soundtrack and fewer than 2.5 seconds of usable footage; tap this clip manually.'], 'analyzedSeconds': number(max(0, duration)), 'elapsedSeconds': number(time.monotonic() - began)}
    emit('visual', .15, 'No audible soundtrack; running detailed movement analysis')
    features, energy, rate, quality = pose_features(path, start, duration, False)
    motion = ranked_tempos(features, rate, energy, start)
    evidence = min(.7, motion['confidence'] * min(1., quality.get('coverage', 0) / .8))
    if quality.get('channels', 0) < 6:
        evidence *= .35
    evidence *= max(.5, 1 - quality.get('trackSwitches', 0) * .06)
    candidates = motion['candidates']
    warnings = ['No audible soundtrack. The grid is estimated from movement; verify tempo and phase manually.']
    if end - start > 60:
        warnings.append('Only the first 60 seconds of the usable window were analyzed for movement.')
    if quality.get('coverage', 0) < .65:
        warnings.append('Body tracking is incomplete or occluded; this estimate may follow the wrong movement.')
    if quality.get('trackSwitches', 0) >= 3:
        warnings.append('The main dancer changed or the camera cut; a single tempo may not fit.')
    if duration < 6:
        warnings.append('Short clip: too few independent movement cycles to establish a stable tempo.')
    warnings.append('Movement alone cannot always distinguish a beat from a half/double-time dance cycle. Check alternatives and grid phase.')
    usable = bool(candidates) and evidence >= .5 and quality.get('coverage', 0) >= .55
    selected = candidates[0] if usable else None
    if not usable:
        warnings.insert(0, 'Movement evidence is too weak to preselect a grid. Tap manually or audition the exploratory candidates.')
    emit('complete', 1., 'Suggestion ready for human review' if usable else 'Manual tagging recommended')
    return {'version': VERSION, 'status': 'suggested' if usable else 'needs-manual', 'bpm': selected['bpm'] if selected else None, 'offset': selected['offset'] if selected else None,
            'method': 'visual', 'confidence': 'medium' if evidence >= .5 else 'low', 'evidenceScore': number(evidence), 'candidates': candidates, 'audio': audio, 'motion': motion,
            'tracking': quality, 'warnings': warnings, 'analyzedSeconds': number(duration), 'elapsedSeconds': number(time.monotonic() - began)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--file', type=Path)
    parser.add_argument('--start', type=float, default=0.)
    parser.add_argument('--end', type=float)
    parser.add_argument('--audio-only', action='store_true')
    args = parser.parse_args()
    if args.check:
        import mediapipe
        import librosa
        for variant in ['full']:
            if not (RUNTIME / 'models' / f'pose_landmarker_{variant}.task').is_file():
                raise RuntimeError(f'Missing {variant} pose model; run npm run setup:auto-tag')
        subprocess.run(['ffmpeg', '-version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        print(json.dumps({'type': 'ready', 'version': VERSION}))
        return
    if not args.file:
        parser.error('--file is required')
    result = analyze_clip(args.file, args.start, args.end, args.audio_only)
    print(json.dumps({'type': 'result', 'result': result}, allow_nan=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'type': 'error', 'message': str(error)}), flush=True)
        sys.exit(1)
