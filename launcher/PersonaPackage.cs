using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text.Json;
using System.Text.Encodings.Web;
using System.Text.RegularExpressions;

namespace WhaleLauncher;

// 人设包只有纯数据。显式白名单防止分享账号、密钥、权限或执行配置。
internal static class PersonaPackage
{
    static readonly Dictionary<string, int> Strings = new()
    {
        ["personaName"] = 40, ["job"] = 80, ["appearance"] = 400,
        ["personality"] = 500, ["background"] = 500, ["customPrompt"] = 24000, ["ownerName"] = 24
    };
    static readonly Dictionary<string, (double Min, double Max)> Numbers = new()
    {
        ["age"] = (1,120), ["privateMaxChars"] = (40,800), ["groupMaxChars"] = (20,300),
        ["historyTurns"] = (4,400), ["groupHistoryTurns"] = (2,300), ["maxBubbles"] = (1,8),
        ["discussionMaxChars"] = (20,4000), ["emojiChance"] = (0,1)
    };

    internal static Dictionary<string, object> Read(JsonElement data)
    {
        if (data.ValueKind != JsonValueKind.Object) throw new InvalidDataException("人设必须是 JSON 对象");
        if (data.TryGetProperty("schemaVersion", out var declared)
            && (declared.ValueKind != JsonValueKind.Number || !declared.TryGetInt32(out var declaredVersion) || declaredVersion != 1))
            throw new InvalidDataException("不支持的人设数据版本");
        var result = new Dictionary<string, object>();
        foreach (var (key, max) in Strings)
        {
            if (!data.TryGetProperty(key, out var value)) continue;
            if (value.ValueKind != JsonValueKind.String || value.GetString().Length > max)
                throw new InvalidDataException("人设字段无效：" + key);
            result[key] = value.GetString().Trim();
        }
        foreach (var (key, range) in Numbers)
        {
            if (!data.TryGetProperty(key, out var value)) continue;
            if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var n)
                || !double.IsFinite(n) || n < range.Min || n > range.Max || (key != "emojiChance" && n != Math.Truncate(n)))
                throw new InvalidDataException("人设数值无效：" + key);
            result[key] = n;
        }
        foreach (var key in new[] { "masterRoast", "proactive", "opinions" })
        {
            if (!data.TryGetProperty(key, out var value)) continue;
            if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new InvalidDataException("人设开关无效：" + key);
            result[key] = value.GetBoolean();
        }
        if (data.TryGetProperty("emoji", out var emoji))
        {
            if (emoji.ValueKind != JsonValueKind.String || !new[] { "关", "少", "正常", "多" }.Contains(emoji.GetString()))
                throw new InvalidDataException("颜文字档位无效");
            result["emoji"] = emoji.GetString();
        }
        if (data.TryGetProperty("aliases", out var aliases))
        {
            if (aliases.ValueKind != JsonValueKind.Array || aliases.GetArrayLength() > 30
                || aliases.EnumerateArray().Any(v => v.ValueKind != JsonValueKind.String || v.GetString().Length > 40))
                throw new InvalidDataException("人设别名无效");
            result["aliases"] = aliases.EnumerateArray().Select(v => v.GetString().Trim()).Where(v => v.Length > 0).ToArray();
        }
        var modern = data.TryGetProperty("schemaVersion", out var schema) && schema.ValueKind == JsonValueKind.Number && schema.TryGetInt32(out var schemaVersion) && schemaVersion == 1;
        var hasPrompt = result.TryGetValue("customPrompt", out var prompt) && ((string)prompt).Length > 0;
        if (!hasPrompt)
        {
            if (!modern || (!result.ContainsKey("personality") && !result.ContainsKey("personaName")))
                throw new InvalidDataException("人设需要正文或基础身份与性格");
            result["customPrompt"] = "";
        }
        result["schemaVersion"] = 1;
        return result;
    }

    internal static void Export(string destination, JsonElement data, string title, string author, string id, string version, bool promptOnly = false)
    {
        if (!Regex.IsMatch(id ?? "", "^[a-z][a-z0-9-]{0,47}$")
            || !Regex.IsMatch(version ?? "", @"^\d+\.\d+\.\d+(\.\d+)?$") || !Version.TryParse(version, out _)
            || string.IsNullOrWhiteSpace(title) || title.Length > 80 || string.IsNullOrWhiteSpace(author) || author.Length > 80)
            throw new InvalidDataException("包 ID、名称、作者或版本无效");
        Dictionary<string, object> persona;
        if (promptOnly)
        {
            if (!data.TryGetProperty("customPrompt", out var value) || value.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(value.GetString()) || value.GetString().Trim().Length > 24000)
                throw new InvalidDataException("仅分享提示词需要非空的自定义提示词，最多 24000 字符");
            persona = new Dictionary<string, object> { ["customPrompt"] = value.GetString().Trim() };
        }
        else persona = Read(data);
        // 输出是独立 JSON 文件而非 HTML，直接 UTF-8 避免中文转义放大包体。
        var payload = JsonSerializer.SerializeToUtf8Bytes(persona, new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        if (payload.Length > (promptOnly ? 64 : 192) * 1024)
            throw new InvalidDataException(promptOnly ? "提示词文件超过市场 64 KiB 上限，请精简后再分享" : "人设文件超过 192 KiB");
        var legacyMin = promptOnly ? "4.1.0" : "4.1.5";
        // 同一纯数据格式可跨代分享，保留顶层旧版本范围给不认识新字段的客户端。
        var info = new PluginInfo(id, title.Trim(), author.Trim(), version, legacyMin,
            promptOnly ? "纯提示词人设" : "可编辑的人设与表达设置", null, 1, Kind: "persona",
            AppCompatibility: [new(1, legacyMin), new(2, "1.0.0")]);
        var temp = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var zip = ZipFile.Open(temp, ZipArchiveMode.Create))
            {
                using (var manifest = zip.CreateEntry("plugin.json").Open()) JsonSerializer.Serialize(manifest, info);
                using (var body = zip.CreateEntry("persona.json").Open()) body.Write(payload);
            }
            // 使用现有安装校验回读，不能导出一个自己都无法安装的包。
            _ = PluginMarket.ReadPackage(File.ReadAllBytes(temp));
            File.Move(temp, destination, true);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
