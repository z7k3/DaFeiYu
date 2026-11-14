"""跨文件调用一致性：receiver 传给 send_voice_reply 的关键字参数，
必须都在 VoiceMixin.send_voice_reply 的签名里。

2026-11-14 实见：explicit 只加在调用侧没加在签名侧 → TypeError 吞掉整条
回复（用户看到"发语音后她甚至没回"）。部署同步正常也会犯这种错，
因为两个文件分属不同 mixin，普通导入测试不覆盖调用点参数。"""
import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _params_of(fn_node):
    out = set()
    a = fn_node.args
    out.update(a.arg for a in a.args)
    out.update(a.arg for a in a.kwonlyargs)
    if a.vararg:
        out.add(a.vararg.arg)
    if a.kwarg:
        out.add(a.kwarg.arg)
    return out


class TestVoiceCallSignature(unittest.TestCase):
    def test_receiver_call_kwargs_exist_in_signature(self):
        mixin = ast.parse((ROOT / "bridge" / "voice_mixin.py").read_text(encoding="utf-8"))
        sig = next(n for n in ast.walk(mixin) if isinstance(n, ast.FunctionDef)
                   and n.name == "send_voice_reply")
        params = _params_of(sig)
        receiver = ast.parse((ROOT / "bridge" / "receiver_mixin.py").read_text(encoding="utf-8"))
        checked = 0
        for node in ast.walk(receiver):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "send_voice_reply"):
                continue
            for kw in node.keywords:
                if kw.arg is None:
                    continue
                self.assertIn(kw.arg, params,
                              f"调用传了签名没有的关键字参数 {kw.arg!r}（会 TypeError 吞回复）")
                checked += 1
        self.assertGreaterEqual(checked, 1, "至少要覆盖一处真实调用点")


if __name__ == '__main__':
    unittest.main()
