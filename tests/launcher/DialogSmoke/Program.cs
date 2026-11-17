using System;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using WhaleLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var root = new Grid();
        var background = new Button { Content = "背景" };
        root.Children.Add(background);
        var window = new Window { Content = root, Width = 800, Height = 600, ShowInTaskbar = false };
        app.MainWindow = window;
        window.Show();
        window.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(() =>
        {
            Require(!background.IsEnabled && background.Effect is BlurEffect, "弹层未锁定和模糊背景");
            var overlay = (Grid)root.Children[root.Children.Count - 1];
            var close = Find<Button>(overlay).First(x => Equals(x.Content, "×"));
            close.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        }));
        Require(!AppDialog.Confirm(window, "测试", "弹层"), "关闭标识应取消确认");
        Require(background.IsEnabled && background.Effect == null && root.Children.Count == 1, "关闭后未恢复背景");
        window.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(() =>
        {
            var outer = (Grid)root.Children[root.Children.Count - 1];
            window.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(() =>
            {
                Require(!outer.IsEnabled && outer.Effect is BlurEffect, "嵌套弹层未锁定上层");
                var inner = (Grid)root.Children[root.Children.Count - 1];
                Find<Button>(inner).First(x => Equals(x.Content, "×"))
                    .RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            }));
            Require(!AppDialog.Confirm(window, "内层", "嵌套"), "内层关闭应取消");
            Require(outer.IsEnabled && outer.Effect == null && !background.IsEnabled, "嵌套关闭后状态错误");
            Find<Button>(outer).First(x => Equals(x.Content, "×"))
                .RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        }));
        Require(!AppDialog.Confirm(window, "外层", "嵌套"), "外层关闭应取消");
        Require(background.IsEnabled && background.Effect == null && root.Children.Count == 1, "嵌套结束后未恢复背景");
        window.Close();
        app.Shutdown();
        Console.WriteLine("应用内弹层运行时检查通过");
    }

    private static System.Collections.Generic.IEnumerable<T> Find<T>(DependencyObject parent) where T : DependencyObject
    {
        for (var i = 0; i < System.Windows.Media.VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = System.Windows.Media.VisualTreeHelper.GetChild(parent, i);
            if (child is T match) yield return match;
            foreach (var descendant in Find<T>(child)) yield return descendant;
        }
    }

    private static void Require(bool value, string message)
    {
        if (!value) throw new InvalidOperationException(message);
    }
}
