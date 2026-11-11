# -*- coding: utf-8 -*-
"""Bridge runtime mixin: SenderMixin."""
import engine as G


class SenderMixin:

    def bg_send(self, text, chat_display_name, chat_username=''):
        """零焦点通道：用窗口消息打字 + 点发送，全程不抢前台。

        见 `bridge/bg_sender.py` 与 `docs/微信消息后台发送.md`。失败返回 False，
        由 send_text 继续走 UIA / 键盘 / OCR。**不动 gui、不碰 win32gui**，
        所以即使 wechatauto 的 UIA 引擎挂了这条也能用。
        """
        if not G.BG_SEND.get('enabled', True) or self.BG_STATS['disabled']:
            return False
        if G.time.time() < self.BG_STATS['cooldownUntil']:
            return False
        try:
            import bg_sender
        except Exception:
            try:
                from . import bg_sender
            except Exception as e:
                self.BG_STATS['disabled'] = True
                G.log('后台通道：模块导入失败，本次运行内关闭这条通道：', repr(e))
                return False
        hwnd = self._bg_hwnd()
        if not hwnd:
            return False
        try:
            bg_sender.configure(G.BG_SEND, state_file=G.os.path.join(G.ROOT, 'data', 'wechat-encoding.json'))
        except Exception:
            pass
        if chat_username:
            keys = self.aliases_for(chat_username, chat_display_name) or [chat_display_name]
        else:
            keys = [chat_display_name]
        t0 = G.time.time()
        try:
            ok, why = bg_sender.send(text, chat=keys, hwnd=hwnd, log=G.log, char_gap=G.BG_SEND.get('charGap', 0.04), strip_unencodable=G.BG_SEND.get('strip', True), verify=G.BG_SEND.get('verify', True), unhide=G.BG_SEND.get('unhide', True), char_mode=G.BG_SEND.get('charMode') or 'auto')
        except Exception as e:
            ok, why = (False, 'exception:' + type(e).__name__)
            G.log_warn('后台通道异常：', repr(e))
        self.BG_STATS['tried'] += 1
        self.BG_STATS['last'] = why
        self.BG_STATS['lastAt'] = G.time.time()
        if why == 'chat_mismatch':
            raise G.ChatIdentityError('后台通道：当前会话不是目标 %r' % chat_display_name)
        if why == 'content_mismatch':
            raise G.DraftDirtyError('正文回读校验未通过，本次输入已清理，未发送（%s）' % why)
        if why in ('input_dirty', 'residue_left', 'input_not_empty'):
            raise G.DraftDirtyError('输入框存在草稿或正文校验失败，请检查草稿后再试（%s）' % why)
        if ok:
            self.BG_STATS['ok'] += 1
            self.BG_STATS['treeFails'] = 0
            G.log('后台通道发送成功（%s，%.1fs）' % (why, G.time.time() - t0))
            return True
        G.log('后台通道没发出去（%s，%.1fs），换下一条通道：%s' % (why, G.time.time() - t0, chat_display_name))
        if why == 'tree_not_ready':
            self.BG_STATS['treeFails'] += 1
            if self.BG_STATS['treeFails'] >= 3:
                self.BG_STATS['cooldownUntil'] = G.time.time() + 600
                self.BG_STATS['treeFails'] = 0
                G.log_throttled('bg-tree-cooldown', '后台通道连续 3 次读不到控件树，先停 10 分钟再试（其余通道不受影响）。排查：python -m bridge --bg-probe')
        if why == 'uipi_denied':
            G.log_throttled('bg-uipi', '后台通道被 UIPI 拒绝：微信是管理员权限、桥接不是。把两边权限调成一样（都用管理员，或都不用）即可。')
        elif why == 'minimized':
            G.log_throttled('bg-min', '微信最小化了：零焦点通道要求窗口显示出来（用「显示但不激活」拉出来，不抢前台）。')
        elif why == 'tree_not_ready':
            G.log_throttled('bg-tree', '后台通道读不到控件树：确认微信没缩在托盘；4.2 需要 wechatauto 的 gate 热激活，必要时提权重试。诊断：python -m bridge --bg-probe')
        elif why == 'chat_not_found' and chat_username:
            G.log('后台通道：%s 不在会话列表里，改用会搜索的通道' % chat_display_name)
        return False

    def uia_send(self, text, who, username=''):
        """优先用 UIA 发送：不依赖 OCR 找发送按钮，成功后返回 True。"""
        if not self.account_send_allowed('UIA'):
            return False
        if not self.wechat_window_alive():
            with self.gui_lock:
                self.UIA_CACHE['u'] = None
            return False
        u = self.UIA_CACHE['u']
        try:
            with self.gui_lock:
                fresh = self.gui._get_uia() if self.gui is not None else None
            if fresh is not None:
                u = fresh
            self.UIA_CACHE['u'] = u
        except Exception:
            u = self.UIA_CACHE['u']
        if u is None:
            return False
        # quiet 补丁与表情包开关解耦：开着表情包时，文字发送同样不该抢前台
        if G.BACKGROUND_SEND:
            self.install_quiet_uia(u)
        keys = self.aliases_for(username, who) if username else [who]
        try:
            cur = None
            G.touch()
            try:
                cur = u.current_chat()
            except Exception:
                pass
            hit_cur = cur == who or any((cur == k for k in keys if k))
            if not hit_cur and username:
                hit_cur = bool(cur) and self.open_cache.get(username) == cur
            if not hit_cur:
                # S1：open_chat 走搜索兜底时单次 8~20s，进出各 touch 一次进度；
                # 失败要记账（连续 2 次后 send_text 本轮放弃整条通道矩阵）。
                G.touch()
                _opened = bool(u.open_chat(keys))
                G.touch()
                self._note_open_chat(username or who, _opened)
                if not _opened:
                    try:
                        u.back_to_chat_tab()
                    except Exception:
                        pass
                    G.touch()
                    _opened = bool(u.open_chat(keys))
                    G.touch()
                    self._note_open_chat(username or who, _opened)
                    if not _opened:
                        return False
                if username:
                    try:
                        self.open_cache[username] = u.current_chat() or ''
                        G.log('UIA 已切到会话：', self.open_cache[username])
                    except Exception:
                        pass
            self._require_chat_identity(u, who, keys, 'UIA')
            G.touch()
            t_open = G.time.time()
            sent_ok = False
            try:
                sent_ok = bool(u.send_text(text))
            except G.ChatIdentityError:
                raise
            except Exception:
                sent_ok = False
            if not sent_ok:
                try:
                    u.back_to_chat_tab()
                    G.touch()
                    if not u.open_chat(keys):
                        sent_ok = False
                    else:
                        self._require_chat_identity(u, who, keys, 'UIA 重试')
                        G.touch()
                        sent_ok = bool(u.send_text(text))
                except G.ChatIdentityError:
                    raise
                except Exception:
                    sent_ok = False
            G.log('UIA 发送耗时 %.1fs（打开会话+输入）' % (G.time.time() - t_open))
            if sent_ok:
                try:
                    leftover = self._input_value(u).strip()
                except Exception:
                    leftover = ''
                if leftover:
                    G.log('UIA 报发送成功但输入框还有 %d 字，补按一次回车' % len(leftover))
                    self.press_enter(False)
                return True
        except G.ChatIdentityError:
            raise
        except Exception as e:
            G.log_warn('UIA 发送异常：', repr(e))
        return False

    def recover_uia(self, reason=''):
        """强制重新热激活 UIA（rewrite gate byte + 校验），成功返回 True。

        微信跑久了会把 accessibility gate byte 归零，UIA 引擎就变成「假死」：
        能读消息、发不出去。以前只能重启桥接；这里让它自己救回来。
        """
        try:
            if self.gui is None:
                return False
            if not self.wechat_window_alive():
                with self.gui_lock:
                    self.UIA_CACHE['u'] = None
                G.log('UIA 重新热激活跳过（微信主窗当前不存在）')
                return False
            with self.gui_lock:
                u = self.gui._get_uia(refresh=True)
            self.UIA_CACHE['u'] = u
            if u is not None:
                G.log('UIA 已重新热激活%s' % ('（' + reason + '）' if reason else ''))
                return True
            G.log_warn('UIA 重新热激活失败%s' % ('（' + reason + '）' if reason else ''))
        except Exception as e:
            G.log('UIA 重新热激活异常：', repr(e))
        return False

    def keyboard_send(self, text, chat_display_name, chat_username=''):
        """完全不依赖 UIA 的发送通道：Ctrl+F 搜索会话 → 粘贴 → 回车 → 回读数据库确认。

        为什么需要它：UIA 依赖微信的 accessibility gate，微信跑久了/窗口状态怪的时候
        整条路都会挂（见 recover_uia 的注释）。键盘通道只用 Win32 按键 + 剪贴板，
        走的是微信自己的搜索框，不碰 accessibility。
        代价：会抢前台、慢一些，所以只在 UIA 真的发不出去时用。
        """
        if not self.account_send_allowed('键盘通道'):
            return False
        # S1：抢前台 + 搜索 + 回库确认一整套最久 ~10s，定期 touch 防误判
        G.touch()
        try:
            import ctypes
            import win32api
            import win32clipboard
            import win32con
            import win32gui
            user32 = ctypes.windll.user32
        except Exception as e:
            G.log('键盘通道不可用（缺少 win32 模块）：', repr(e))
            return False
        hwnd = int(self.ACCOUNT.get('hwnd') or 0) or self.find_weixin_hwnd()
        if not hwnd:
            G.log('键盘通道：找不到微信主窗')
            return False

        def fg():
            return user32.GetForegroundWindow()
        if fg() != hwnd:
            user32.keybd_event(win32con.VK_MENU, 0, 0, 0)
            G.time.sleep(0.05)
            user32.SetForegroundWindow(hwnd)
            G.time.sleep(0.2)
            user32.keybd_event(win32con.VK_MENU, 0, 2, 0)
            G.time.sleep(0.2)
        if fg() != hwnd:
            try:
                user32.SwitchToThisWindow(hwnd, True)
                G.time.sleep(0.3)
            except Exception:
                pass
        if fg() != hwnd:
            G.log('键盘通道：抢不到前台，放弃这次（UIA 也不可用时这条就发不出去了）')
            return False

        def set_clip(t):
            opened = False
            for _ in range(5):
                try:
                    win32clipboard.OpenClipboard()
                    opened = True
                    break
                except Exception:
                    G.time.sleep(0.1)
            if not opened:
                raise RuntimeError('剪贴板打不开（可能被别的程序占用）')
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, t)
            finally:
                win32clipboard.CloseClipboard()

        def get_clip():
            """读出剪贴板当前文本；没有文本/读不到返回 None（M6 还原用）。"""
            for _ in range(5):
                try:
                    win32clipboard.OpenClipboard()
                    try:
                        return win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
                    finally:
                        win32clipboard.CloseClipboard()
                except Exception:
                    G.time.sleep(0.1)
            return None

        def restore_clip(saved):
            """发完把用户剪贴板还回去（M6）：以前发完剪贴板里一直留着要发的内容。"""
            if saved is None:
                return
            try:
                set_clip(saved)
            except Exception as e:
                G.log('键盘通道：还原剪贴板失败：', repr(e))

        def tap(vk, mods=()):
            for m in mods:
                user32.keybd_event(m, 0, 0, 0)
            user32.keybd_event(vk, 0, 0, 0)
            user32.keybd_event(vk, 0, 2, 0)
            for m in reversed(mods):
                user32.keybd_event(m, 0, 2, 0)
            G.time.sleep(0.12)

        def confirmed_target():
            """打开会话后确认「现在开着的到底是谁」。

            键盘通道是模拟按键，搜不到人时回车会落到「当前那个会话」上，
            正文就直接发给别人了 —— 2026-10-25 12:21 的日志里就出现过
            「键盘通道：按键发了，但数据库里没确认到（可能发到了别的会话）」。
            这里用 UIA 的只读能力核对（读会话名在「能读不能发」的假死状态下依然可用）；
            读不到就宁可这条失败，也不盲发 —— 私聊内容发错人比晚回一条严重得多。
            返回 (是否匹配, 当前会话名)。
            """
            try:
                u = self.gui._get_uia() if self.gui is not None else None
                cur = u.current_chat() if u is not None else None
            except Exception:
                cur = None
            if not cur:
                return (None, None)
            cands = {chat_display_name}
            try:
                if chat_username:
                    cands.update(self.aliases_for(chat_username, chat_display_name))
                    cached = self.open_cache.get(chat_username)
                    if cached:
                        cands.add(cached)
            except Exception:
                pass
            return (cur in cands, cur)
        t_start = G.time.time()
        saved_clip = get_clip()
        try:
            tap(ord('F'), (win32con.VK_CONTROL,))
            G.time.sleep(0.5)
            set_clip(chat_display_name)
            tap(ord('V'), (win32con.VK_CONTROL,))
            G.time.sleep(0.8)
            tap(win32con.VK_RETURN)
            G.time.sleep(0.9)
            matched, cur = confirmed_target()
            if matched is None:
                G.log('键盘通道：读不到当前会话名，为防发错人这次不发')
                raise G.ChatIdentityError('键盘通道读不到当前会话名')
            if not matched:
                G.log('键盘通道：打开的是「%s」而不是「%s」，为防发错人这次不发' % (cur or '', chat_display_name))
                raise G.ChatIdentityError('键盘通道打开的是 %r 而不是 %r' % (cur, chat_display_name))
            set_clip(text)
            tap(ord('V'), (win32con.VK_CONTROL,))
            G.time.sleep(0.4)
            tap(win32con.VK_RETURN)
            want = str(text).strip()
            for _ in range(8):
                G.time.sleep(0.5)
                G.touch()
                try:
                    msgs = self.db.get_messages(chat_username or chat_display_name, limit=5) or []
                except Exception:
                    msgs = []
                for m in msgs:
                    try:
                        if float(m.get('create_time') or 0) <= t_start:
                            continue
                    except Exception:
                        continue
                    if str(m.get('content') or '').strip() == want:
                        return True
            G.log_error('键盘通道：按键发了，但数据库里没确认到（可能发到了别的会话），这条按失败处理')
            return False
        except G.ChatIdentityError:
            raise
        except Exception as e:
            G.log('键盘通道按键失败：', repr(e))
            return False
        finally:
            restore_clip(saved_clip)

    def chat_dead(self, chat_username):
        """会话是否仍在拉黑期（S3）。

        dead_chats 现在是 {username: 拉黑时间}：普通失败拉黑 10 分钟，到点自动
        放行一条探测（微信重启/窗口抖两下就能自愈，不用重启桥接）；
        「移出群聊」这类确定性证据写 inf，表示永久拉黑（age 为负一样命中）。
        """
        if not chat_username:
            return False
        ts = self.dead_chats.get(chat_username)
        if ts is None:
            return False
        try:
            if G.time.time() - float(ts) < 600:
                return True
        except (TypeError, ValueError):
            return True
        self.dead_chats.pop(chat_username, None)
        G.log('失效会话已到放行时间，重试一次：', chat_username)
        return False

    def _note_open_chat(self, key, ok):
        """记录同一目标连续几次打不开会话（S1 快速失败用）。

        只配合「bg 通道已说目标不在会话列表」使用：UIA open_chat（含搜索兜底）
        也连着打不开，说明这个目标真搜不到，再跑键盘/OCR 只会白烧看门狗预算。
        打开成功即清零。
        """
        if not key:
            return
        if ok:
            self.open_chat_fail.pop(key, None)
        else:
            self.open_chat_fail[key] = self.open_chat_fail.get(key, 0) + 1

    def _mark_send_ok(self, chat_username):
        """发送成功：清失败计数、解除会话拉黑、清打不开会话记录（S1/S3）。"""
        if not chat_username:
            return
        self.fail_streak.pop(chat_username, None)
        self.dead_chats.pop(chat_username, None)
        self.open_chat_fail.pop(chat_username, None)

    def send_policy_allows(self, chat_username, chat_display_name):
        # 排队、模型生成或语音合成期间都可能改名单，发送前向内核核对当前规则。
        base = self.bot_url.rsplit('/webhook', 1)[0]
        headers = {'x-whale-bridge': '1', 'x-bot-token': self.token}
        try:
            response = G.LOCAL_HTTP.post(base + '/api/wechat/send-permission', headers=headers,
                                         json={'chatId': chat_username, 'name': chat_display_name}, timeout=3)
            policy = response.json() if response.status_code == 200 else None
            if isinstance(policy, dict) and policy.get('ok') is True:
                if policy.get('allowed') is True:
                    return True
                reason = {'not_whitelisted': '不在白名单内', 'unresolved_chat': '无法确认会话 ID'}.get(policy.get('reason'), '已静音')
                G.log_throttled('send-policy-' + reason, '发言范围：' + reason + '，跳过发送', ttl=60)
                return False
        except Exception:
            pass
        G.log_throttled('send-policy-unavailable', '发言范围：内核未确认允许发送，已暂停', ttl=60)
        return False

    def send_text(self, text, chat_display_name, chat_username='', force=False, quote_text=None):
        if self.chat_dead(chat_username):
            G.log('跳过已失效的会话：', chat_display_name)
            return False
        if chat_username and (not self.group_is_alive(chat_username)):
            # 确定性证据（DB 里群成员没我）：永久拉黑（S3）
            self.dead_chats[chat_username] = float('inf')
            G.log('群里已经没有我了（被移出？），以后跳过：', chat_display_name)
            return False
        if not self.account_send_allowed('发送'):
            return False
        with self.send_lock, G._SendStateScope(len(text)):
            if not self.send_policy_allows(chat_username, chat_display_name):
                return False
            if not self.sticker_quarantine_allows(chat_username, chat_display_name):
                return False
            t_start = G.time.time()
            allow_mark_dead = True
            _bg_ran = False
            # 表情包开关不再牵连文字通道：零焦点通道被其他窗口盖住也能发
            # （窗口消息打字，全程不抢前台、不动别人的窗口）；表情包发送有
            # 自己独立的切前台逻辑（send_sticker），不需要这里让路。
            if G.BG_SEND.get('enabled', True):
                _bg_ran = True
                G.touch()
                try:
                    if self.bg_send(text, chat_display_name, chat_username):
                        self._mark_send_ok(chat_username)
                        G.log('发送成功（后台通道，%.1fs）→ %s' % (G.time.time() - t_start, chat_display_name))
                        return True
                except G.DraftDirtyError as e:
                    # 脏输入高发于「用户此刻正在微信里打字」：输入法组合吞掉 WM_CHAR，回读为空。
                    # 探测失败时输入已被重置，等 2.5 秒重试一次同一通道是安全的；再失败才放弃。
                    allow_mark_dead = False
                    G.log('发送暂停（%s），2.5 秒后重试一次后台通道' % e)
                    G.time.sleep(2.5)
                    G.touch()
                    try:
                        if self.bg_send(text, chat_display_name, chat_username):
                            self._mark_send_ok(chat_username)
                            G.log('发送成功（后台通道重试，%.1fs）→ %s' % (G.time.time() - t_start, chat_display_name))
                            return True
                        G.log_error('后台通道重试后仍未发出，放弃这条')
                        return False
                    except G.ChatIdentityError as e2:
                        G.log_error('会话核对没通过，这条不发（%s）：%s' % (chat_display_name, e2))
                        return False
                    except Exception as e2:
                        G.log('后台通道重试异常，继续用旧通道：', repr(e2))
                except G.ChatIdentityError as e:
                    G.log_error('会话核对没通过，这条不发（%s）：%s' % (chat_display_name, e))
                    return False
                except Exception as e:
                    G.log('后台通道异常，继续用旧通道：', repr(e))
                if not G.BG_SEND.get('fallback', True):
                    allow_mark_dead = False
                    G.log_error('后台通道失败且已关闭前台兜底，这条不发：', chat_display_name)
                    return False
            # S1 快速失败：bg 说目标不在会话列表 + UIA open_chat 也连着打不开
            # （本轮发送之前已记满 2 次），就别再把引用/UIA×2/热激活/键盘/OCR
            # 整条矩阵跑完——搜索兜底单次 8~20 秒，曾把看门狗逼成重启循环。
            _open_key = chat_username or chat_display_name
            _bg_chat_missing = (_bg_ran and self.BG_STATS.get('last') == 'chat_not_found'
                                and self.BG_STATS.get('lastAt', 0) >= t_start)
            if _bg_chat_missing and self.open_chat_fail.get(_open_key, 0) >= 2:
                G.log('发送放弃：%s 连续 2 次打不开会话（列表和搜索都找不到），本轮不再走前台通道' % chat_display_name)
                if chat_username and allow_mark_dead and G.time.time() - float(self.ACCOUNT.get('blockedAt') or 0) >= 30:
                    self.fail_streak[chat_username] = self.fail_streak.get(chat_username, 0) + 1
                    if self.fail_streak[chat_username] >= 2:
                        self.dead_chats[chat_username] = G.time.time()
                        G.log('连续发送失败，先停掉这个会话（10 分钟后自动放行探测）：', chat_display_name)
                return False
            # S1：前台通道矩阵结构长（单轮最多 5 次 uia_send、单次 open_chat 实测
            # 8~20s），把预算抬到 120s+打字时间、封顶 180s，防合法慢发送被误杀。
            G.ensure_budget(min(180.0, 120.0 + len(text) * 0.16))
            with self.gui_lock:
                if self.gui is None:
                    G.log('初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）')
                    self.gui = self.new_window_driver()
            self.bind_gui_window(self.gui)
            if quote_text and G.QUOTE_REPLY:
                G.touch()
                try:
                    if self.with_window_on_top(lambda: self.gui.quote_msg(text, who=chat_display_name, target_text=quote_text, verify=False)):
                        G.log('引用回复成功 →', chat_display_name)
                        return True
                except Exception as e:
                    G.log('引用回复失败，回退普通发送：', repr(e))
                G.touch()
            uia_available = False
            try:
                uia_available = self.gui._get_uia() is not None
            except Exception:
                uia_available = False
            for attempt in (1, 2):
                if _bg_chat_missing and self.open_chat_fail.get(_open_key, 0) >= 2:
                    G.log('UIA 通道：%s 连续打不开会话，跳过第 %d 次尝试' % (chat_display_name, attempt))
                    break
                t_att = G.time.time()
                G.touch()
                try:
                    if self.with_window_on_top(lambda: self.uia_send(text, chat_display_name, chat_username)):
                        self._mark_send_ok(chat_username)
                        G.log('发送成功（%.1fs）→ %s' % (G.time.time() - t_start, chat_display_name))
                        return True
                    G.log('UIA 发送未成功（第 %d 次，%.1fs），准备重试' % (attempt, G.time.time() - t_att))
                except G.ChatIdentityError as e:
                    G.log_error('会话核对没通过，这条不发（%s）：%s' % (chat_display_name, e))
                    return False
                except Exception as e:
                    G.log('UIA 发送异常（第 %d 次，%.1fs）：%r' % (attempt, G.time.time() - t_att, e))
                G.time.sleep(0.5)
            if uia_available and not (_bg_chat_missing and self.open_chat_fail.get(_open_key, 0) >= 2):
                if self.recover_uia('发送失败'):
                    try:
                        if self.with_window_on_top(lambda: self.uia_send(text, chat_display_name, chat_username)):
                            self._mark_send_ok(chat_username)
                            G.log('重新激活 UIA 后发送成功（%.1fs）→ %s' % (G.time.time() - t_start, chat_display_name))
                            return True
                    except G.ChatIdentityError as e:
                        G.log_error('会话核对没通过，这条不发（%s）：%s' % (chat_display_name, e))
                        return False
                    except Exception as e:
                        G.log('重新激活后仍失败：', repr(e))
                G.log('UIA 发不出去，跳过 OCR 兜底：', chat_display_name)
            else:
                G.log_throttled('uia-unavailable', 'UIA 不可用：先试键盘通道；如果一直这样，到启动器「诊断」页点「UIA 自检」看原因（常见：微信需要重新登录、鲸鱼娘不是管理员而微信是、微信缩在托盘）', ttl=600)
                G.log('UIA 不可用，走 OCR 兜底')
            if G.KEYBOARD_FALLBACK and not (_bg_chat_missing and self.open_chat_fail.get(_open_key, 0) >= 2):
                G.touch()
                try:
                    if self.keyboard_send(text, chat_display_name, chat_username):
                        self._mark_send_ok(chat_username)
                        G.log('发送成功（键盘通道，%.1fs）→ %s' % (G.time.time() - t_start, chat_display_name))
                        return True
                except G.ChatIdentityError as e:
                    G.log_error('会话核对没通过，这条不发（%s）：%s' % (chat_display_name, e))
                    return False
            if not uia_available and not (_bg_chat_missing and self.open_chat_fail.get(_open_key, 0) >= 2):
                G.touch()
                try:
                    with self.gui_lock:
                        try:
                            self.gui = self.new_window_driver()
                        except Exception as e:
                            G.log('重建窗口驱动失败：', repr(e))
                    self.bind_gui_window(self.gui)
                    _box = {}
                    _ocr_cancel = G.threading.Event()

                    def _ocr_send():
                        try:
                            if _ocr_cancel.is_set():
                                return
                            _box['r'] = self.with_window_on_top(lambda: not _ocr_cancel.is_set() and bool(self.gui.send_msg(text, chat_display_name, True)))
                        except Exception as _e:
                            _box['e'] = _e
                    _th = G.threading.Thread(target=_ocr_send, daemon=True)
                    _th.start()
                    _th.join(8)
                    G.touch()
                    if _th.is_alive():
                        G.log('OCR 兜底 8 秒没返回（卡在截屏），放弃这条，等下次消息')
                        _ocr_cancel.set()
                        resp = False
                    else:
                        if 'e' in _box:
                            raise _box['e']
                        resp = _box.get('r')
                    if bool(resp):
                        self._mark_send_ok(chat_username)
                        return True
                    G.log('兜底发送失败：%s' % resp)
                except Exception as e:
                    G.log('兜底发送异常：%r' % e)
            if chat_username and allow_mark_dead:
                if G.time.time() - float(self.ACCOUNT.get('blockedAt') or 0) < 30:
                    G.log('账号窗口没确认，这条不算会话失效，先不发：', chat_display_name)
                    return False
                self.fail_streak[chat_username] = self.fail_streak.get(chat_username, 0) + 1
                if self.fail_streak[chat_username] >= 2:
                    # S3：记时间戳，10 分钟后 chat_dead() 自动放行一条探测；
                    # 以前是 set 永久拉黑，微信重启一下这个会话就永远不回了。
                    self.dead_chats[chat_username] = G.time.time()
                    G.log('连续发送失败，先停掉这个会话（10 分钟后自动放行探测）：', chat_display_name)
            G.log_error('发送最终失败，请把微信窗口保持在桌面、别最小化（这条 %d 字，正文不写日志）' % len(text))
            return False

    def send_at(self, member, text, chat_display_name, chat_username=''):
        """在群里真 @ 某个成员（UI 选人），失败返回 False 让调用方退回普通发送。"""
        if not member or not text:
            return False
        if chat_username and (self.chat_dead(chat_username) or not self.group_is_alive(chat_username)):
            return False
        if not self.account_send_allowed('@ 成员'):
            return False
        with self.send_lock, G._SendStateScope(len(text)):
            if not self.send_policy_allows(chat_username, chat_display_name):
                return False
            if not self.sticker_quarantine_allows(chat_username, chat_display_name):
                return False
            with self.gui_lock:
                if self.gui is None:
                    G.log('初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）')
                    self.gui = self.new_window_driver()
            self.bind_gui_window(self.gui)
            try:
                ok = bool(self.with_window_on_top(lambda: self.gui.at_member(member, text, who=chat_display_name, verify=False)))
                if ok:
                    G.log('已 @ %s → %s' % (member, chat_display_name))
                    return True
                G.log('@ 成员失败（%s），改用普通发送' % member)
            except Exception as e:
                G.log('@ 成员异常：', repr(e))
        return False
