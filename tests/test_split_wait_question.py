"""断句等待的判定：完整问句（吗/嘛/呢/吧收尾）不该被当成半句话干等 8 秒。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.msg_pipeline import looks_incomplete


class CompleteQuestionTests(unittest.TestCase):
    def test_complete_questions_are_not_fragments(self):
        for text in ("你在干嘛", "你今天有什么安排吗", "睡了吗", "你喜欢吃啥呢",
                     "我们出去走走吧", "在那边弄方案嘛"):
            self.assertFalse(looks_incomplete(text), f"完整问句不该等待：{text}")

    def test_real_fragments_still_wait(self):
        for text in ("上班已经上到", "我们去看电影，", "今天"):
            self.assertTrue(looks_incomplete(text), f"半句话仍要等：{text}")


if __name__ == '__main__':
    unittest.main()
