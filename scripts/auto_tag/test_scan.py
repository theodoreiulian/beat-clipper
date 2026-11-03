import unittest
from unittest.mock import patch
from pathlib import Path
import numpy as np
import scan


def dancing(bpm=120, seconds=16, rate=24):
    t = np.arange(int(seconds * rate)) / rate
    # A complete body/limb cycle spans two beats; its reversals mark the pulse.
    x = np.stack([np.sin(2 * np.pi * bpm / 120 * t + phase) for phase in np.linspace(0, .15, 8)], axis=1)
    return x, np.mean(np.abs(np.gradient(x, axis=0)), axis=1), rate


class DetectionTests(unittest.TestCase):
    def test_kinematic_periodicity_recovers_a_known_pulse(self):
        for bpm in [90, 120, 155, 190]:
            with self.subTest(bpm=bpm):
                x, energy, rate = dancing(bpm)
                result = scan.ranked_tempos(x, rate, energy)
                self.assertTrue(any(abs(c['bpm'] - bpm) < 3 for c in result['candidates'][:3]), result)

    def test_folded_phase_uses_absolute_clip_time(self):
        rate = 100
        env = np.zeros(1000)
        env[np.arange(12, 1000, 50)] = 1
        phase = scan.phase_offset(env, rate, 120, start=1.1)
        self.assertAlmostEqual(phase, .22, delta=.025)

    def test_unrelated_audio_is_not_selected_just_because_it_exists(self):
        x, energy, rate = dancing(110)
        motion = scan.ranked_tempos(x, rate, energy)
        audio = {'available': True, 'confidence': .9, 'candidates': [{'bpm': 153, 'offset': 0, 'score': 1}]}
        agreement = scan.alignment_check(audio, motion, x, rate, {'coverage': .98, 'channels': 8, 'trackSwitches': 0})
        self.assertFalse(agreement['plausible'], agreement)

    def test_matching_audio_requires_visible_stable_movement(self):
        x, energy, rate = dancing(120)
        motion = scan.ranked_tempos(x, rate, energy)
        audio = {'available': True, 'confidence': .9, 'candidates': [{'bpm': 120, 'offset': .1, 'score': 1}]}
        agreement = scan.alignment_check(audio, motion, x, rate, {'coverage': .98, 'channels': 8, 'trackSwitches': 0})
        self.assertTrue(agreement['plausible'], (agreement, motion))
        agreement = scan.alignment_check(audio, motion, x, rate, {'coverage': .3, 'channels': 8, 'trackSwitches': 0})
        self.assertFalse(agreement['plausible'])

    def test_empty_and_stationary_motion_do_not_produce_a_tempo(self):
        for x in [np.empty((0, 0)), np.zeros((200, 8))]:
            result = scan.ranked_tempos(x, 24, np.zeros(len(x)))
            self.assertEqual(result['candidates'], [])

    def test_missing_subject_produces_manual_only_result(self):
        class Capture:
            def get(self, _): return 24 if _ == scan.cv2.CAP_PROP_FPS else 240
            def release(self): pass
        with patch.object(scan.cv2, 'VideoCapture', return_value=Capture()), patch.object(scan, 'audio_analysis', return_value=({'available': False, 'candidates': [], 'confidence': 0}, None, 86)), patch.object(scan, 'pose_features', return_value=(np.empty((0, 0)), np.array([]), 24, {'coverage': 0., 'duration': 10, 'channels': 0, 'trackSwitches': 0})):
            result = scan.analyze_clip(Path('fake.mp4'))
            self.assertEqual(result['status'], 'needs-manual')
            self.assertIsNone(result['bpm'])

    def test_weak_candidates_are_not_preselected(self):
        class Capture:
            def get(self, _): return 24 if _ == scan.cv2.CAP_PROP_FPS else 384
            def release(self): pass
        x, energy, rate = dancing(120)
        weak = {'confidence': .3, 'stability': .7, 'strength': .3, 'candidates': [{'bpm': 120, 'offset': .1, 'score': 1}]}
        with patch.object(scan.cv2, 'VideoCapture', return_value=Capture()), patch.object(scan, 'audio_analysis', return_value=({'available': False, 'candidates': [], 'confidence': 0}, None, 86)), patch.object(scan, 'pose_features', return_value=(x, energy, rate, {'coverage': .98, 'channels': 8, 'duration': 16, 'trackSwitches': 0})), patch.object(scan, 'ranked_tempos', return_value=weak):
            result = scan.analyze_clip(Path('fake.mp4'))
            self.assertEqual(result['status'], 'needs-manual')
            self.assertIsNone(result['bpm'])
            self.assertEqual(result['candidates'][0]['bpm'], 120)

    def test_supporting_audio_takes_quick_path_and_mismatch_forces_dense_pass(self):
        class Capture:
            def get(self, _): return 24 if _ == scan.cv2.CAP_PROP_FPS else 384
            def release(self): pass
        x, energy, rate = dancing(120)
        pose = (x, energy, rate, {'coverage': .98, 'channels': 8, 'duration': 16, 'trackSwitches': 0})
        for matching in [True, False]:
            with self.subTest(matching=matching), patch.object(scan.cv2, 'VideoCapture', return_value=Capture()), patch.object(scan, 'audio_analysis', return_value=({'available': True, 'confidence': .9, 'candidates': [{'bpm': 120 if matching else 153, 'offset': .1, 'score': 1}]}, None, 86)), patch.object(scan, 'pose_features', return_value=pose) as poses:
                result = scan.analyze_clip(Path('fake.mp4'))
                self.assertEqual(result['method'], 'audio-supported' if matching else 'visual')
                self.assertEqual(poses.call_count, 1 if matching else 2)
                if not matching:
                    self.assertFalse(poses.call_args.args[-1])


if __name__ == '__main__':
    unittest.main()
