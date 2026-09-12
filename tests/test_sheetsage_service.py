import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audio_routes', ROOT/'abc_studio_node/audio_routes.py')
routes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routes)


class OptionsTests(unittest.TestCase):
    def test_whole_song_has_no_duration_cutoff(self):
        self.assertEqual(routes.parse_options({}), {'mode':'melody','from':0.0,'to':None})
        self.assertEqual(routes.parse_options({'to':'720'})['to'], 720)

    def test_preserves_long_selection_and_full_score(self):
        self.assertEqual(routes.parse_options({'from':'90','to':'450','mode':'full'}),
                         {'from':90.0,'to':450.0,'mode':'full'})

    def test_rejects_invalid_bounds(self):
        for options in ({'from':'-1'}, {'from':'nan'}, {'to':'inf'}, {'from':'9','to':'4'}, {'mode':'song'}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                routes.parse_options(options)

    def test_missing_runtime_is_not_available(self):
        self.assertIsNone(routes.load_setup(ROOT/'no-such-setup.json'))


if __name__ == '__main__': unittest.main()
