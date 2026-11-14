"""残留识别窗口：风暴后数小时才重试时，输入框里的自己残留仍要能认出来。

2026-11-14 实见：14:09 风暴打进输入框的草稿，15:04 才开始挡发送（55 分钟），
旧 30 分钟 TTL 直接漏认 → 每条回复被 input_not_empty 拒掉。"""
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge import bg_sender


class ResidueWindowTests(unittest.TestCase):
    def setUp(self):
        bg_sender._ATTEMPT_LIST = None  # 强制重新加载
        bg_sender._LAST_ATTEMPT.clear()
        self.file = Path(bg_sender._RESIDUE_FILE)
        self.backup = self.file.read_bytes() if self.file.exists() else None
        self.addCleanup(self._restore)

    def _restore(self):
        if self.backup is None:
            if self.file.exists():
                self.file.unlink()
        else:
            self.file.write_bytes(self.backup)
        bg_sender._ATTEMPT_LIST = None

    def test_storm_residue_beyond_half_hour_still_recognized(self):
        now = time.time()
        self.file.parent.mkdir(parents=True, exist_ok=True)
        import json
        self.file.write_text(json.dumps(
            [[now - 3300, "风暴残留：改到现在还没歇啊那 bug 是真磨人"]]), encoding="utf-8")
        bg_sender._ATTEMPT_LIST = None
        self.assertTrue(
            bg_sender._looks_like_own_residue(1, "风暴残留：改到现在还没歇啊那 bug 是真磨人"),
            "55 分钟前的自己残留必须还能认出（旧 30 分钟 TTL 会漏）")

    def test_truly_old_records_are_not_ours(self):
        now = time.time()
        import json
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_text(json.dumps([[now - 3300, "老残留"]]), encoding="utf-8")
        bg_sender._ATTEMPT_LIST = None
        self.assertFalse(bg_sender._looks_like_own_residue(1, "完全无关的用户草稿内容"))


if __name__ == '__main__':
    unittest.main()
