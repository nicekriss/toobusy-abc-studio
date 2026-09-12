import hashlib
import importlib.util
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sheet_install', Path(__file__).resolve().parents[1]/'install_sheetsage2.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class DownloadTests(unittest.TestCase):
    def test_reuses_exact_file_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'model';path.write_bytes(b'known')
            with patch.object(installer.urllib.request,'urlopen',side_effect=AssertionError('network')):
                installer.download('unused',path,hashlib.sha256(b'known').hexdigest())

    def test_modified_file_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'model';path.write_bytes(b'custom')
            with self.assertRaisesRegex(RuntimeError,'preserved'):
                installer.download('unused',path,hashlib.sha256(b'known').hexdigest())
            self.assertEqual(path.read_bytes(),b'custom')

    def test_bad_download_never_becomes_installed_model(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'model'
            with patch.object(installer.urllib.request,'urlopen',return_value=BytesIO(b'bad')):
                with self.assertRaisesRegex(RuntimeError,'checksum'):
                    installer.download('unused',path,hashlib.sha256(b'known').hexdigest())
            self.assertFalse(path.exists())


if __name__ == '__main__': unittest.main()
