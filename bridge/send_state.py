# -*- coding: utf-8 -*-
"""发送临界区状态与会话身份错误。

`SEND_STATE` 是发送看门狗的唯一状态源：进发送区置位、出区清零。
`ChatIdentityError` 表示「当前会话不是目标会话」，只能整条放弃，不能换通道重试；
`DraftDirtyError` 表示输入框可能残留草稿，同样禁止换通道继续发。
"""

import re
import time

SEND_STATE = {"active": False, "start": 0.0, "budget": 40.0, "raised_hwnd": 0, "raised_was_topmost": False}


def touch():
    """进度心跳（S1）：长步骤推进时刷新看门狗起算点。

    send_watchdog 只看「start 距今多久」；单条通道内部一段就可能卡 8~20 秒
    （open_chat 搜索兜底、逐字打字、前台抢焦点），不 touch 的话两次刷新之间
    就会被预算误杀（实测把正常推进的发送当卡死强杀，桥接反复重启）。
    """
    SEND_STATE["start"] = time.time()


def ensure_budget(minimum):
    """把看门狗预算抬到至少 minimum（S1）：前台通道矩阵单轮结构就长。

    send_text 进入 UIA/键盘/OCR 段时传 min(180, 120 + 0.16×字数)：
    一轮最多 5 次 uia_send、单次 open_chat 实测 8~20 秒，固定 40 秒
    预算覆盖不住，只会把合法慢发送误判成卡死。
    """
    if float(minimum) > float(SEND_STATE.get("budget") or 40.0):
        SEND_STATE["budget"] = float(minimum)


def note_raised(hwnd, was_topmost):
    """记录当前被临时置顶的微信窗口。

    force_send_foreground 发送期间把微信设成 TOPMOST、发完在 finally 里还原；
    但看门狗 hard_exit 用 os._exit，不执行 finally —— 不记录的话，进程被杀的
    那一刻微信就永远留在置顶状态（别的窗口盖不住它，只能重启微信才能恢复）。
    hard_exit 读这两个字段，在退出前把窗口还原成普通层级。
    """
    SEND_STATE["raised_hwnd"] = int(hwnd or 0)
    SEND_STATE["raised_was_topmost"] = bool(was_topmost)


def clear_raised():
    """置顶已由正常路径（finally）还原，清掉记录。"""
    SEND_STATE["raised_hwnd"] = 0
    SEND_STATE["raised_was_topmost"] = False


_CHAT_NAME_SPLIT_RE = re.compile(r"[、,，\s]+")


class ChatIdentityError(RuntimeError):
    """当前开着的会话不是目标会话：宁可这条不发，也不能把正文打进别的群。

    发送 = 先切会话、再往「当前输入框」里打字。只要切会话没成功（名字只是相似、
    或者中途窗口被切走），正文就落到别的会话里 —— 表现就是「两个群同时回的时候
    把消息搞混」。这种错不能靠换通道兜底：换哪条通道都是往「当前那个会话」打字，
    所以整条放弃。
    """


class DraftDirtyError(RuntimeError):
    """输入框可能残留本次草稿，禁止换通道继续发送。"""


def _chat_identity_level(current, aliases):
    """当前会话名和目标候选名有多像：0 完全相同、1 成员名集合吻合，其它一律不收。

    以前用「包含」也算命中（`name in alias`），于是「群A」和「群A2」互认：
    点开 A2 也判定成「已经在 A 了」，正文就发到另一个群。这里只认两种确定情形，
    未命名的群在会话列表里显示成「成员甲、成员乙」，所以保留成员名集合这一档。
    """
    cur = str(current or "").strip()
    if not cur:
        return None
    keys = [str(a or "").strip() for a in (aliases or []) if str(a or "").strip()]
    if not keys:
        return None
    if cur in keys:
        return 0
    parts = [p for p in _CHAT_NAME_SPLIT_RE.split(cur) if p]
    if len(parts) >= 2:
        for k in keys:
            if all(p in k for p in parts):
                return 1
    return None


class _SendStateScope:
    """发送临界区的看门狗心跳（M7/H3）：进区置位、出区清零，单一 owner 写 SEND_STATE。

    预算按文本长度动态放宽：bg 通道逐字投递，长文本单打字就要一两分钟，
    旧的「固定 40 秒一刀切」会把这种合法慢发送当卡死杀掉（H3）。
    """

    def __init__(self, text_len=0, *, budget=0):
        # 编码热切换时最多输入两次（一次 GBK、一次 UTF-16），并留出回读/清理时间。
        # 0.16 秒/字：bg 通道逐字投递 + 回读校验的实测下限；调用方可再抬预算（budget）。
        self.budget = max(40.0, float(text_len or 0) * 0.16 + 8.0, float(budget))

    def __enter__(self):
        SEND_STATE["active"] = True
        SEND_STATE["start"] = time.time()
        SEND_STATE["budget"] = self.budget
        return self

    def __exit__(self, *exc):
        SEND_STATE["active"] = False
        return False
