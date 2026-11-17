"""停靠防呆（park_window 窗口身份白名单）的回归测试。

背景：类名防呆原来用 win32 GetClassName 单比 'mmui::MainWindow'——那是 UIA
的逻辑类名；微信 4.x 的 Win32 类名是 Qt 框架类 Qt51514QWindowIcon，单比永远
不匹配 → 停靠从未生效（跳过日志只写进 wechatauto 的 4x.log，bridge.log 里
看不到）→ 每次后台发送都真实激活微信跳前台（2026-11-17 用户实见）。

修复：类名白名单（mmui::MainWindow / Qt51514QWindowIcon）+ 标题白名单
（微信/WeChat/Weixin）双校验；跳过日志必须带 class/title 便于将来诊断。

测试方式：往 sys.modules 注入假 win32 模块（park_window 内部是惰性 import，
会拿到假件），真窗口不动一根手指。
"""
import sys
import unittest
from pathlib import Path
import types

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / 'bridge') not in sys.path:
    sys.path.insert(0, str(ROOT / 'bridge'))

SWP_NOSIZE, SWP_NOZORDER, SWP_NOACTIVATE = 0x0001, 0x0004, 0x0010
CALLS = []


class FakeWin32gui:
    """按注册表返回类名/标题；SetWindowPos 记录调用。"""

    registry = {}
    setpos_calls = []

    @staticmethod
    def GetClassName(hwnd):
        return FakeWin32gui.registry.get(hwnd, ('', ''))[0]

    @staticmethod
    def GetWindowText(hwnd):
        return FakeWin32gui.registry.get(hwnd, ('', ''))[1]

    @staticmethod
    def SetWindowPos(hwnd, a, x, y, w, h, flags):
        FakeWin32gui.setpos_calls.append((hwnd, x, y, flags))
        return True

    @staticmethod
    def GetWindowRect(hwnd):
        return (100, 200, 300, 400)


class FakeWin32con:
    SWP_NOSIZE = SWP_NOSIZE
    SWP_NOZORDER = SWP_NOZORDER
    SWP_NOACTIVATE = SWP_NOACTIVATE


def inject_win32():
    sys.modules.setdefault('win32gui', FakeWin32gui)
    sys.modules.setdefault('win32con', FakeWin32con)


inject_win32()
import bg_sender  # noqa: E402


class ParkWindowGuardTest(unittest.TestCase):
    def setUp(self):
        FakeWin32gui.registry.clear()
        FakeWin32gui.setpos_calls.clear()
        bg_sender._PARKED.clear()
        self.logs = []

    def register(self, hwnd, cls, title):
        FakeWin32gui.registry[hwnd] = (cls, title)

    def log(self, msg):
        self.logs.append(msg)

    def test_qt_class_wechat_title_parks(self):
        """今天实见的主窗形态（Qt 类名 + 标题「微信」）必须能停靠。"""
        self.register(592740, 'Qt51514QWindowIcon', '微信')
        ok = bg_sender.park_window(592740, log=self.log)
        self.assertTrue(ok)
        self.assertIn(592740, bg_sender._PARKED)
        self.assertEqual(len(FakeWin32gui.setpos_calls), 1)
        hwnd, x, y, flags = FakeWin32gui.setpos_calls[0]
        self.assertEqual((hwnd, x, y), (592740, bg_sender._PARK_POS, bg_sender._PARK_POS))
        self.assertEqual(flags, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
        self.assertTrue(any('移到屏幕外' in m for m in self.logs), '停靠成功要留日志')

    def test_mmui_class_english_title_parks(self):
        """mmui::MainWindow（UIA 逻辑类名）+ 英文标题也认。"""
        self.register(1001, 'mmui::MainWindow', 'WeChat')
        self.assertTrue(bg_sender.park_window(1001, log=self.log))

    def test_unrelated_class_skips_with_details(self):
        """句柄回收被无关应用拿走：跳过，且日志带 class/title 便于诊断。"""
        self.register(1002, 'Notepad2Class', '未命名 - 记事本')
        ok = bg_sender.park_window(1002, log=self.log)
        self.assertFalse(ok)
        self.assertEqual(FakeWin32gui.setpos_calls, [])
        joined = '\n'.join(self.logs)
        self.assertIn('跳过屏幕外停靠', joined)
        self.assertIn('Notepad2Class', joined), '跳过日志必须带观测到的类名'
        self.assertIn('记事本', joined), '跳过日志必须带观测到的标题'

    def test_qt_class_but_wrong_title_skips(self):
        """类名撞上别的 Qt 应用（标题不是微信）也不能停。"""
        self.register(1003, 'Qt51514QWindowIcon', '某Qt播放器')
        ok = bg_sender.park_window(1003, log=self.log)
        self.assertFalse(ok)
        self.assertEqual(FakeWin32gui.setpos_calls, [])

    def test_second_park_of_same_hwnd_is_silent_noop(self):
        self.register(1004, 'Qt51514QWindowIcon', '微信')
        self.assertTrue(bg_sender.park_window(1004, log=self.log))
        logs_before = len(self.logs)
        self.assertFalse(bg_sender.park_window(1004, log=self.log))
        self.assertEqual(len(self.logs), logs_before)

    def test_unpark_restores_position(self):
        self.register(1005, 'Qt51514QWindowIcon', '微信')
        bg_sender.park_window(1005, log=self.log)
        FakeWin32gui.setpos_calls.clear()
        ok = bg_sender.unpark_window(1005, log=self.log)
        self.assertTrue(ok)
        self.assertNotIn(1005, bg_sender._PARKED)
        hwnd, x, y, flags = FakeWin32gui.setpos_calls[0]
        self.assertEqual((hwnd, x, y), (1005, 100, 200))
        self.assertTrue(any('还原' in m for m in self.logs))


if __name__ == '__main__':
    unittest.main()
