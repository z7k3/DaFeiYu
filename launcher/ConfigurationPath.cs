using System;
using System.IO;
using System.Text.Json;

namespace WhaleLauncher;

internal static class ConfigurationPath
{
    internal static string Resolve(string root)
    {
        var current = Path.Combine(root, "data", "config.json");
        var legacy = Path.Combine(root, "config.json");
        return File.Exists(current) || !File.Exists(legacy) ? current : legacy;
    }

    internal static void Migrate(string root)
    {
        var current = Path.Combine(root, "data", "config.json");
        var legacy = Path.Combine(root, "config.json");
        if (File.Exists(current) || !File.Exists(legacy)) return;
        // 先校验、备份，再以不覆盖方式提交；旧配置永久保留，失败则继续读旧路径。
        var bytes = File.ReadAllBytes(legacy);
        using var document = JsonDocument.Parse(System.Text.Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF'));
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException("旧配置不是 JSON 对象");
        Directory.CreateDirectory(Path.GetDirectoryName(current));
        var backup = Path.Combine(root, "data", "config.legacy.backup.json");
        if (!File.Exists(backup)) File.Copy(legacy, backup, false);
        var temp = current + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllBytes(temp, bytes);
            if (!File.Exists(current)) File.Move(temp, current, false);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
