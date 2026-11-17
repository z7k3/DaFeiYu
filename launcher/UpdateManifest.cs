using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    /// <summary>更新策略：正常 / 只提示 / 强制 / 禁止启动。</summary>
    public enum UpdatePolicy
    {
        Ok,
        Warn,
        Force,
        Kill
    }

    /// <summary>清单模型：新名单缺失才兼容旧协议，名单写错时不能扩大强制范围。</summary>
    public sealed class UpdateManifest
    {
        public string Latest { get; set; } = "";
        public int Epoch { get; set; }
        public string BrandLatest { get; set; } = "";
        public string Target { get; set; } = "";
        public UpdateManifest Copy() => (UpdateManifest)MemberwiseClone();
        public DateTimeOffset ReleasedAt { get; set; }
        public double ForceAfterHours { get; set; } = 24;
        public bool? Force { get; set; }
        public string ForceFrom { get; set; } = "";
        // null 表示旧协议；空数组表示新协议明确不强制，二者不能在缓存中混淆。
        public string[] ForceVersions { get; set; }
        public string KillBelow { get; set; } = "";
        public string Message { get; set; } = "";
        public string UpdateWarning { get; set; } = "";
        public string UpdateWarningVersion { get; set; } = "";
        public string ReleaseNotes { get; set; } = "";
        public string ReleaseDetails { get; set; } = "";
        public int ManifestVersion { get; set; }
    }

    public sealed class ManifestCheck
    {
        public UpdateManifest Manifest { get; set; }
        public UpdatePolicy Policy { get; set; } = UpdatePolicy.Ok;
        public bool HasUpdate { get; set; }
        public bool FromCache { get; set; }
        public string Current { get; set; } = "";
        public string Error { get; set; } = "";
    }

    /// <summary>
    /// 读 release-manifest.json 并判定要不要更新。
    ///
    /// 为什么不用 GitHub API：未认证 60 次/小时/IP，国内还经常不通；而且 API 只回答
    /// 「有没有新版」，回答不了「这一步还让不让用」。清单放在仓库和 Release 资产里，
    /// 你改一行就能刹车，不需要发版。
    ///
    /// 多源同时拉、取 manifest_version 最大的那个：jsDelivr 会给旧缓存，只要别的源给了
    /// 新序号就以新的为准；缓存也参与比较，不能把 CDN 的旧响应当成最新策略。
    /// </summary>
    public static class UpdateManifestService
    {
        public static string ReleaseWarning(UpdateManifest manifest)
        {
            // 限定到本次版本，避免下一版继承旧清单后仍显示桥接专用警告。
            if (manifest == null || string.IsNullOrWhiteSpace(manifest.UpdateWarningVersion)
                || !string.Equals(manifest.Latest, manifest.UpdateWarningVersion, StringComparison.Ordinal)) return "";
            return (manifest.UpdateWarning ?? "").Trim();
        }

        public static string ReleaseSummary(UpdateManifest manifest)
        {
            var notes = !string.IsNullOrWhiteSpace(manifest?.ReleaseNotes) ? manifest.ReleaseNotes : manifest?.Message;
            var lines = (notes ?? "").Replace("\r", "").Split('\n')
                .Where(line => !Regex.IsMatch(line, @"^\s*(?:#{1,6}\s|$)|^\s{2,}[-*]\s"))
                .Select(line => FormatReleaseLine(line.Trim()))
                .Where(line => line.Length > 0)
                .Take(5)
                .Select(line =>
                {
                    var text = new StringInfo(line);
                    return text.LengthInTextElements > 62 ? text.SubstringByTextElements(0, 61) + "…" : line;
                });
            var summary = string.Join("\n", lines);
            return summary.Length > 0 ? summary : "该版本暂未提供更新摘要。";
        }

        public static string ReleaseDetails(UpdateManifest manifest)
        {
            var notes = !string.IsNullOrWhiteSpace(manifest?.ReleaseDetails) ? manifest.ReleaseDetails : manifest?.ReleaseNotes;
            return string.Join("\n", (notes ?? "").Replace("\r", "").Split('\n').Select(FormatReleaseLine)).Trim();
        }

        private static string FormatReleaseLine(string line)
        {
            var plain = Regex.Replace(line, @"^\s*#{1,6}\s+", "");
            plain = Regex.Replace(plain, @"\[([^\]]+)\]\([^)]*\)", "$1").Replace("`", "");
            return Regex.Replace(plain, @"^([ \t]*)[-*]\s+", "$1• ");
        }

        private const string Repo = "Banan1cee/whale_girl";

        // 顺序不重要（并行拉），但源要覆盖三种网络：GitHub 直连 / 墙内镜像 / CDN 兜底。
        private static readonly string[] Sources =
        {
            "https://github.com/" + Repo + "/releases/latest/download/release-manifest.json",
            "https://raw.githubusercontent.com/" + Repo + "/main/release-manifest.json",
            "https://gh-proxy.com/https://raw.githubusercontent.com/" + Repo + "/main/release-manifest.json",
            "https://cdn.jsdelivr.net/gh/" + Repo + "@main/release-manifest.json",
        };

        private static readonly HttpClient Http = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            // 启动时不该被网络拖住：拿不到就按缓存 / 放行。
            Timeout = TimeSpan.FromSeconds(4)
        };

        public static string CachePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "WhaleGirl", "update-state.json");

        /// <summary>安装目录里的版本号。优先 package.json（和界面显示同一份），读不到退化到程序集版本。</summary>
        public static string LocalVersion(string baseDir)
        {
            try
            {
                var p = Path.Combine(baseDir, "package.json");
                if (File.Exists(p))
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(p));
                    if (doc.RootElement.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.String)
                    {
                        var s = v.GetString();
                        if (!string.IsNullOrWhiteSpace(s)) return s.Trim();
                    }
                }
            }
            catch { }
            try
            {
                var asm = typeof(UpdateManifestService).Assembly.GetName().Version;
                if (asm != null) return asm.Major + "." + asm.Minor + "." + asm.Build;
            }
            catch { }
            return "";
        }

        public static int LocalEpoch(string baseDir)
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(baseDir, "package.json")));
                return Int(doc.RootElement, "updateEpoch");
            }
            catch { return 0; }
        }

        // 保留原始清单用于缓存；只把选中轨道交给现有 UI 和安装流程。
        public static UpdateManifest Resolve(string local, int localEpoch, UpdateManifest source)
        {
            if (source == null) return null;
            var m = source.Copy();
            if (localEpoch <= 0) return m;
            if (m.Epoch < localEpoch)
            {
                m.Latest = local;
                return m;
            }
            var version = string.IsNullOrWhiteSpace(m.BrandLatest) ? m.Latest : m.BrandLatest;
            var target = string.IsNullOrWhiteSpace(m.Target) ? version : m.Target;
            // 展示版本与安装包版本必须一致，不能提示一个版本却安装另一个。
            if (string.IsNullOrWhiteSpace(version) || target != version)
            {
                m.Latest = local;
                return m;
            }
            m.Latest = version;
            if (m.Epoch > localEpoch)
            {
                // 跨代时数字版本可能降低，旧代的强制阈值不能混入新代。
                m.KillBelow = "";
                m.ForceFrom = "";
                if (m.ForceVersions != null) m.ForceVersions = Array.Empty<string>();
            }
            return m;
        }

        public static bool HasUpdate(string local, int localEpoch, UpdateManifest source)
        {
            if (source == null || string.IsNullOrWhiteSpace(local)) return false;
            var m = Resolve(local, localEpoch, source);
            if (localEpoch > 0 && source.Epoch < localEpoch) return false;
            if (localEpoch > 0 && source.Epoch > localEpoch)
                return m.Latest != local && !string.IsNullOrWhiteSpace(m.Latest);
            return CompareVersion(local, m.Latest) < 0;
        }

        /// <summary>拉清单并判定。永不抛：任何异常都变成「拿不到 + 放行」。</summary>
        public static async Task<ManifestCheck> FetchAsync(string baseDir)
        {
            var result = new ManifestCheck();
            result.Current = LocalVersion(baseDir);

            var cached = LoadCache();
            UpdateManifest best = cached;
            try
            {
                var all = await Task.WhenAll(Sources.Select(DownloadAsync));
                best = SelectNewest(all, cached);
            }
            catch { }

            if (best != null)
            {
                result.Manifest = best;
                result.FromCache = ReferenceEquals(best, cached);
                if (result.FromCache) result.Error = "没有更新的在线策略，用的是上次缓存的策略";
                else SaveCache(best);
            }
            else
            {
                result.Error = "拿不到更新清单（断网 / 被墙）";
                return result;   // 从没成功过就放行，不拦人
            }

            try
            {
                var epoch = LocalEpoch(baseDir);
                var source = result.Manifest;
                result.HasUpdate = HasUpdate(result.Current, epoch, source);
                result.Manifest = Resolve(result.Current, epoch, source);
                // 已由代次确认跨代，不能再让旧代的大版本号拦住策略判断。
                var policyVersion = epoch > 0 && source.Epoch > epoch ? "0.0.0" : result.Current;
                result.Policy = result.HasUpdate
                    ? Decide(policyVersion, result.Manifest, DateTimeOffset.UtcNow)
                    : UpdatePolicy.Ok;
            }
            catch (Exception ex)
            {
                // 清单写错时降级成「只提示」：宁可少拦，不能把所有人关在门外
                result.Policy = UpdatePolicy.Warn;
                result.Error = "清单解析异常：" + ex.Message;
            }
            return result;
        }

        /// <summary>
        /// 精确名单存在时完整接管强制策略，未命中也不能回落到旧布尔或时间闸。
        /// kill_below 仍是独立熔断；旧字段只用于兼容没有名单的清单。
        /// </summary>
        public static UpdatePolicy Decide(string local, UpdateManifest m, DateTimeOffset now)
        {
            if (m == null || string.IsNullOrWhiteSpace(m.Latest)) return UpdatePolicy.Ok;
            if (string.IsNullOrWhiteSpace(local)) return UpdatePolicy.Ok;   // 版本号都读不到，别猜
            if (CompareVersion(local, m.Latest) >= 0) return UpdatePolicy.Ok;

            if (!string.IsNullOrWhiteSpace(m.KillBelow) && CompareVersion(local, m.KillBelow) < 0)
                return UpdatePolicy.Kill;

            if (m.ForceVersions != null)
                return IsPolicyVersion(local) && m.ForceVersions.Any(v => IsPolicyVersion(v) && CompareVersion(local, v) == 0)
                    ? UpdatePolicy.Force : UpdatePolicy.Warn;

            if (m.Force == true)
            {
                // 仅兼容旧清单：实际范围是 [force_from, latest)，不是精确的上一版本。
                if (!string.IsNullOrWhiteSpace(m.ForceFrom) && CompareVersion(local, m.ForceFrom) < 0)
                    return UpdatePolicy.Warn;
                return UpdatePolicy.Force;
            }
            if (m.Force == false) return UpdatePolicy.Warn;

            // released_at 解析不出来 → 当成「还没到点」，只提示
            if (m.ReleasedAt == default) return UpdatePolicy.Warn;
            var due = m.ReleasedAt.AddHours(Math.Max(0, m.ForceAfterHours));
            return now >= due ? UpdatePolicy.Force : UpdatePolicy.Warn;
        }

        /// <summary>逐段数值比较，3.9 &lt; 3.64。</summary>
        public static int CompareVersion(string a, string b)
        {
            var x = VersionParts(a);
            var y = VersionParts(b);
            for (var i = 0; i < 4; i++)
            {
                if (x[i] > y[i]) return 1;
                if (x[i] < y[i]) return -1;
            }
            return 0;
        }

        private static int[] VersionParts(string v)
        {
            var parts = new int[4];
            if (string.IsNullOrWhiteSpace(v)) return parts;
            var s = v.Trim().TrimStart('v', 'V');
            var idx = 0;
            foreach (var piece in s.Split(new[] { '.', '-', '+', '_', ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (idx >= 4) break;
                var digits = new string(piece.TakeWhile(char.IsDigit).ToArray());
                if (digits.Length == 0) continue;
                if (int.TryParse(digits, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n))
                    parts[idx++] = n;
            }
            return parts;
        }

        private static bool IsPolicyVersion(string value)
            => value != null && Regex.IsMatch(value, @"^[vV]?[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$")
                && value.TrimStart('v', 'V').Split('.').All(part => int.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out _));

        private static string[] ParseForceVersions(JsonElement value)
        {
            if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() > 256) return Array.Empty<string>();
            var versions = new List<string>();
            foreach (var item in value.EnumerateArray())
            {
                // 一项写错就降级成空名单，不能忽略坏项后意外执行旧全员强制。
                if (item.ValueKind != JsonValueKind.String || !IsPolicyVersion(item.GetString())) return Array.Empty<string>();
                versions.Add(item.GetString().TrimStart('v', 'V'));
            }
            return versions.Distinct().ToArray();
        }

        internal static UpdateManifest SelectNewest(IEnumerable<UpdateManifest> candidates, UpdateManifest cached)
        {
            var best = cached;
            foreach (var candidate in candidates)
                if (candidate != null && (best == null || candidate.ManifestVersion > best.ManifestVersion)) best = candidate;
            return best;
        }

        private static async Task<UpdateManifest> DownloadAsync(string url)
        {
            try
            {
                using var res = await Http.GetAsync(url);
                if (!res.IsSuccessStatusCode) return null;
                var text = await res.Content.ReadAsStringAsync();
                return Parse(text);
            }
            catch
            {
                return null;
            }
        }

        private static UpdateManifest Parse(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return null;
            using var doc = JsonDocument.Parse(text);
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return null;

            var m = new UpdateManifest { Latest = Str(r, "latest") };
            m.Epoch = Int(r, "epoch");
            m.BrandLatest = Str(r, "brand_latest");
            m.Target = Str(r, "target");
            if (string.IsNullOrWhiteSpace(m.Latest)) return null;

            if (r.TryGetProperty("released_at", out var ra) && ra.ValueKind == JsonValueKind.String
                && DateTimeOffset.TryParse(ra.GetString(), CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal, out var when))
                m.ReleasedAt = when;

            if (r.TryGetProperty("force_after_hours", out var fh))
            {
                if (fh.ValueKind == JsonValueKind.Number && fh.TryGetDouble(out var h)) m.ForceAfterHours = h;
                else if (fh.ValueKind == JsonValueKind.String && double.TryParse(fh.GetString(), out var hs)) m.ForceAfterHours = hs;
            }

            if (r.TryGetProperty("force", out var f))
            {
                if (f.ValueKind == JsonValueKind.True) m.Force = true;
                else if (f.ValueKind == JsonValueKind.False) m.Force = false;
                else m.Force = null;   // null / 缺省 = 按时间闸
            }

            m.KillBelow = Str(r, "kill_below");
            m.ForceFrom = Str(r, "force_from");
            if (r.TryGetProperty("force_versions", out var versions)) m.ForceVersions = ParseForceVersions(versions);
            m.Message = Str(r, "message");
            m.UpdateWarning = Str(r, "update_warning");
            m.UpdateWarningVersion = Str(r, "update_warning_version");
            m.ReleaseNotes = Str(r, "release_notes");
            m.ReleaseDetails = Str(r, "release_details");
            if (r.TryGetProperty("manifest_version", out var mv) && mv.ValueKind == JsonValueKind.Number && mv.TryGetInt32(out var i))
                m.ManifestVersion = i;
            return m;
        }

        private static string Str(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

        private static int Int(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
                && v.TryGetInt32(out var n) && n >= 0 ? n : 0;

        // ── 缓存：断网时用上次成功拿到的策略，而不是「什么都拿不到就放行」 ──

        private static void SaveCache(UpdateManifest m)
        {
            try
            {
                var dir = Path.GetDirectoryName(CachePath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(CachePath, SerializeCache(m));
            }
            catch { }
        }

        internal static string SerializeCache(UpdateManifest m)
        {
            var obj = new
            {
                latest = m.Latest,
                epoch = m.Epoch,
                brand_latest = m.BrandLatest,
                target = m.Target,
                released_at = m.ReleasedAt == default ? "" : m.ReleasedAt.ToString("o", CultureInfo.InvariantCulture),
                force_after_hours = m.ForceAfterHours,
                force = m.Force,
                force_from = m.ForceFrom,
                force_versions = m.ForceVersions,
                kill_below = m.KillBelow,
                message = m.Message,
                update_warning = m.UpdateWarning,
                update_warning_version = m.UpdateWarningVersion,
                release_notes = m.ReleaseNotes,
                release_details = m.ReleaseDetails,
                manifest_version = m.ManifestVersion,
                cached_at = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture),
            };
            return JsonSerializer.Serialize(obj, new JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull });
        }

        private static UpdateManifest LoadCache()
        {
            try
            {
                if (!File.Exists(CachePath)) return null;
                return Parse(File.ReadAllText(CachePath));
            }
            catch
            {
                return null;
            }
        }
    }
}
