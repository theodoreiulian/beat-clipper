import tempfile
import json
import unittest
import wave
from unittest.mock import patch
from pathlib import Path
import numpy as np
import scan


def dancing(bpm=120, seconds=16, rate=24):
    t = np.arange(int(seconds * rate)) / rate
    x = np.stack([np.sin(2 * np.pi * bpm / 120 * t + phase) for phase in np.linspace(0, .15, 8)], axis=1)
    return x, np.mean(np.abs(np.gradient(x, axis=0)), axis=1), rate


class Capture:
    def get(self, prop): return 24 if prop == scan.cv2.CAP_PROP_FPS else 384
    def release(self): pass


def audio_evidence(bpm=153, confidence=.9):
    return {'available': True, 'confidence': confidence, 'candidates': [{'bpm': bpm, 'offset': .1, 'score': 1}]}, None, 86


class DetectionTests(unittest.TestCase):
    def test_kinematic_periodicity_recovers_a_known_pulse(self):
        for bpm in [90, 120, 155, 190]:
            with self.subTest(bpm=bpm):
                x, energy, rate = dancing(bpm)
                result = scan.ranked_tempos(x, rate, energy)
                self.assertTrue(any(abs(c['bpm'] - bpm) < 3 for c in result['candidates'][:3]), result)

    def test_folded_phase_uses_absolute_clip_time(self):
        env = np.zeros(1000); env[np.arange(12, 1000, 50)] = 1
        self.assertAlmostEqual(scan.phase_offset(env, 100, 120, start=1.1), .22, delta=.025)

    def test_music_always_preselects_its_grid_without_any_pose_gate(self):
        for confidence in [.1, .9]:
            with self.subTest(confidence=confidence), patch.object(scan.cv2, 'VideoCapture', return_value=Capture()), patch.object(scan, 'audio_analysis', return_value=audio_evidence(confidence=confidence)), patch.object(scan, 'pose_features', side_effect=AssertionError('Music must not need a visible dancer')):
                result = scan.analyze_clip(Path('music-over-unrelated-dance.mp4'))
                self.assertEqual(result['bpm'], 153)
                self.assertEqual(result['offset'], .1)
                self.assertEqual(result['method'], 'audio')
                self.assertEqual(result['status'], 'suggested')

    def test_music_is_measured_across_source_even_for_a_short_or_silent_trim(self):
        path = Path('music.mp4')
        with patch.object(scan.cv2, 'VideoCapture', return_value=Capture()), patch.object(scan, 'audio_analysis', return_value=audio_evidence()) as analyze, patch.object(scan, 'pose_features', side_effect=AssertionError()):
            result = scan.analyze_clip(path, start=10, end=11)
            analyze.assert_called_once_with(path, 0., 16.)
            self.assertEqual(result['bpm'], 153)

    def test_no_steady_musical_pulse_does_not_invent_a_bpm_or_use_dance_instead(self):
        with patch.object(scan.cv2, 'VideoCapture', return_value=Capture()), patch.object(scan, 'audio_analysis', return_value=({'available': True, 'confidence': 0, 'candidates': []}, None, 86)), patch.object(scan, 'pose_features', side_effect=AssertionError()):
            result = scan.analyze_clip(Path('ambient.mp4'))
            self.assertEqual(result['method'], 'audio')
            self.assertEqual(result['status'], 'needs-manual')
            self.assertIsNone(result['bpm'])

    def test_soundtrack_batch_skips_silent_clips_without_pose_analysis(self):
        with patch.object(scan.cv2, 'VideoCapture', return_value=Capture()), patch.object(scan, 'audio_analysis', return_value=({'available': False, 'confidence': 0, 'candidates': []}, None, 86)), patch.object(scan, 'pose_features', side_effect=AssertionError()):
            result = scan.analyze_clip(Path('silent.mp4'), audio_only=True)
            self.assertFalse(result['audio']['available'])
            self.assertIsNone(result['bpm'])

    def test_empty_and_stationary_motion_do_not_produce_a_tempo(self):
        for x in [np.empty((0, 0)), np.zeros((200, 8))]:
            self.assertEqual(scan.ranked_tempos(x, 24, np.zeros(len(x)))['candidates'], [])

    def test_missing_subject_produces_manual_only_result_for_silent_video(self):
        with patch.object(scan.cv2, 'VideoCapture', return_value=Capture()), patch.object(scan, 'audio_analysis', return_value=({'available': False, 'candidates': [], 'confidence': 0}, None, 86)), patch.object(scan, 'pose_features', return_value=(np.empty((0, 0)), np.array([]), 24, {'coverage': 0., 'duration': 10, 'channels': 0, 'trackSwitches': 0})):
            result = scan.analyze_clip(Path('fake.mp4'))
            self.assertEqual(result['status'], 'needs-manual')
            self.assertIsNone(result['bpm'])

    def test_weak_silent_motion_candidates_are_not_preselected(self):
        x, energy, rate = dancing(120)
        weak = {'confidence': .3, 'stability': .7, 'strength': .3, 'candidates': [{'bpm': 120, 'offset': .1, 'score': 1}]}
        with patch.object(scan.cv2, 'VideoCapture', return_value=Capture()), patch.object(scan, 'audio_analysis', return_value=({'available': False, 'candidates': [], 'confidence': 0}, None, 86)), patch.object(scan, 'pose_features', return_value=(x, energy, rate, {'coverage': .98, 'channels': 8, 'duration': 16, 'trackSwitches': 0})), patch.object(scan, 'ranked_tempos', return_value=weak):
            result = scan.analyze_clip(Path('fake.mp4'))
            self.assertEqual(result['status'], 'needs-manual')
            self.assertIsNone(result['bpm'])
            self.assertEqual(result['candidates'][0]['bpm'], 120)


class SoundtrackAccuracyTests(unittest.TestCase):
    def test_known_music_tempos_and_phase_from_actual_decoded_audio(self):
        # Known audio truth, independent of the saved dance BPMs. Exercise FFmpeg
        # decoding, multi-band onset detection, tempo refinement and grid phase.
        rate, duration, onset = 22050, 14., .37
        rng = np.random.default_rng(71)
        results = []
        with tempfile.TemporaryDirectory() as directory:
            cases = [(bpm, 1., .37) for bpm in [60, 80, 100, 128, 156.3, 191, 220]] + [(128, .001, .37), (100, 1., 2.37)]
            for bpm, volume, onset in cases:
                with self.subTest(bpm=bpm, volume=volume, onset=onset):
                    y = np.zeros(round(rate * duration))
                    period = 60 / bpm
                    for beat, t in enumerate(np.arange(onset, duration - .15, period)):
                        n = round(.12 * rate); local = np.arange(n) / rate
                        pulse = .65 * np.cos(2 * np.pi * 75 * local) * np.exp(-local * 45)
                        if beat % 2: pulse += .16 * rng.normal(size=n) * np.exp(-local * 65)
                        lo = round(t * rate); y[lo:lo+n] += pulse
                        off = round((t + period / 2) * rate); n_hat = round(.025 * rate)
                        if off + n_hat < len(y): y[off:off+n_hat] += .07 * rng.normal(size=n_hat) * np.exp(-np.arange(n_hat) / rate * 180)
                    path = Path(directory) / f'music-{bpm}.wav'
                    with wave.open(str(path), 'wb') as wav:
                        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(rate)
                        wav.writeframes((np.clip(y * volume, -1, 1) * 32767).astype('<i2').tobytes())
                    actual, _, _ = scan.audio_analysis(path, 0, duration)
                    self.assertTrue(actual['available'])
                    self.assertTrue(actual['candidates'])
                    candidate = actual['candidates'][0]
                    self.assertAlmostEqual(candidate['bpm'], bpm, delta=.25, msg=str(actual))
                    error = abs((candidate['offset'] - onset + period / 2) % period - period / 2)
                    self.assertLess(error, .06, str(candidate))
                    results.append({'expectedBpm': bpm, 'estimatedBpm': candidate['bpm'], 'tempoError': round(abs(candidate['bpm'] - bpm), 4), 'phaseErrorMs': round(error * 1000, 2), 'volume': volume, 'firstBeat': onset})
        print('SOUNDTRACK_CHECKS=' + json.dumps(results))


if __name__ == '__main__':
    unittest.main()
