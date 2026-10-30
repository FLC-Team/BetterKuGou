param([int]$OwnerProcessId)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# This helper only reads one foreground HWND. It never reads titles, enumerates processes,
# activates windows, captures pixels or changes the user's display configuration.
Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class BKForegroundMonitor {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int Size; public RECT Monitor, Work; public uint Flags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int capacity);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

  public static string Sample(int ownerProcessId) {
    IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
    if (previousDpi == IntPtr.Zero) previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-3));
    if (previousDpi == IntPtr.Zero) throw new InvalidOperationException("Per-monitor DPI context unavailable");
    try {
      IntPtr hwnd = GetForegroundWindow();
      if (hwnd == IntPtr.Zero || hwnd == GetShellWindow() || hwnd == GetDesktopWindow() ||
          !IsWindowVisible(hwnd) || IsIconic(hwnd)) return "{\"fullscreen\":false}";
      uint processId;
      GetWindowThreadProcessId(hwnd, out processId);
      if (processId == ownerProcessId) return "{\"fullscreen\":false}";
      StringBuilder kind = new StringBuilder(64);
      GetClassName(hwnd, kind, kind.Capacity);
      string windowClass = kind.ToString();
      if (windowClass == "Progman" || windowClass == "WorkerW" || windowClass == "Shell_TrayWnd" ||
          windowClass == "Shell_SecondaryTrayWnd") return "{\"fullscreen\":false}";
      RECT rect;
      if (!GetClientRect(hwnd, out rect)) return "{\"fullscreen\":false}";
      POINT first = new POINT { X = rect.Left, Y = rect.Top };
      POINT last = new POINT { X = rect.Right, Y = rect.Bottom };
      if (!ClientToScreen(hwnd, ref first) || !ClientToScreen(hwnd, ref last)) return "{\"fullscreen\":false}";
      rect.Left = first.X; rect.Top = first.Y; rect.Right = last.X; rect.Bottom = last.Y;
      MONITORINFO info = new MONITORINFO();
      info.Size = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(MonitorFromWindow(hwnd, 2), ref info)) return "{\"fullscreen\":false}";
      RECT monitor = info.Monitor;
      bool full = rect.Left <= monitor.Left + 1 && rect.Top <= monitor.Top + 1 &&
        rect.Right >= monitor.Right - 1 && rect.Bottom >= monitor.Bottom - 1;
      if (!full) return "{\"fullscreen\":false}";
      return String.Format(CultureInfo.InvariantCulture,
        "{{\"fullscreen\":true,\"bounds\":{{\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3}}}}}",
        monitor.Left, monitor.Top, monitor.Right - monitor.Left, monitor.Bottom - monitor.Top);
    } finally {
      if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
    }
  }
}
'@

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while (($command = [Console]::ReadLine()) -ne $null) {
  if ($command -eq 'EXIT') { break }
  if ($command -eq 'SAMPLE') {
    [Console]::Out.WriteLine([BKForegroundMonitor]::Sample($OwnerProcessId))
    [Console]::Out.Flush()
  }
}
