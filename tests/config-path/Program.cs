using System;
using System.IO;
using WhaleLauncher;

var temp = Path.Combine(Environment.CurrentDirectory, "artifacts", "config-path");
var root = Path.Combine(temp, "whale-path-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    var legacy = Path.Combine(root, "config.json");
    var current = Path.Combine(root, "data", "config.json");
    File.WriteAllText(legacy, "{\"chat\":{\"maxBubbles\":5}}");
    ConfigurationPath.Migrate(root);
    if (File.ReadAllText(current) != File.ReadAllText(legacy)) throw new Exception("migration changed data");
    if (!File.Exists(Path.Combine(root, "data", "config.legacy.backup.json"))) throw new Exception("backup missing");
    File.WriteAllText(current, "{\"chat\":{\"maxBubbles\":7}}");
    ConfigurationPath.Migrate(root);
    if (!File.ReadAllText(current).Contains(":7")) throw new Exception("new config overwritten");
    if (ConfigurationPath.Resolve(root) != current) throw new Exception("wrong preferred path");
    File.Delete(current);
    File.WriteAllText(legacy, "{broken");
    try { ConfigurationPath.Migrate(root); throw new Exception("bad config accepted"); }
    catch (System.Text.Json.JsonException) { }
    if (File.Exists(current)) throw new Exception("bad config migrated");
    Console.WriteLine("PASS migration / backup / preserve / invalid JSON");
}
finally { Directory.Delete(root, true); }
