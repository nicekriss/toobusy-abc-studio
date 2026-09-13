import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sheetsage_worker', ROOT / 'abc_studio_node/sheetsage_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class StatusWriteTests(unittest.TestCase):
    def test_replaces_complete_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'status.json'
            worker.write_json(path, {'state': 'running'})
            worker.write_json(path, {'state': 'done', 'message': '채보 완료'})
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['state'], 'done')
            self.assertFalse(path.with_suffix('.tmp').exists())

    @unittest.skipUnless(sys.platform == 'win32', 'Windows file sharing regression')
    def test_retries_while_reader_holds_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'status.json'
            worker.write_json(path, {'state': 'running'})
            reader = path.open('rb')
            release = threading.Timer(.15, reader.close)
            release.start()
            try:
                worker.write_json(path, {'state': 'done'})
            finally:
                release.join()
                reader.close()
            self.assertEqual(json.loads(path.read_text())['state'], 'done')

    def test_persistent_denial_is_not_silently_ignored(self):
        denied = PermissionError('denied')
        denied.winerror = 5
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'status.json'
            path.write_text('{"state":"running"}')
            with patch.object(worker.sys, 'platform', 'win32'), patch.object(Path, 'replace', side_effect=denied) as replace, patch.object(worker.time, 'sleep'):
                with self.assertRaises(PermissionError):
                    worker.write_json(path, {'state': 'done'})
            self.assertEqual(replace.call_count, 40)
            self.assertEqual(json.loads(path.read_text())['state'], 'running')

    def test_other_io_error_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(Path, 'replace', side_effect=OSError('disk error')) as replace:
                with self.assertRaises(OSError):
                    worker.write_json(Path(directory) / 'status.json', {'state': 'done'})
            self.assertEqual(replace.call_count, 1)


class ExplainTests(unittest.TestCase):
    def test_unsupported_card_gets_korean_guidance(self):
        raw = RuntimeError(
            'CUDA error: no kernel image is available for execution on the device '
            'CUDA kernel errors might be asynchronously reported at some other API call')
        message = worker.explain(raw)
        self.assertIn('설치기', message)
        self.assertNotIn('CUDA error', message)

    def test_other_failures_are_passed_through(self):
        self.assertEqual(worker.explain(ValueError('음원을 읽지 못했습니다')), '음원을 읽지 못했습니다')


if __name__ == '__main__':
    unittest.main()
