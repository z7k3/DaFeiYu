import ctypes
import importlib.util
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "window_activation", pathlib.Path(__file__).resolve().parents[1] / "bridge/window_activation.py")
activation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activation)


class ActivationTests(unittest.TestCase):
    def test_isolated_publisher_installs_activation_guard(self):
        import ast
        source = (pathlib.Path(__file__).resolve().parents[1] / "bridge/moments_worker.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        worker = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "worker_main")
        calls = [n for n in ast.walk(worker) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == "install_safe_activation"]
        self.assertEqual(len(calls), 1)

    def test_qt_and_mmui_main_windows_are_recognized(self):
        spec = importlib.util.spec_from_file_location(
            "uia_boot", pathlib.Path(__file__).resolve().parents[1] / "bridge/uia_boot.py")
        boot = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(boot)
        for classname in ("Qt51514QWindowIcon", "Qt663QWindowIcon", "mmui::MainWindow"):
            with self.subTest(classname=classname):
                gui = types.SimpleNamespace(
                    GetClassName=lambda h: classname, GetWindowText=lambda h: "微信",
                    IsIconic=lambda h: False, GetWindowRect=lambda h: (0, 0, 1200, 800))
                self.assertTrue(boot.is_wechat_account_window(gui, 11))

    def test_restore_is_async_and_does_not_attach_input_queues(self):
        calls = []

        class AsyncShow:
            def __call__(self, hwnd, command):
                calls.append((hwnd, command))
                return True

        # 只提供允许的 API；线程绑定、同步恢复或改全机设置都会直接报错。
        user32 = types.SimpleNamespace(ShowWindowAsync=AsyncShow())
        gui = types.SimpleNamespace(
            IsWindow=lambda h: True, IsIconic=lambda h: True,
            IsWindowVisible=lambda h: False,
            SetForegroundWindow=lambda h: calls.append(("foreground", h)),
            GetForegroundWindow=lambda: 22)
        with patch.object(ctypes, "windll", types.SimpleNamespace(user32=user32), create=True):
            with patch.dict(sys.modules, win32gui=gui):
                self.assertFalse(activation.activate(11))
        self.assertEqual(calls, [(11, 9), ("foreground", 11)])

    def test_both_vendor_entrypoints_are_replaced(self):
        gui_class = type("GUI", (), {})
        uia_class = type("UIA", (), {})
        modules = {
            "wechatauto": types.ModuleType("wechatauto"),
            "wechatauto.guia": types.SimpleNamespace(WeChatGUI=gui_class),
            "wechatauto.uia_driver": types.SimpleNamespace(WeChatUIA=uia_class),
        }
        gui = gui_class()
        gui.main_hwnd = 11
        with patch.object(activation, "activate", return_value=False) as activate:
            with patch.dict(sys.modules, modules):
                activation.install()
            self.assertFalse(gui.bring_to_front(keep_topmost=True))
            self.assertFalse(uia_class._force_foreground(22))
            self.assertFalse(uia_class()._activate(types.SimpleNamespace(NativeWindowHandle=33)))
        self.assertEqual([c.args for c in activate.call_args_list], [(11,), (22,), (33,)])


if __name__ == "__main__":
    unittest.main()
