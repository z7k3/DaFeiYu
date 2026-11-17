using System;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace WhaleLauncher
{
    /// <summary>应用内文件选择，保留文件夹浏览、多个文件和覆盖确认。</summary>
    public static class AppFilePicker
    {
        public static string Open(string title, string extensions)
            => OpenMany(title, extensions, false)?.FirstOrDefault();

        public static string[] OpenMany(string title, string extensions, bool multiple)
            => Pick(title, extensions, false, multiple, null);

        public static string Save(string title, string extension, string initial)
            => Pick(title, extension, true, false, initial)?.FirstOrDefault();

        private static string[] Pick(string title, string extensions, bool save, bool multiple, string initial)
        {
            var allowed = extensions.Split(';', StringSplitOptions.RemoveEmptyEntries);
            var directory = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            if (!Directory.Exists(directory)) directory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var panel = new StackPanel();
            var path = new TextBox { Text = directory, Margin = new Thickness(0, 12, 0, 6) };
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 6) };
            var up = new Button { Content = "上一级", Padding = new Thickness(12, 4, 12, 4) };
            var navigate = new Button { Content = "打开路径", Padding = new Thickness(12, 4, 12, 4), Margin = new Thickness(8, 0, 0, 0) };
            row.Children.Add(up);
            row.Children.Add(navigate);
            var list = new ListBox { Height = 260, SelectionMode = multiple ? SelectionMode.Extended : SelectionMode.Single };
            var name = new TextBox { Text = initial ?? "", Margin = new Thickness(0, 8, 0, 0) };
            var status = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 6, 0, 0) };
            panel.Children.Add(path);
            panel.Children.Add(row);
            panel.Children.Add(list);
            panel.Children.Add(name);
            panel.Children.Add(status);
            void Load(string target)
            {
                try
                {
                    var full = Path.GetFullPath(target);
                    var dirs = Directory.GetDirectories(full).OrderBy(x => x, StringComparer.CurrentCultureIgnoreCase);
                    var files = Directory.GetFiles(full).Where(x => allowed.Length == 0 || allowed.Contains(Path.GetExtension(x), StringComparer.OrdinalIgnoreCase))
                        .OrderBy(x => x, StringComparer.CurrentCultureIgnoreCase);
                    list.Items.Clear();
                    foreach (var item in dirs.Concat(files))
                        list.Items.Add(new ListBoxItem { Content = (Directory.Exists(item) ? "📁 " : "📄 ") + Path.GetFileName(item), Tag = item });
                    directory = full;
                    path.Text = full;
                    if (!save) name.Clear();
                    status.Text = multiple ? "可按 Ctrl 或 Shift 多选，双击打开文件夹。" : "双击打开文件夹，选择文件后点击确定。";
                }
                catch (Exception ex) { status.Text = "无法打开文件夹：" + ex.Message; }
            }
            up.Click += (_, _) => { var parent = Directory.GetParent(directory); if (parent != null) Load(parent.FullName); };
            navigate.Click += (_, _) => Load(path.Text);
            path.PreviewKeyDown += (_, e) =>
            {
                if (e.Key != Key.Enter) return;
                Load(path.Text);
                e.Handled = true;
            };
            list.SelectionChanged += (_, _) =>
            {
                if (list.SelectedItem is ListBoxItem item && item.Tag is string selected && File.Exists(selected))
                    name.Text = Path.GetFileName(selected);
            };
            list.MouseDoubleClick += (_, _) =>
            {
                if (list.SelectedItem is ListBoxItem item && item.Tag is string selected && Directory.Exists(selected)) Load(selected);
            };
            Load(directory);
            while (AppDialog.ShowContent(title, panel, 640, save ? "保存" : "确定", "取消"))
            {
                try
                {
                    if (!save && multiple)
                    {
                        var selected = list.SelectedItems.Cast<ListBoxItem>().Select(x => (string)x.Tag).Where(File.Exists).ToArray();
                        if (selected.Length > 0) return selected;
                    }
                    if (string.IsNullOrWhiteSpace(name.Text)) { status.Text = "请输入或选择文件名。"; continue; }
                    var file = Path.GetFullPath(Path.Combine(directory, name.Text.Trim()));
                    if (save && string.IsNullOrEmpty(Path.GetExtension(file)) && allowed.Length == 1) file += allowed[0];
                    if (Directory.Exists(file)) { status.Text = "请选择文件，不是文件夹。"; continue; }
                    if (allowed.Length > 0 && !allowed.Contains(Path.GetExtension(file), StringComparer.OrdinalIgnoreCase)) { status.Text = "文件类型不受支持：" + string.Join("、", allowed); continue; }
                    if (save && !Directory.Exists(Path.GetDirectoryName(file))) { status.Text = "保存目录不存在。"; continue; }
                    if (!save && !File.Exists(file)) { status.Text = "请选择存在的文件。"; continue; }
                    if (save && File.Exists(file) && !AppDialog.Confirm(null, "文件已存在，是否覆盖？\n" + file, "确认覆盖", true)) continue;
                    return new[] { file };
                }
                catch (Exception ex) { status.Text = "文件路径无效：" + ex.Message; }
            }
            return null;
        }
    }
}
