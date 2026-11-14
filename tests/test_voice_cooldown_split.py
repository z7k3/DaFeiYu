"""语音冷却分家：投递未确认只拦概率抽签，明确请求与 API 冷却互不越权。

2026-11-14 实见：合成 HTTP=200 成功、语音没落进微信 → note_failure 被当成
"接口连续异常"拦 30 分钟，"发语音"明确请求也只回文字。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge.voice_reply as vr


class CooldownSplitTests(unittest.TestCase):
    def setUp(self):
        vr._health.clear()
        vr._delivery_until.clear()

    def test_delivery_cooldown_blocks_probability_but_not_explicit(self):
        vr.note_failure("r")
        blocked, left, why = vr.cooldown_remaining("r", explicit=False)
        self.assertTrue(blocked)
        self.assertEqual(why, "delivery")
        self.assertGreater(left, 0)
        blocked2, left2, why2 = vr.cooldown_remaining("r", explicit=True)
        self.assertFalse(blocked2, "明确请求必须绕过投递冷却")

    def test_api_cooldown_blocks_everything_including_explicit(self):
        vr._health_update("r", True)
        vr._health_update("r", True)  # 连续两次 → API 冷却
        blocked, left, why = vr.cooldown_remaining("r", explicit=True)
        self.assertTrue(blocked, "接口真坏了，明确请求也该回退文字")
        self.assertEqual(why, "api")

    def test_success_resets_api_streak(self):
        vr._health_update("r", True)
        vr._health_update("r", False)
        blocked, _, _ = vr.cooldown_remaining("r", explicit=False)
        self.assertFalse(blocked, "合成成功清零连续失败计数")


if __name__ == '__main__':
    unittest.main()
