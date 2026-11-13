using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

internal static class DesktopInput
{
    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);

    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;

    private static int Main(string[] args)
    {
        if (args.Length == 1 && string.Equals(args[0], "cursor", StringComparison.OrdinalIgnoreCase))
        {
            POINT point;
            if (!GetCursorPos(out point)) return 3;
            Console.Out.Write(point.X + "," + point.Y);
            return 0;
        }
        if (args.Length == 1 && string.Equals(args[0], "stream", StringComparison.OrdinalIgnoreCase))
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (string.Equals(line.Trim(), "stop", StringComparison.OrdinalIgnoreCase)) break;
                string[] parts = line.Split(',');
                int x;
                int y;
                if (parts.Length == 2 && int.TryParse(parts[0], out x) && int.TryParse(parts[1], out y)) SetCursorPos(x, y);
            }
            return 0;
        }
        if (args.Length == 3 && string.Equals(args[0], "click", StringComparison.OrdinalIgnoreCase))
        {
            int x;
            int y;
            if (!int.TryParse(args[1], out x) || !int.TryParse(args[2], out y)) return 2;
            if (!SetCursorPos(x, y)) return 3;
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
            return 0;
        }
        if (args.Length == 3 && string.Equals(args[0], "doubleclick", StringComparison.OrdinalIgnoreCase))
        {
            int x;
            int y;
            if (!int.TryParse(args[1], out x) || !int.TryParse(args[2], out y)) return 2;
            if (!SetCursorPos(x, y)) return 3;
            for (int i = 0; i < 2; i++)
            {
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                if (i == 0) Thread.Sleep(120);
            }
            return 0;
        }
        if (args.Length == 7 && string.Equals(args[0], "animate", StringComparison.OrdinalIgnoreCase))
        {
            int x1, y1, x2, y2, duration, delay;
            if (!int.TryParse(args[1], out x1) || !int.TryParse(args[2], out y1) ||
                !int.TryParse(args[3], out x2) || !int.TryParse(args[4], out y2) ||
                !int.TryParse(args[5], out duration) || !int.TryParse(args[6], out delay)) return 2;
            AnimateCursor(x1, y1, x2, y2, Math.Max(1, duration), Math.Max(0, delay));
            return 0;
        }
        Console.Error.WriteLine("usage: desktop-input.exe cursor | stream | click <x> <y> | doubleclick <x> <y> | animate <x1> <y1> <x2> <y2> <durationMs> <delayMs>");
        return 2;
    }

    private static void AnimateCursor(int x1, int y1, int x2, int y2, int duration, int delay)
    {
        Stopwatch watch = Stopwatch.StartNew();
        if (delay > 0) Thread.Sleep(delay);
        while (true)
        {
            double elapsed = watch.Elapsed.TotalMilliseconds - delay;
            double raw = Math.Max(0, Math.Min(1, elapsed / duration));
            double eased = raw * raw * (3 - 2 * raw);
            int x = (int)Math.Round(x1 + (x2 - x1) * eased);
            int y = (int)Math.Round(y1 + (y2 - y1) * eased);
            SetCursorPos(x, y);
            if (raw >= 1) break;
            Thread.Sleep(8);
        }
        SetCursorPos(x2, y2);
    }
}
