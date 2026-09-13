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


def facts(**overrides):
    healthy = {'python':[3,11],'isolated':True,'torch':installer.TORCH_BUILD,
               'torchaudio':installer.TORCH_BUILD,'transformers':'4.45.2','cuda':True,
               'gpu':'NVIDIA GeForce RTX 3090','arch':'sm_86',
               'builds':['sm_70','sm_75','sm_80','sm_86','sm_90','sm_100','sm_120']}
    healthy.update(overrides)
    return healthy


class RuntimeCheckTests(unittest.TestCase):
    def test_healthy_runtime_passes(self):
        installer.verify_facts(facts())

    def test_card_absent_from_torch_build_is_refused(self):
        # RTX 50 reports sm_120; the cu126 build stops at sm_90. CUDA still
        # reports itself available, which is why this has to be caught here.
        blackwell = facts(gpu='NVIDIA GeForce RTX 5060 Ti', arch='sm_120',
                          builds=['sm_61','sm_70','sm_75','sm_80','sm_86','sm_90'])
        with self.assertRaises(RuntimeError) as refusal:
            installer.verify_facts(blackwell)
        message = str(refusal.exception)
        self.assertIn('RTX 5060 Ti', message)
        self.assertIn('sm_120', message)
        self.assertIn('설치기', message)

    def test_older_cuda_build_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, r'2\.8\.0\+cu126'):
            installer.verify_facts(facts(torch='2.8.0+cu126'))

    def test_missing_gpu_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'NVIDIA'):
            installer.verify_facts(facts(cuda=False, gpu=None, arch=None))

    def test_shared_packages_are_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'must not share'):
            installer.verify_facts(facts(isolated=False))

    def test_runtime_failure_reports_its_own_message(self):
        failure = installer.subprocess.CalledProcessError(1, 'python')
        failure.stderr = 'Traceback\nRuntimeError: CUDA error: no kernel image is available'
        with patch.object(installer, 'run', side_effect=failure):
            with self.assertRaisesRegex(RuntimeError, 'no kernel image'):
                installer.probe('python', 'unused')


class TorchInstallTests(unittest.TestCase):
    def commands(self, present):
        recorded = []
        with patch.object(installer, 'installed_build', return_value=present):
            with patch.object(installer, 'run', side_effect=lambda command, capture=False: recorded.append(command)):
                installer.install_torch('python')
        return recorded[0]

    def test_pinned_index_matches_pinned_build(self):
        self.assertTrue(installer.TORCH_INDEX.endswith(installer.TORCH_CUDA))
        self.assertEqual(installer.TORCH_BUILD, installer.TORCH_VERSION + '+' + installer.TORCH_CUDA)

    def test_wrong_cuda_build_is_replaced(self):
        # pip counts 2.8.0+cu126 as satisfying torch==2.8.0 and would keep it.
        self.assertIn('--force-reinstall', self.commands('2.8.0+cu126'))

    def test_matching_build_is_left_alone(self):
        self.assertNotIn('--force-reinstall', self.commands(installer.TORCH_BUILD))

    def test_fresh_runtime_installs_without_forcing(self):
        self.assertNotIn('--force-reinstall', self.commands(None))

    def test_install_uses_the_pinned_index(self):
        command = self.commands(None)
        self.assertIn(installer.TORCH_INDEX, command)
        self.assertIn(f'torch=={installer.TORCH_VERSION}', command)


if __name__ == '__main__': unittest.main()
