"""Pure note-boundary regression checks; model inference is a separate smoke test."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("transcription", Path(__file__).resolve().parents[1] / "abc_studio_node/transcription.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@unittest.skipUnless(importlib.util.find_spec("numpy"), "numpy required for audio tests")
class NoteTests(unittest.TestCase):
    def test_repeated_notes_with_rest(self):
        pitches = [69.] * 30 + [float("nan")] * 4 + [69.] * 30
        notes = module.segment_notes(pitches, [1.] * len(pitches), .01)
        self.assertEqual(len(notes), 2)
        self.assertAlmostEqual(notes[1]["start"], .34)
        self.assertAlmostEqual(notes[0]["duration"], .3)

    def test_same_pitch_reattack_without_silence(self):
        notes = module.segment_notes([69.] * 100, [1.] * 100, .01, [.5])
        self.assertEqual([n["duration"] for n in notes], [.5, .5])

    def test_chromatic_and_timing_are_not_quantized(self):
        notes = module.segment_notes([61.] * 27 + [60.] * 23, [1.] * 50, .01)
        self.assertEqual([n["pitch"] for n in notes], [61, 60])
        self.assertEqual(notes[1]["start"], .27)

    def test_tail_clipped_to_source(self):
        notes = module.segment_notes([69.] * 100, [1.] * 100, .01, duration=.975)
        self.assertEqual(notes[0]["duration"], .975)

    def test_release_is_not_a_reattack(self):
        energy = [0.] * 10 + [.2] * 20 + [.2, .15, .1, .05, 0.]
        self.assertEqual(module.rising_onsets([.1, .3], energy, .01), [.1])


if __name__ == "__main__":
    unittest.main()
