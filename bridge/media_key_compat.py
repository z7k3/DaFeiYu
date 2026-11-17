# -*- coding: utf-8 -*-
"""图片 AES 密钥扫描的超时护栏（外部兼容层，不改 vendor/wechatauto）。

现象（2026-11-15 16:15 本机实测）
    发完一张图片后 Bot 就不回话了，聊天里连「收到 私聊」都没有；桥接日志停在
    「图片缓存尚未就绪，等待重试（1/3）」，两分钟里一个字也没有，重启桥接才恢复。

根因
    微信图片是 V2 加密，密钥只能从 Weixin.exe 进程内存里反推。随包 wechatauto 的
    ``MediaDownloader._scan_aes_key(monitor=True)`` 在单次扫描没找到时会**每 2 秒
    重扫一次、最多等 120 秒**；这段代码跑在「同一会话串行」的消息 worker 里，
    于是这个会话后面的消息全部排队等它 —— 用户看到的就是「卡死」。

做法
    给 MediaDownloader 实例打一层超时护栏：
      1. 永远单次扫描（``monitor=False``），不再挂 120 秒等待；
      2. 扫描本身也放进守护线程，超过 ``timeout`` 就放弃这张图，先把会话放出来；
      3. 失败后冷却一段时间，避免每条图片都重新扫一遍微信内存。
    扫不到密钥时仍然按原逻辑返回 None（调用方按「这条不回话」处理），只多写一句
    能看懂的日志。

只读 vendor：替换的是**实例属性**，不改上游源码，升级 wechatauto 也不需要重打补丁。
"""

from __future__ import annotations

import threading
import time

# 单次内存扫描的等待上限：实测正常机器 1~3 秒扫完，给到 8 秒足够。
SCAN_TIMEOUT = 8.0
# 失败后的冷却：同一个账号一分钟内不会重复扫内存（一张图失败不代表下张也不行，
# 但连续重扫只会继续卡会话，所以给用户「点开一张图再发」的恢复时间）。
RETRY_COOLDOWN = 60.0


def install_key_scan_guard(downloader, log=None, timeout=SCAN_TIMEOUT,
                           cooldown=RETRY_COOLDOWN):
    """给 ``MediaDownloader`` 实例装上图片密钥扫描护栏。返回是否装上。"""
    if getattr(downloader, '_key_scan_guarded', False):
        return False
    original = getattr(downloader, '_scan_aes_key', None)
    if not callable(original):
        return False
    say = log or (lambda *args, **kwargs: None)
    state = {'blocked_until': 0.0, 'running': False}
    guard = threading.Lock()

    def scan(monitor=False, monitor_timeout=120.0, probe=None):
        with guard:
            if state['running']:
                # 上一次扫描还挂在后台：这次直接用「没取到」，别叠加上去。
                return None
            if time.monotonic() < state['blocked_until']:
                return None
            state['running'] = True
        try:
            box = {}

            def work():
                try:
                    # 关键：强制单次扫描。monitor=True 会再等 120 秒，正是卡死的来源。
                    box['key'] = original(monitor=False, monitor_timeout=monitor_timeout, probe=probe)
                except BaseException as exc:  # noqa: BLE001 - 原样交回调用方处理
                    box['err'] = exc

            thread = threading.Thread(target=work, name='image-key-scan', daemon=True)
            thread.start()
            thread.join(max(0.1, float(timeout)))
            if thread.is_alive():
                state['blocked_until'] = time.monotonic() + max(0.0, float(cooldown))
                say('图片密钥扫描超过 %.0f 秒还没结束，这张图先跳过（%.0f 秒内不再重扫）；'
                    '在微信里点开任意一张图片后再发图，能提高取到密钥的概率'
                    % (timeout, cooldown))
                return None
            if 'err' in box:
                raise box['err']
            key = box.get('key')
            if not key:
                state['blocked_until'] = time.monotonic() + max(0.0, float(cooldown))
                say('图片密钥没能从微信进程里取到，这张图先跳过（%.0f 秒内不再重扫）；'
                    '在微信里点开任意一张图片后再发图试试' % cooldown)
            return key
        finally:
            with guard:
                state['running'] = False

    downloader._scan_aes_key = scan
    downloader._key_scan_guarded = True
    return True
