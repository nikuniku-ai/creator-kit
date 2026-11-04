import json, os, subprocess, sys, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))
import nikuniku_api  # noqa: E402

class PythonClient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mock = subprocess.Popen(['node', str(ROOT / 'tests/mock-api.mjs')], stdout=subprocess.PIPE, text=True)
        cls.base = cls.mock.stdout.readline().strip()

    @classmethod
    def tearDownClass(cls):
        cls.mock.terminate(); cls.mock.wait()

    def test_me_and_wallet(self):
        c = nikuniku_api.Client(self.base, 'nk_test_mock_key')
        self.assertEqual(c.me()['workspace_id'], 'ws_000000000000000000000001')
        self.assertEqual(c.wallet('ws_000000000000000000000001')['available_units'], 300)

    def test_wrong_key_raises_api_error(self):
        c = nikuniku_api.Client(self.base, 'nk_wrong')
        with self.assertRaises(nikuniku_api.ApiError):
            c.me()

if __name__ == '__main__':
    unittest.main()
