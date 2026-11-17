"""残留识别：上游 4.1.7 用 _PROBE_TEXTS 在发送前识别并删除探测字，
取代了 fork 的 _RESIDUE_FILE/_LAST_ATTEMPT 记账（机制已被官方方案覆盖）。

本文件守两点：探测字防残留机制存在；输入框非空时的拒绝路径仍在。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge import bg_sender


class ProbeTextGuardTests(unittest.TestCase):
    def test_probe_texts_defined_and_nonempty(self):
        texts = getattr(bg_sender, '_PROBE_TEXTS', None)
        self.assertIsNotNone(texts, '_PROBE_TEXTS 机制要存在（上游 4.1.7）')
        self.assertTrue(any(str(t).strip() for t in (texts if isinstance(texts, (list, tuple, set)) else [texts])))

    def test_dirty_input_guard_still_blocks_send(self):
        src = Path(bg_sender.__file__).read_text(encoding='utf-8')
        self.assertIn('input_not_empty', src, '非空输入必须仍能拦住发送')


if __name__ == '__main__':
    unittest.main()
