# -*- coding: utf-8 -*-
"""bridge composition root: creates BridgeRuntime and runs start()."""
import engine as G
from account_mixin import AccountMixin
from window_mixin import WindowMixin
from sender_mixin import SenderMixin
from sticker_mixin import StickerMixin
from voice_mixin import VoiceMixin
from receiver_mixin import ReceiverMixin
from loop_mixin import LoopMixin


class BridgeRuntime(AccountMixin, WindowMixin, SenderMixin, StickerMixin, VoiceMixin, ReceiverMixin, LoopMixin):

    def start(self):
        G.boot('进入 main()')
        if '--list-accounts' in G.sys.argv:
            return G.list_accounts_cli()
        if '--bg-probe' in G.sys.argv or '--bg-send' in G.sys.argv:
            return G._bg_cli()
        try:
            import bg_sender
            bg_sender.ensure_dpi_aware()
        except Exception:
            pass
        self.ffmpeg_exe = G.ensure_ffmpeg_env()
        try:
            import ctypes
            if not ctypes.windll.shell32.IsUserAnAdmin():
                G.log_warn('[!] 当前不是管理员：如果微信也是管理员运行的，零焦点发送会用不了（UIPI）。')
                G.log('    启动器本身以管理员运行，桥接继承同一权限；命令行手动跑请用管理员终端。')
        except Exception:
            pass
        if any((ord(ch) > 127 for ch in G.ROOT)):
            G.log_warn('[!] 路径里有中文/非英文字符：', G.ROOT)
            G.log('    微信 UI 自动化在这种路径下会失败（发送一直报「拒绝访问」）。')
            G.log('    请把整个文件夹移到纯英文路径再启动，例如 D:\\whale-girl-3.0')
        # 单实例锁：占一个本地 TCP 端口。bind 失败不一定是「已有实例」——端口被系统
        # 保留时（WSL2 镜像网络会把宿主机一整段端口保留掉，见 bridge/instance_lock.py）
        # 报的是一模一样的 WSAEADDRINUSE。所以交给 instance_lock 分清楚：
        #   能连上 → 真的已有实例，正常退出；连不上 → 端口不可用，报明确错误并非 0 退出。
        _lock_sock = None
        try:
            import instance_lock as _lock
            _state = _lock.acquire(getattr(G, 'BRIDGE_LOCK_PORTS', (G.BRIDGE_LOCK_PORT,)))
            if _state['status'] == 'running':
                G.log('已经有一个桥接在跑了（端口 %s 被占用且能连上），本进程退出' % _state['port'])
                return 0
            if _state['status'] != 'ok':
                G.log_error('单实例锁端口全都用不了，桥接起不来。这不是「已有实例」，是端口被系统保留：')
                G.log_error('  %s' % _lock.describe(_state))
                G.log_error('  本机常见原因：WSL2 开了镜像网络（.wslconfig 里 networkingMode=mirrored），')
                G.log_error('  它把 Linux 虚拟机的临时端口段整段保留在宿主机上（本机实测 44620-48715）。')
                G.log_error('  这段端口 netstat 里看不到占用者，netsh excludedportrange 也不列。')
                G.log_error('  处理：换 bridge/engine.py 里的 BRIDGE_LOCK_PORTS，或 wsl --shutdown，')
                G.log_error('        或去掉 .wslconfig 里的 networkingMode=mirrored。')
                return 3
            _lock_sock = _state['sock']
            G.boot('单实例锁已获取（端口 %s）' % _state['port'])
        except Exception as e:
            # 锁模块本身出问题（比如漏拷文件）不该拦住桥接：退回「不占锁」继续跑，只是不挡双开。
            G.log_warn('[!] 单实例锁没装上（%r），这次不挡双开。' % (e,))
            _lock_sock = None
        try:
            import faulthandler
            # I1：启动时把超大的 hang/crash 日志截断（以前只增不减，也没有轮转）
            for _name in ('bridge-hang.log', 'bridge-crash.log'):
                try:
                    _p = G.os.path.join(G.ROOT, 'data', _name)
                    if G.os.path.exists(_p) and G.os.path.getsize(_p) > 5 * 1024 * 1024:
                        with open(_p, 'w', encoding='utf-8') as _f:
                            _f.write('（超过 5MB，启动时已截断轮转）\n')
                        G.boot('%s 超过 5MB，已截断' % _name)
                except Exception:
                    pass
            try:
                _hang_file = open(G.os.path.join(G.ROOT, 'data', 'bridge-hang.log'), 'a', encoding='utf-8')

                def _hang_watch():
                    # I1：旧实现 dump_traceback_later(40, repeat=True) 不管卡没卡，
                    # 每 40 秒都把全线程堆栈追加一遍，一天能长 20MB+。改成只有
                    # 「发送临界区 active 且 40 秒无进度」才转储一次；start 被
                    # touch() 刷新即视为有进度，同一卡死事件不重复转储。
                    dumped_start = None
                    while True:
                        G.time.sleep(10)
                        try:
                            st = G.SEND_STATE
                            if not st.get('active'):
                                dumped_start = None
                                continue
                            start = float(st.get('start') or 0)
                            gap = G.time.time() - start
                            if gap < 40:
                                dumped_start = None
                                continue
                            if dumped_start == start:
                                continue
                            _hang_file.write('\n==== 疑似卡死：发送 %.0f 秒无进度（pid=%d）====\n' % (gap, G.os.getpid()))
                            _hang_file.flush()
                            faulthandler.dump_traceback(file=_hang_file, all_threads=True)
                            _hang_file.flush()
                            dumped_start = start
                        except Exception:
                            pass
                G.threading.Thread(target=_hang_watch, daemon=True, name='hang-watch').start()
                G.boot('已开启卡死堆栈转储（仅发送 40 秒无进度时转储一次）')
            except Exception:
                pass
            try:
                _crash_file = open(G.os.path.join(G.ROOT, 'data', 'bridge-crash.log'), 'a', encoding='utf-8')
                _crash_file.write('\n==== %s 进程启动（pid=%d）====\n' % (G.time.strftime('%Y-%m-%d %H:%M:%S'), G.os.getpid()))
                _crash_file.flush()
                faulthandler.enable(file=_crash_file, all_threads=True)
                G.boot('已开启崩溃堆栈记录（data/bridge-crash.log）')
            except Exception:
                pass
            G.boot('开始 import requests')
            import requests
            G.boot('开始 import wechatauto（可能较慢，10~20 秒）')
            from wechatauto import MediaDownloader, WeChatDB, WeChatGUI
            from wechatauto.db import Listener
            self.MediaDownloader = MediaDownloader
            self.WeChatDB = WeChatDB
            self.WeChatGUI = WeChatGUI
            _here = G.os.path.dirname(G.os.path.abspath(__file__))
            if _here not in G.sys.path:
                G.sys.path.insert(0, _here)
            G.os.environ.setdefault('WHALE_STEPLOG', '1')
            G.boot('应用 uia_compat 补丁')
            try:
                import uia_compat
                G.boot('uia_compat.apply() = %r' % (uia_compat.apply(),))
            except Exception as _compat_err:
                try:
                    import importlib.util as _ilu
                    _spec = _ilu.spec_from_file_location('uia_compat', G.os.path.join(G.ROOT, 'examples', 'uia_compat.py'))
                    _mod = _ilu.module_from_spec(_spec)
                    G.sys.modules['uia_compat'] = _mod
                    _spec.loader.exec_module(_mod)
                    _mod.apply()
                    G.boot('uia_compat 已按文件路径加载并生效')
                except Exception:
                    G.boot('uia_compat 未生效: %r' % (_compat_err,))
            G.boot('import 完成')
        except Exception as e:
            G.boot('导入失败: %r' % (e,))
            G.log_error('缺少依赖或导入失败：', e)
            _msg = '%s %s' % (type(e).__name__, e)
            _dll_issue = isinstance(e, OSError) or 'DLL load failed' in _msg or 'WinError 126' in _msg or ('WinError 127' in _msg) or ('找不到指定的模块' in _msg) or ('mfc' in _msg.lower()) or ('vcruntime' in _msg.lower())
            if _dll_issue:
                G.log('')
                G.log('[!] 这不是缺 Python 包，是本机缺 VC++ 运行库（wechatauto-replica 的原生模块要用）。')
                G.log('    装这个（选 x64）：https://aka.ms/vs/17/release/vc_redist.x64.exe')
                G.log('    装完重启电脑，再回启动器「微信 · 桥接」页点「重启桥接」。')
                G.log('    提示：Windows Server 默认不装 MFC，家庭版/专业版一般已有。')
            else:
                G.log('请先运行："%LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe" -m pip install wechatauto-replica requests')
            return 1
        self.cfg = G.read_config()
        self.token = G.bridge_config.wechat_token(self.cfg)
        self.bot_url = G.build_bot_url(self.cfg)
        self.aliases = ((self.cfg.get('persona') or {}).get('aliases') or []) + [(self.cfg.get('persona') or {}).get('name') or '鲸鲸']
        G.log('引用回复：%s（%s）' % ('开' if G.QUOTE_REPLY else '关', '关掉更快，需要时把 config.json 的 wechat.quoteReply 设为 false' if G.QUOTE_REPLY else '需要引用上下文时把 config.json 的 wechat.quoteReply 设为 true'))
        G.log('连接微信 4.x 数据库（只读）…')
        if self.token:
            G.log('webhook token：已读取（长度 %d，内容不进日志）' % len(self.token))
        else:
            G.log('⚠️ webhook token 是空的！检查 config.json 的 gateway.wechat.inboundToken（文件要能正常解析）')
        self.db_dir = G.resolve_db_dir()
        if self.db_dir:
            G.log('数据库目录：', self.db_dir)
        self.acct_dirs = G.find_account_dirs(self.db_dir) if self.db_dir else []
        self.acct = G.ACCOUNT_WANTED
        if self.acct:
            hit = G.resolve_account_dir(self.db_dir, self.acct) if self.db_dir else ''
            if not hit:
                G.log('')
                G.log('✗ 找不到微信账号 %r。' % self.acct)
                G.log('  这台机器上现有账号：%s' % ('、'.join(self.acct_dirs) or '（一个都没有）'))
                G.log('  去启动器「微信桥接」页点一下账号卡，或把 config.json 的')
                G.log('  wechat.account 改成上面某个名字（目录名 / wxid / 昵称都行，留空=自动选）。')
                G.log('  这里直接停下，不会偷偷换成别的号。')
                return 2
            if hit != self.acct:
                G.log('配置账号 %r → 账号目录 %s' % (self.acct, hit))
            self.acct = hit
            G.log('指定账号：', self.acct, '（网页设置 / config.json → wechat.account）')
        elif len(self.acct_dirs) > 1:
            G.log('⚠️ 这台机器有 %d 个微信账号：%s' % (len(self.acct_dirs), '、'.join(self.acct_dirs)))
            G.log('   没指定账号 → 按「最近活跃」自动选，可能选到大号。')
            G.log('   去启动器「微信桥接」页点一下账号卡（推荐：只选小号）。')
        G.log('打开微信数据库（这一步偶尔会卡，最多等 90 秒）…')
        _db_box = self._open_db_with_timeout(90)
        if _db_box.get('timeout'):
            G.log('')
            G.log('✗ 打开微信数据库卡住超过 90 秒，已放弃这次启动（不是崩溃，是卡死）。')
            G.log('  常见原因：微信没完全登录 / 数据库被占用 / 微信正在更新。')
            G.log('  处理：确认微信已登录 → 重启微信 → 再在启动器「微信 · 桥接」页点「重启桥接」。')
            G.log('  如果反复卡住，把 data\\bridge-hang.log 和这段日志发给作者。')
            G.log('  注：卡住的 open-db 线程会作为孤儿线程留到进程退出，属已知现象，不影响下次启动。')
            return 2
        self.db = _db_box.get('db')
        _db_err = _db_box.get('err')
        try:
            if _db_err is not None:
                raise _db_err
        except RuntimeError as e:
            G.log('')
            G.log('✗ 找不到微信的数据库目录，读不到消息。按顺序检查：')
            G.log('  1) 微信 4.x 是不是已经登录了？（停在扫码/登录界面时还没有数据库）')
            G.log('  2) 微信 → 左下角三条杠 → 设置 → 文件管理 → 「微信文件默认保存位置」')
            G.log('     把那个路径填进 config.json："wechat": { "dbDir": "E:\\\\xwechat_files" }')
            G.log('     （填到 xwechat_files 这一层，不是里面的 wxid_xxx 目录）')
            G.log('  3) 保存后在启动器「微信 · 桥接」页点「重启桥接」')
            G.log('  原始错误：%s' % e)
            return 2
        except Exception as e:
            G.log('')
            G.log_error('✗ 打开微信数据库失败（%s）：%s' % (type(e).__name__, e))
            G.log('  按顺序检查：1) 微信 4.x 已登录？2) config.json 的 wechat.dbDir 填对没有；')
            G.log('  3) 在启动器里重启桥接；还不行就把这段日志发给作者。')
            return 2
        if self.acct and self.db.account != self.acct:
            G.log('')
            G.log('✗ 账号被库自己换掉了：要的是 %s，实际打开的是 %s。' % (self.acct, self.db.account))
            G.log('  多半是微信当前登录的是另一个号，取到的密钥解不开 %s 的库。' % self.acct)
            G.log('  请确认微信现在登录的就是小号，再在启动器里点「重启桥接」。')
            G.log('  （这里直接停下，绝不会用 %s 继续跑。）' % self.db.account)
            return 2
        self._media_box = {'downloader': None}
        self._media_lock = G.threading.Lock()
        self.me = self.db.wxid
        self._self_nick = ''
        try:
            info = self.db.get_self_info() or {}
            self._self_nick = str(info.get('nick_name') or info.get('remark') or '').strip()
            G.log('当前登录账号：', self._self_nick or self.me)
        except Exception:
            G.log('当前登录账号 wxid：', self.me)
        G.log('账号目录：', self.db.account, '（网页/config 指定）' if self.acct else '（自动选：最近活跃）')
        if len(self.acct_dirs) > 1:
            G.log('（这台机器有 %d 个账号目录：%s）' % (len(self.acct_dirs), '、'.join(self.acct_dirs)))
        G.log('数据库目录：', self.db.db_dir)
        G.threading.Thread(target=self._heal_accounts_cache, daemon=True, name='accounts-cache').start()
        self.sessions = {}
        try:
            for s in self.db.get_sessions(limit=800):
                self.sessions[s['username']] = s
        except Exception as e:
            G.log_warn('读取会话列表失败：', e)
        self.name_cache = {}
        self.alias_cache = {}
        self.open_cache = {}
        self.gui = None
        self.gui_lock = G.threading.Lock()
        self.send_lock = G.threading.Lock()
        self.account_lock = G.threading.RLock()
        # S3：dead_chats 改成 {username: 拉黑时间}，普通失败 10 分钟后自动
        # 放行一条探测（chat_dead）；「移出群聊/群里没我」写 inf 永久拉黑。
        self.dead_chats = {}
        self.fail_streak = {}
        # S1：同一目标连续打不开会话的记账（连续 2 次放弃整条前台通道矩阵）
        self.open_chat_fail = {}
        self.self_wxid = self.db.wxid
        self.ACCOUNT = {'hwnd': 0, 'verified': False, 'why': '', 'label': ''}
        self._pin_cache = {'mtime': None, 'wanted': '', 'dir': ''}
        self.UIA_CACHE = {'u': None}
        self.BG_STATS = {'tried': 0, 'ok': 0, 'last': '', 'lastAt': 0.0, 'disabled': False, 'treeFails': 0, 'cooldownUntil': 0.0}
        self.sticker_draft_quarantine = {}
        self.sticker_headers = {'x-bot-token': self.token, 'x-whale-bridge': '1'}
        self.sticker_base = self.bot_url.rsplit('/webhook', 1)[0]
        if not G.wait_for_server(self.bot_url, timeout=30):
            return 2
        G.log('开始监听新消息…（Ctrl+C 退出）')
        self.pipeline = G.MessagePipeline(workers=G.PIPELINE_WORKERS, per_chat_limit=G.PIPELINE_QUEUE_LIMIT, log=G.log)
        self.batches = G.MessageBatches(limit=max(4, G.PIPELINE_QUEUE_LIMIT * 2), log=G.log,
                                        flush_due=self.submit_flush)
        G.log('消息调度：%d 个 worker（同一会话串行、跨会话并发，连发的几条合并成一次）' % G.PIPELINE_WORKERS)
        G.threading.Thread(target=self.sticker_test_loop, daemon=True).start()
        G.threading.Thread(target=self.voice_test_loop, daemon=True, name='voice-send-test').start()
        self.listener = Listener(self.db, interval=0.4)
        self.listener.add_all(self.on_message)
        self.listener.start()
        self.BATTERY_SENT = {'done': False}
        self._UIA_READY = {'ts': 0.0, 'ok': None, 'msg': '', 'res': None}
        G.threading.Thread(target=self.config_watch, daemon=True).start()
        G.threading.Thread(target=self.warmup, daemon=True).start()
        G.threading.Thread(target=self.send_watchdog, daemon=True).start()
        G.threading.Thread(target=self.battery_watch, daemon=True).start()
        G.threading.Thread(target=self.care_watch, daemon=True).start()
        G.threading.Thread(target=self.bridge_heartbeat, daemon=True).start()
        G.threading.Thread(target=self.listener_watch, daemon=True).start()
        G.threading.Thread(target=self.contacts_sync_once, daemon=True).start()
        G.REMINDER_RUNNER = self.start_reminder_watch()
        G.log('已启动。鲸鲸地址：', self.bot_url)
        try:
            import json as _json, datetime as _dt
            with open(G.os.path.join(G.ROOT, 'data', 'bridge-ready.json'), 'w', encoding='utf-8') as _rf:
                _json.dump({'readyAt': _dt.datetime.now().isoformat(timespec='seconds'), 'pid': G.os.getpid(), 'botUrl': self.bot_url, 'ffmpeg': self.ffmpeg_available()}, _rf, ensure_ascii=False)
        except Exception:
            pass
        try:
            while True:
                G.time.sleep(1)
        except KeyboardInterrupt:
            G.log('正在退出…')
            if G.REMINDER_RUNNER is not None:
                try:
                    G.REMINDER_RUNNER.stop()
                except Exception:
                    pass
            try:
                self.pipeline.close(wait=False)
            except Exception:
                pass
            self.listener.stop()
        return 0


def main():
    return BridgeRuntime().start()
