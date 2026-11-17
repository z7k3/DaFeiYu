import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]


def method(file, name):
    tree = ast.parse((ROOT / 'bridge' / file).read_text(encoding='utf-8-sig'))
    node = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name)
    env = {'G': SimpleNamespace(uia_boot=object())}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), file, 'exec'), env)
    return env[name]


class MomentsForegroundGuardTest(unittest.TestCase):
    def test_model_wait_has_no_bridge_read_deadline(self):
        tree = ast.parse((ROOT / 'bridge/receiver_mixin.py').read_text(encoding='utf-8-sig'))
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
                 and n.args and isinstance(n.args[0], ast.Attribute) and n.args[0].attr == 'bot_url']
        self.assertTrue(calls)
        timeout = next(k.value for k in calls[0].keywords if k.arg == 'timeout')
        self.assertEqual(ast.literal_eval(timeout), (10, None))

    def test_account_probe_keeps_verified_identity_without_uia(self):
        pick = method('account_mixin.py', 'pick_account_window')
        for verified in (True, False):
            state = {'verified': verified, 'hwnd': 123}
            bot = SimpleNamespace(ACCOUNT=state, foreground_is_moments=lambda: True)
            self.assertEqual(pick(bot, force=True), verified)
            self.assertEqual(state, {'verified': verified, 'hwnd': 123})

    def test_warmup_does_not_touch_tree_during_moments(self):
        warmup = method('loop_mixin.py', 'ensure_uia_ready')
        bot = SimpleNamespace(foreground_is_moments=lambda: True)
        self.assertEqual(warmup(bot, force=True)['reason'], 'moments_foreground')


if __name__ == '__main__':
    unittest.main()
