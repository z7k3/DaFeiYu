# -*- coding: utf-8 -*-
"""不合并输入队列的窗口激活兼容层。"""


def activate(hwnd):
    import ctypes
    from ctypes import wintypes
    import win32gui

    if not hwnd or not win32gui.IsWindow(hwnd):
        return False
    # 同步恢复 + 合并输入队列会等待目标 GUI 线程；双开时会把另一个微信也拖住。
    user32 = ctypes.windll.user32
    show = user32.ShowWindowAsync
    show.argtypes = [wintypes.HWND, ctypes.c_int]
    show.restype = wintypes.BOOL
    if win32gui.IsIconic(hwnd):
        show(hwnd, 9)
    elif not win32gui.IsWindowVisible(hwnd):
        show(hwnd, 4)
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        return False
    return win32gui.GetForegroundWindow() == hwnd


def install():
    from wechatauto.guia import WeChatGUI
    from wechatauto.uia_driver import WeChatUIA

    def bring_to_front(self, keep_topmost=False):
        # 不能为抢焦点改全机前台锁，也不能把两个账号的输入线程绑在一起。
        return activate(self.main_hwnd)

    WeChatGUI.bring_to_front = bring_to_front
    WeChatUIA._force_foreground = staticmethod(activate)

    def activate_control(self, win):
        # 原来的 _activate 在失败后还会同步 ShowWindow/SetActive，不能再落回旧路径。
        return activate(win.NativeWindowHandle)

    WeChatUIA._activate = activate_control
