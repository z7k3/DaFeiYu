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
    def test_model_wait_uses_finite_generous_read_deadline(self):
        """webhook 读超时契约（M1，2026-11-18 取代旧的「必须无限等」契约）。

        旧契约 (10, None)：模型生成耗时由内核控制，桥接不设读上限——代价是内核
        事件循环卡死时会话 worker 被永久占死。新契约：读超时 = G.WEBHOOK_READ_TIMEOUT
        （240s，宽松于内核 LLM 120s 硬顶 + 检索/关怀路由叠加，正常生成永不触顶），
        超时放弃本轮并留日志——有限上限换掉永久占死。
        """
        tree = ast.parse((ROOT / 'bridge/receiver_mixin.py').read_text(encoding='utf-8-sig'))
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
                 and n.args and isinstance(n.args[0], ast.Attribute) and n.args[0].attr == 'bot_url']
        self.assertTrue(calls)
        timeout = next(k.value for k in calls[0].keywords if k.arg == 'timeout')
        # timeout=(连接超时, 读超时)：读方向必须是引擎常量引用，不允许回到 None（无限等）
        self.assertIsInstance(timeout, ast.Tuple)
        self.assertEqual(len(timeout.elts), 2)
        self.assertEqual(ast.literal_eval(timeout.elts[0]), 10)
        read_deadline = timeout.elts[1]
        self.assertIsInstance(read_deadline, ast.Attribute)
        self.assertEqual(read_deadline.attr, 'WEBHOOK_READ_TIMEOUT')
        # 引擎常量：有限值，且宽松于内核侧最长生成（LLM 硬顶 120s + 短调用叠加）
        engine_tree = ast.parse((ROOT / 'bridge/engine.py').read_text(encoding='utf-8-sig'))
        value = next(n.value for n in engine_tree.body if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == 'WEBHOOK_READ_TIMEOUT' for t in n.targets))
        seconds = ast.literal_eval(value)
        self.assertIsInstance(seconds, int)
        self.assertGreaterEqual(seconds, 240)
        self.assertLessEqual(seconds, 600)

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
