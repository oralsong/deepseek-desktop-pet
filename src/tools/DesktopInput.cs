using System;
using System.Runtime.InteropServices;

internal static class DesktopInput
{
    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;

    private static int Main(string[] args)
    {
        if (args.Length != 3 || !string.Equals(args[0], "click", StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine("usage: desktop-input.exe click <x> <y>");
            return 2;
        }
        int x;
        int y;
        if (!int.TryParse(args[1], out x) || !int.TryParse(args[2], out y)) return 2;
        if (!SetCursorPos(x, y)) return 3;
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        return 0;
    }
}
